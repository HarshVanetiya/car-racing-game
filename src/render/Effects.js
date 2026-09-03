import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../math/MathUtils.js';
import { SurfaceType, isLooseSurface } from '../physics/Surfaces.js';

/**
 * ============================================================================
 *  VISUAL EFFECTS
 * ============================================================================
 *
 * Everything here is driven by a physical quantity, not by a trigger:
 *
 *   - skid marks appear where a tire's slip actually exceeds its limit
 *   - tire smoke density follows the friction power being dissipated
 *   - spray follows the depth of water actually being displaced
 *   - sparks come from the floor bottoming out on its bump stops
 *
 * The result is that the picture tells the driver the same story the physics
 * is telling them through the car.
 */

const MAX_SKID_SEGMENTS = 2400;
const MAX_PARTICLES = 900;

/** Persistent rubber laid down where cars slide. */
export class SkidMarks {
  constructor(scene) {
    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_SKID_SEGMENTS * 6 * 3);
    this.alphas = new Float32Array(MAX_SKID_SEGMENTS * 6);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(0.04, 0.04, 0.05, vAlpha * 0.72);
        }`
    });

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);

    this.cursor = 0;
    this.count = 0;
    this._last = new Map();   // key -> last contact point
  }

  /**
   * @param {string} key    unique per car+wheel
   * @param {Vec3} point    contact point
   * @param {Vec3} right    lateral direction of the wheel
   * @param {number} width  tire width
   * @param {number} intensity 0..1
   */
  add(key, point, right, width, intensity) {
    if (intensity <= 0.02) { this._last.delete(key); return; }
    const prev = this._last.get(key);
    const p = { x: point.x, y: point.y + 0.012, z: point.z,
                rx: right.x, rz: right.z };
    if (!prev) { this._last.set(key, p); return; }

    const dx = p.x - prev.x, dz = p.z - prev.z;
    const moved = Math.hypot(dx, dz);
    // One quad per ~0.4 m of travel keeps the geometry budget sane.
    if (moved < 0.4) return;
    if (moved > 12) { this._last.set(key, p); return; }  // teleport / respawn

    const hw = width * 0.5;
    const i = this.cursor * 18;
    const a0x = prev.x - prev.rx * hw, a0z = prev.z - prev.rz * hw;
    const a1x = prev.x + prev.rx * hw, a1z = prev.z + prev.rz * hw;
    const b0x = p.x - p.rx * hw, b0z = p.z - p.rz * hw;
    const b1x = p.x + p.rx * hw, b1z = p.z + p.rz * hw;

    const verts = [
      a0x, prev.y, a0z, a1x, prev.y, a1z, b0x, p.y, b0z,
      a1x, prev.y, a1z, b1x, p.y, b1z, b0x, p.y, b0z
    ];
    this.positions.set(verts, i);
    const a = clamp01(intensity);
    for (let k = 0; k < 6; k++) this.alphas[this.cursor * 6 + k] = a;

    this.cursor = (this.cursor + 1) % MAX_SKID_SEGMENTS;
    this.count = Math.min(this.count + 1, MAX_SKID_SEGMENTS);
    this.geometry.setDrawRange(0, this.count * 6);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this._last.set(key, p);
  }

  clear() {
    this.cursor = 0; this.count = 0;
    this._last.clear();
    this.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * A single points-based particle system covering smoke, dust, spray and sparks.
 * One draw call for all of them.
 */
export class ParticleSystem {
  constructor(scene) {
    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colours = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.alphas = new Float32Array(MAX_PARTICLES);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colours, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (320.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d);
          if (r > 0.5) discard;
          float soft = smoothstep(0.5, 0.06, r);
          gl_FragColor = vec4(vColor, vAlpha * soft);
        }`
    });

    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);

    this.particles = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        alive: false, x: 0, y: -9999, z: 0,
        vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1,
        size: 1, r: 1, g: 1, b: 1, drag: 1, rise: 0
      });
    }
    this.cursor = 0;
  }

  spawn(x, y, z, vx, vy, vz, opts) {
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    p.alive = true;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = 0;
    p.maxLife = opts.life ?? 1;
    p.size = opts.size ?? 2;
    p.growth = opts.growth ?? 1;
    p.r = opts.r; p.g = opts.g; p.b = opts.b;
    p.alpha = opts.alpha ?? 0.5;
    p.drag = opts.drag ?? 2.0;
    p.rise = opts.rise ?? 0.6;
    p.gravity = opts.gravity ?? 0;
  }

  /** Tire smoke: white-grey, rises, expands, from friction power. */
  emitSmoke(x, y, z, vx, vz, intensity) {
    const n = Math.min(3, Math.ceil(intensity * 3));
    for (let i = 0; i < n; i++) {
      const jx = (Math.random() - 0.5) * 0.6;
      const jz = (Math.random() - 0.5) * 0.6;
      this.spawn(x + jx, y + 0.12, z + jz,
        vx * 0.16 + (Math.random() - 0.5) * 1.4,
        0.6 + Math.random() * 1.1,
        vz * 0.16 + (Math.random() - 0.5) * 1.4,
        { life: 0.9 + Math.random() * 0.9, size: 1.6, growth: 3.4,
          r: 0.80, g: 0.80, b: 0.82, alpha: 0.16 * intensity, drag: 1.6, rise: 0.5 });
    }
  }

  /** Dust and stones thrown up on gravel or grass. */
  emitDust(x, y, z, vx, vz, intensity, surface) {
    const n = Math.min(4, Math.ceil(intensity * 4));
    const brown = surface === SurfaceType.GRASS;
    for (let i = 0; i < n; i++) {
      this.spawn(x, y + 0.08, z,
        -vx * 0.28 + (Math.random() - 0.5) * 3,
        1.2 + Math.random() * 2.4,
        -vz * 0.28 + (Math.random() - 0.5) * 3,
        { life: 0.7 + Math.random() * 0.8, size: 1.3, growth: 2.2,
          r: brown ? 0.34 : 0.70, g: brown ? 0.42 : 0.62, b: brown ? 0.22 : 0.44,
          alpha: 0.30 * intensity, drag: 2.2, gravity: -4.5 });
    }
  }

  /** Spray from standing water — the plume that makes following hard. */
  emitSpray(x, y, z, vx, vz, intensity) {
    const n = Math.min(4, Math.ceil(intensity * 4));
    for (let i = 0; i < n; i++) {
      this.spawn(x + (Math.random() - 0.5) * 1.2, y + 0.15, z + (Math.random() - 0.5) * 1.2,
        -vx * 0.34 + (Math.random() - 0.5) * 2,
        1.0 + Math.random() * 2.6,
        -vz * 0.34 + (Math.random() - 0.5) * 2,
        { life: 0.8 + Math.random() * 0.7, size: 2.4, growth: 4.5,
          r: 0.86, g: 0.90, b: 0.94, alpha: 0.13 * intensity, drag: 1.3, rise: 0.4 });
    }
  }

  /** Sparks from the floor grounding out. */
  emitSparks(x, y, z, vx, vz, intensity) {
    const n = Math.min(6, Math.ceil(intensity * 6));
    for (let i = 0; i < n; i++) {
      this.spawn(x, y + 0.04, z,
        -vx * 0.55 + (Math.random() - 0.5) * 6,
        1.5 + Math.random() * 3.5,
        -vz * 0.55 + (Math.random() - 0.5) * 6,
        { life: 0.28 + Math.random() * 0.3, size: 0.7, growth: 0.6,
          r: 1.0, g: 0.72 + Math.random() * 0.25, b: 0.18,
          alpha: 0.95, drag: 1.0, gravity: -11 });
    }
  }

  /** Debris from a heavy impact. */
  emitDebris(x, y, z, intensity) {
    const n = Math.min(10, Math.ceil(intensity * 10));
    for (let i = 0; i < n; i++) {
      this.spawn(x, y + 0.3, z,
        (Math.random() - 0.5) * 12, 2 + Math.random() * 6, (Math.random() - 0.5) * 12,
        { life: 0.8 + Math.random(), size: 1.0, growth: 0.9,
          r: 0.2, g: 0.2, b: 0.22, alpha: 0.85, drag: 0.9, gravity: -9.8 });
    }
  }

  update(dt) {
    const pos = this.positions, col = this.colours, siz = this.sizes, alp = this.alphas;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.alive) { alp[i] = 0; siz[i] = 0; continue; }
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false; alp[i] = 0; siz[i] = 0;
        pos[i * 3 + 1] = -9999;
        continue;
      }
      const decay = Math.exp(-p.drag * dt);
      p.vx *= decay; p.vz *= decay;
      p.vy = p.vy * decay + (p.gravity + p.rise * 2.2) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      const t = p.life / p.maxLife;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      col[i * 3] = p.r; col[i * 3 + 1] = p.g; col[i * 3 + 2] = p.b;
      siz[i] = p.size * lerp(1, p.growth, t);
      alp[i] = p.alpha * (1 - t * t);
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  clear() {
    for (const p of this.particles) { p.alive = false; p.y = -9999; }
  }

  dispose() {
    this.geometry.dispose();
    this.points.material.dispose();
  }
}

