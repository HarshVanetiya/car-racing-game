import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, smoothstep } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  CAMERAS
 * ============================================================================
 *
 * Six views, all driven by the car's actual motion.
 *
 * The guiding rule is that the camera should convey what the car is doing
 * without making the player ill. Speed, g-force and kerb strikes all move the
 * camera, but every one of those responses is damped and clamped: the driver
 * needs to be able to read the corner, and a camera that lurches is worse than
 * one that under-reacts.
 */

export const CameraMode = {
  CHASE: 'chase',
  COCKPIT: 'cockpit',
  DRIVER: 'driver',
  NOSE: 'nose',
  REAR: 'rear',
  TV: 'tv'
};

export const CAMERA_ORDER = [
  CameraMode.CHASE, CameraMode.COCKPIT, CameraMode.DRIVER,
  CameraMode.NOSE, CameraMode.REAR, CameraMode.TV
];

export const CAMERA_LABELS = {
  [CameraMode.CHASE]: 'Chase',
  [CameraMode.COCKPIT]: 'Cockpit',
  [CameraMode.DRIVER]: 'Driver',
  [CameraMode.NOSE]: 'Nose',
  [CameraMode.REAR]: 'Rear',
  [CameraMode.TV]: 'TV'
};

export class CameraRig {
  constructor(camera, track) {
    this.camera = camera;
    this.track = track;
    this.mode = CameraMode.CHASE;

    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);

    // Smoothed state
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._shake = 0;
    this._roll = 0;
    this._fov = 68;
    this._initialised = false;

    // TV camera state: which trackside position is currently covering the car.
    this._tvIndex = -1;
    this._tvPositions = this._buildTvPositions();
    this._tvSwitchCooldown = 0;