/**
 * Ties the effect emitters to the simulation state of one car.
 *
 * Note what triggers what: smoke comes from the tire's own friction power,
 * spray from the water depth the wheel is actually in, sparks from the
 * suspension reaching its bump stop. Nothing here is keyed to "the player
 * pressed a button".
 */
export class CarEffects {
  constructor(skids, particles) {
    this.skids = skids;
    this.particles = particles;
  }

  /**
   * @param {string} id car id
   * @param {Array} wheels [{ contactPoint, rightDir, width, slip, frictionPower,
   *                          surfaceType, onGround, waterDepth, speed }]
   * @param {object} body { velocity, rideHeight, bottomedOut, position }
   */
  update(dt, id, wheels, body) {
    const v = body.velocity;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      if (!w.onGround) { this.skids.add(`${id}-${i}`, w.contactPoint, w.rightDir, w.width, 0); continue; }

      const sliding = clamp01((w.slip - 1.0) / 1.2);
      const onTarmac = w.surfaceType === SurfaceType.ASPHALT ||
                       w.surfaceType === SurfaceType.KERB ||
                       w.surfaceType === SurfaceType.RUNOFF ||
                       w.surfaceType === SurfaceType.PIT_LANE;

      // --- Skid marks -------------------------------------------------------
      // Only on tarmac, and only once the tire is genuinely past its limit.
      this.skids.add(
        `${id}-${i}`, w.contactPoint, w.rightDir, w.width,
        onTarmac && w.waterDepth < 0.001 ? sliding : 0
      );

      // --- Smoke ------------------------------------------------------------
      // Driven by friction power, so a locked wheel at speed smokes far more
      // than a gentle slide.
      if (onTarmac && w.frictionPower > 24000 && w.waterDepth < 0.0015) {
        const intensity = clamp01((w.frictionPower - 24000) / 90000);
        if (intensity > 0.04 && Math.random() < intensity * 1.4) {
          this.particles.emitSmoke(
            w.contactPoint.x, w.contactPoint.y, w.contactPoint.z, v.x, v.z, intensity
          );
        }
      }

      // --- Dust -------------------------------------------------------------
      if (isLooseSurface(w.surfaceType) && w.speed > 6) {
        const intensity = clamp01(w.speed / 40);
        if (Math.random() < intensity) {
          this.particles.emitDust(
            w.contactPoint.x, w.contactPoint.y, w.contactPoint.z,
            v.x, v.z, intensity, w.surfaceType
          );
        }
      }

      // --- Spray ------------------------------------------------------------
      if (w.waterDepth > 0.0008 && w.speed > 8) {
        const intensity = clamp01(w.waterDepth / 0.005) * clamp01(w.speed / 55);
        if (Math.random() < intensity * 1.6) {
          this.particles.emitSpray(
            w.contactPoint.x, w.contactPoint.y, w.contactPoint.z, v.x, v.z, intensity
          );
        }
      }
    }

    // --- Sparks -------------------------------------------------------------
    if (body.bottomedOut > 0.02 && body.speed > 25) {
      const intensity = clamp01(body.bottomedOut / 0.03);
      if (Math.random() < intensity * 0.8) {
        this.particles.emitSparks(
          body.position.x, body.position.y - 0.28, body.position.z,
          v.x, v.z, intensity
        );
      }
    }
  }
}