    this.settings = {
      shakeIntensity: 1.0,
      fovSpeedEffect: 1.0,
      lookAhead: 1.0,
      smoothing: 1.0
    };
  }

  /** Trackside camera positions, spaced around the circuit. */
  _buildTvPositions() {
    const t = this.track;
    const positions = [];
    const count = 16;
    for (let k = 0; k < count; k++) {
      const d = (k / count) * t.length;
      const i = Math.floor(d / t.sampleSpacing) % t.sampleCount;
      // Place the camera outside the barrier on the outside of the corner.
      const side = t.curvature[i] > 0 ? -1 : 1;
      const off = (side > 0 ? t.barrierOffsetR[i] : t.barrierOffsetL[i]) + 12;
      const p = t.pointAt(d, side * off);
      positions.push({
        distance: d,
        position: new THREE.Vector3(p.x, p.y + 6.5, p.z)
      });
    }
    return positions;
  }

  setMode(mode) {
    if (!CAMERA_ORDER.includes(mode)) return;
    this.mode = mode;
    this._initialised = false;
  }

  cycle(dir = 1) {
    const i = CAMERA_ORDER.indexOf(this.mode);
    const next = (i + dir + CAMERA_ORDER.length) % CAMERA_ORDER.length;
    this.setMode(CAMERA_ORDER[next]);
    return this.mode;
  }

  /**
   * @param {object} view {
   *   position, quaternion, velocity, speed, lateralG, longitudinalG,
   *   verticalG, kerbLoad, collision, distance
   * }
   */
  update(dt, view) {
    if (!view) return;
    const car = view.position;
    const q = view.quaternion;

    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);

    const speed = view.speed || 0;
    const speedT = clamp01(speed / 90);

    let desiredPos = new THREE.Vector3();
    let desiredLook = new THREE.Vector3();
    let desiredFov = 68;
    let posRate = 9;
    let lookRate = 9;
    let useCarUp = false;

    switch (this.mode) {
      case CameraMode.CHASE: {
        // Distance and height open up with speed so the car stays readable.
        const back = lerp(6.4, 8.6, speedT);
        const height = lerp(2.3, 2.9, speedT);
        desiredPos.copy(car)
          .addScaledVector(forward, -back)
          .addScaledVector(up, height);
        // Look ahead of the car, further the faster it is going.
        desiredLook.copy(car)
          .addScaledVector(forward, lerp(6, 22, speedT) * this.settings.lookAhead)
          .addScaledVector(up, 0.6);
        desiredFov = lerp(66, 84, speedT * this.settings.fovSpeedEffect);
        // Deliberately loose, so the car moves within the frame under load.
        posRate = 7.5;
        lookRate = 6.0;
        break;
      }

      case CameraMode.COCKPIT: {
        desiredPos.copy(car)
          .addScaledVector(forward, 0.30)
          .addScaledVector(up, 0.62);
        desiredLook.copy(desiredPos).addScaledVector(forward, 30).addScaledVector(up, -0.6);
        desiredFov = lerp(72, 88, speedT * this.settings.fovSpeedEffect);
        // Rigidly attached — this view lives or dies on being locked to the car.
        posRate = 40;
        lookRate = 26;
        useCarUp = true;
        break;
      }

      case CameraMode.DRIVER: {
        // Helmet view: sits lower and slightly further back than the cockpit
        // camera, with the halo in frame.
        desiredPos.copy(car)
          .addScaledVector(forward, 0.38)
          .addScaledVector(up, 0.50);
        desiredLook.copy(desiredPos).addScaledVector(forward, 30).addScaledVector(up, -0.3);
        // The driver looks INTO the corner rather than straight ahead.
        const lookInto = clamp(view.steerAngle || 0, -0.36, 0.36) * 26;
        desiredLook.addScaledVector(right, lookInto);
        desiredFov = lerp(78, 94, speedT * this.settings.fovSpeedEffect);
        posRate = 40;
        lookRate = 14;
        useCarUp = true;
        break;
      }

      case CameraMode.NOSE: {
        desiredPos.copy(car)
          .addScaledVector(forward, 2.1)
          .addScaledVector(up, 0.22);
        desiredLook.copy(desiredPos).addScaledVector(forward, 30);
        desiredFov = lerp(74, 92, speedT * this.settings.fovSpeedEffect);
        posRate = 40;
        lookRate = 26;
        useCarUp = true;
        break;
      }

      case CameraMode.REAR: {
        desiredPos.copy(car)
          .addScaledVector(forward, -2.6)
          .addScaledVector(up, 0.85);
        desiredLook.copy(desiredPos).addScaledVector(forward, -30);
        desiredFov = 72;
        posRate = 40;
        lookRate = 26;
        useCarUp = true;
        break;
      }

      case CameraMode.TV: {
        // Pick the trackside position the car is approaching, and hold it
        // until the car has gone past — a broadcast cut, not a follow.
        this._tvSwitchCooldown -= dt;
        const d = view.distance ?? 0;
        let best = this._tvIndex;
        let bestScore = -Infinity;
        for (let k = 0; k < this._tvPositions.length; k++) {
          const cam = this._tvPositions[k];
          const dist = cam.position.distanceTo(car);
          // Prefer a camera 40-140 m away that the car is coming toward.
          const toCar = new THREE.Vector3().subVectors(car, cam.position).normalize();
          const approaching = -toCar.dot(forward);
          const score = -Math.abs(dist - 80) * 0.02 + approaching * 2;
          if (score > bestScore) { bestScore = score; best = k; }
        }
        if (best !== this._tvIndex && this._tvSwitchCooldown <= 0) {
          this._tvIndex = best;
          this._tvSwitchCooldown = 2.2;
          this._initialised = false;
        }
        const cam = this._tvPositions[Math.max(0, this._tvIndex)];
        desiredPos.copy(cam.position);
        desiredLook.copy(car);
        // Zoom in on a distant car, as a broadcast camera would.
        const dist = cam.position.distanceTo(car);
        desiredFov = clamp(lerp(50, 16, clamp01((dist - 30) / 180)), 14, 55);
        posRate = 100;   // the camera itself does not move
        lookRate = 8;
        break;
      }
    }

    // --- G-force response ---------------------------------------------------
    // Longitudinal g pushes the camera back under acceleration and forward
    // under braking; lateral g swings it slightly outward. Both are small.
    const gShift = this.settings.shakeIntensity;
    if (this.mode === CameraMode.CHASE) {
      desiredPos.addScaledVector(forward, clamp(-(view.longitudinalG || 0) * 0.28, -0.9, 0.9) * gShift);
      desiredPos.addScaledVector(right, clamp((view.lateralG || 0) * 0.22, -0.8, 0.8) * gShift);
    } else if (useCarUp) {
      desiredPos.addScaledVector(forward, clamp(-(view.longitudinalG || 0) * 0.045, -0.14, 0.14) * gShift);
      desiredPos.addScaledVector(right, clamp((view.lateralG || 0) * 0.030, -0.10, 0.10) * gShift);
    }

    // --- Impact and kerb shake ---------------------------------------------
    const kerb = clamp01(view.kerbLoad || 0);
    const impact = clamp01((view.collisionEnergy || 0) / 40000);
    this._shake = Math.max(this._shake * Math.exp(-dt * 6), kerb * 0.35 + impact);
    if (this._shake > 0.002) {
      const amp = this._shake * 0.06 * gShift * (useCarUp ? 1.0 : 0.5);
      const tphase = performance.now?.() ?? Date.now();
      desiredPos.x += Math.sin(tphase * 0.061) * amp;
      desiredPos.y += Math.sin(tphase * 0.089) * amp;
      desiredPos.z += Math.sin(tphase * 0.047) * amp;
    }

    // --- Apply --------------------------------------------------------------
    if (!this._initialised) {
      this._pos.copy(desiredPos);
      this._look.copy(desiredLook);
      this._initialised = true;
    } else {
      const sm = this.settings.smoothing;
      const pr = posRate * sm;
      const lr = lookRate * sm;
      this._pos.set(
        damp(this._pos.x, desiredPos.x, pr, dt),
        damp(this._pos.y, desiredPos.y, pr, dt),
        damp(this._pos.z, desiredPos.z, pr, dt)
      );
      this._look.set(
        damp(this._look.x, desiredLook.x, lr, dt),
        damp(this._look.y, desiredLook.y, lr, dt),
        damp(this._look.z, desiredLook.z, lr, dt)
      );
    }

    this.camera.position.copy(this._pos);
    // In the cockpit views the horizon should tilt with the car; in chase and
    // TV it should not, or the whole world appears to roll.
    if (useCarUp) {
      this.up.copy(up);
    } else {
      // A hint of roll into the corner, well short of tilting the horizon.
      this._roll = damp(this._roll, clamp(-(view.lateralG || 0) * 0.018, -0.05, 0.05), 6, dt);
      this.up.set(Math.sin(this._roll), Math.cos(this._roll), 0)
        .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0), Math.atan2(forward.x, forward.z)
        ));
    }
    this.camera.up.copy(this.up);
    this.camera.lookAt(this._look);

    this._fov = damp(this._fov, desiredFov, 5, dt);
    if (Math.abs(this.camera.fov - this._fov) > 0.01) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Register a collision so the camera reacts to it. */
  addImpact(energy) {
    this._shake = Math.min(1.4, this._shake + clamp01(energy / 40000));
  }

  /** Spectator helper: frame a specific point from the nearest TV camera. */
  spectate(dt, position) {
    this.update(dt, {
      position,
      quaternion: new THREE.Quaternion(),
      speed: 0, distance: 0
    });
  }
}
