import { Vec3, tmpVec } from '../math/Vec3.js';
import { clamp, clamp01, lerp, sign } from '../math/MathUtils.js';
import { Tire } from './Tire.js';
import { SurfaceType, getSurface, surfaceHeightOffset } from './Surfaces.js';

/**
 * Angular frequency of the wheel-hop mode (rad/s). Ground inputs faster than
 * this are absorbed by tire deflection rather than moving the wheel.
 */
const WHEEL_HOP_OMEGA = 2 * Math.PI * 16;

/**
 * ============================================================================
 *  WHEEL: suspension + rotational dynamics + slip
 * ============================================================================
 *
 * Each corner is independent. The suspension decides how much vertical load
 * the tire has; the wheel's own rotational dynamics decide how much it is
 * slipping; the tire turns those two into a force; and that force is applied
 * back to the chassis at the contact patch, which is what transfers load to the
 * next corner. Nothing in this chain is shortcut.
 */
export class Wheel {
  /**
   * @param {object} cfg
   * @param {Vec3}   cfg.position      hardpoint in body space (top of travel)
   * @param {boolean} cfg.steered      does this wheel take steering input
   * @param {boolean} cfg.driven       is it connected to the differential
   * @param {boolean} cfg.front        front axle flag (brake balance, aero)
   * @param {number} cfg.side          -1 left, +1 right
   */
  constructor(cfg) {
    this.name = cfg.name || 'wheel';
    this.position = new Vec3().copy(cfg.position);
    this.steered = !!cfg.steered;
    this.driven = !!cfg.driven;
    this.front = !!cfg.front;
    this.side = cfg.side ?? -1;
    this.index = cfg.index ?? 0;

    this.radius = cfg.radius ?? 0.36;
    this.width = cfg.width ?? 0.305;
    // Rotational inertia of wheel + tire + upright (kg m^2).
    this.wheelInertia = cfg.wheelInertia ?? 1.3;
    // Driveline inertia reflected onto this wheel through the current gear.
    // The engine's own inertia, multiplied by the square of the gear ratio,
    // dominates the driveline in the lower gears — in first it is roughly
    // twenty times the wheel's own inertia. Leaving it out makes the driven
    // wheels far too light and the whole drivetrain rings.
    this.extraInertia = 0;

    // --- Suspension ---------------------------------------------------------
    this.restLength = cfg.restLength ?? 0.18;
    this.maxCompression = cfg.maxCompression ?? 0.055;  // travel to the bump stop
    this.maxExtension = cfg.maxExtension ?? 0.070;      // travel to the droop stop
    this.springRate = cfg.springRate ?? 165000;         // N/m
    this.bumpDamping = cfg.bumpDamping ?? 6200;         // Ns/m compressing
    this.reboundDamping = cfg.reboundDamping ?? 9800;   // Ns/m extending
    this.bumpStopRate = cfg.bumpStopRate ?? 900000;
    // Force the spring carries at rest — set by the vehicle from corner weight.
    this.preloadForce = cfg.preloadForce ?? 2000;
    this.staticCamber = cfg.staticCamber ?? (this.front ? -0.055 : -0.035); // rad
    this.toe = cfg.toe ?? (this.front ? 0.0018 : 0.0026) * -this.side;      // rad

    this.tire = new Tire({
      compound: cfg.compound,
      radius: this.radius,
      width: this.width,
      inertia: this.wheelInertia,
      ambient: cfg.ambient,
      trackTemp: cfg.trackTemp
    });

    // --- State --------------------------------------------------------------
    this.suspensionLength = this.restLength;
    this.prevSuspensionLength = this.restLength;
    this.compression = 0;         // metres compressed from rest (+ = compressed)
    this.compressionVel = 0;
    this.load = 0;                // vertical load on the tire (N)
    this.staticLoad = 0;
    this.onGround = false;
    this.contactPoint = new Vec3();
    this.contactNormal = new Vec3(0, 1, 0);
    this.surfaceType = SurfaceType.ASPHALT;

    this.steerAngle = 0;
    this.angularVelocity = 0;     // wheel spin (rad/s), + = forward
    this.spinAngle = 0;           // visual rotation
    this.driveTorque = 0;
    this.brakeTorque = 0;
    this.appliedBrakeTorque = 0;
    this.brakePower = 0;

    // Transient (relaxed) slip state. Contact patch deflection does not appear
    // instantly, and modelling that lag is what keeps the solve stable at low
    // speed instead of exploding into oscillation.
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.relaxationLong = cfg.relaxationLong ?? 0.32;   // metres
    this.relaxationLat = cfg.relaxationLat ?? 0.52;     // metres

    // Cached per-step frame
    this.forwardDir = new Vec3(0, 0, 1);
    this.rightDir = new Vec3(1, 0, 0);
    this.contactVelocity = new Vec3();
    this.forceLong = 0;
    this.forceLat = 0;
    this.worldForce = new Vec3();
    this.contactOffset = new Vec3();

    // Reporting
    this.longSlipVelocity = 0;
    this.latSlipVelocity = 0;
    this.kerbImpact = 0;
    this.suspensionForce = 0;
    /** Vertical input absorbed by the tire this step, for feel and audio. */
    this.surfaceHarshness = 0;
    this._groundY = null;
    this.antiRollForce = 0;
  }

  setCompound(key) {
    this.tire.setCompound(key);
  }

  /**
   * Position the spring so the car sits at its designed ride height under a
   * given static corner load.
   */
  setStaticLoad(load) {
    this.staticLoad = load;
    this.preloadForce = load;
  }

  /**
   * Resolve suspension geometry against the ground and compute vertical load.
   *
   * @param {RigidBody} body
   * @param {object} ground  { height, normal, surfaceType, distanceAlong, lateral }
   */
  updateSuspension(body, ground, dt) {
    const hardpoint = body.localToWorldPoint(this.position, tmpVec());
    const up = body.up;

    // --- Wheel-hop / tire enveloping filter --------------------------------
    //
    // A raycast wheel follows the ground exactly, which is wrong at speed. A
    // real wheel and tire form a mass-spring system with a hop frequency around
    // 15-20 Hz, and it simply cannot follow ground inputs faster than that —
    // the tire carcass deflects instead of the wheel rising.
    //
    // Without this, kerb ribs launch the car: 40 mm ribs at 0.9 m spacing
    // become an 50 Hz, 40 mm vertical input at racing speed, which no rigid
    // follower survives. With it, kerbs shake and unsettle the car — which is
    // what they are supposed to do — without throwing it into the air.
    const rawGroundY = ground.point.y;
    if (this._groundY == null || Math.abs(rawGroundY - this._groundY) > 1.5) {
      // First sample, or the car has been moved: snap rather than sweep.
      this._groundY = rawGroundY;
    } else {
      const a = 1 - Math.exp(-WHEEL_HOP_OMEGA * dt);
      this._groundY += (rawGroundY - this._groundY) * a;
    }
    // What the tire absorbed rather than passed on — the harshness the driver
    // feels through the car and hears through the tires.
    this.surfaceHarshness = Math.abs(rawGroundY - this._groundY);

    // Signed height of the hardpoint above the local ground plane.
    const toGround = tmpVec().set(
      hardpoint.x - ground.point.x,
      hardpoint.y - this._groundY,
      hardpoint.z - ground.point.z
    );
    const h = toGround.dot(ground.normal);
    // Alignment between the strut axis and the ground normal.
    const cosA = Math.max(0.25, up.dot(ground.normal));

    // Suspension length that would put the wheel exactly on the surface.
    const contactLength = (h - this.radius) / cosA;

    const minLen = this.restLength - this.maxCompression;
    const maxLen = this.restLength + this.maxExtension;

    this.prevSuspensionLength = this.suspensionLength;

    if (contactLength >= maxLen) {
      // Wheel is off the ground: the spring pushes it to full droop.
      this.suspensionLength = maxLen;
      this.compression = this.restLength - maxLen;
      this.compressionVel = (this.suspensionLength - this.prevSuspensionLength) / Math.max(dt, 1e-6) * -1;
      this.onGround = false;
      this.load = 0;
      this.suspensionForce = 0;
      this.contactPoint.copy(hardpoint).addScaled(up, -(this.suspensionLength + this.radius));
      this.contactNormal.copy(ground.normal);
      this.surfaceType = ground.surfaceType;
      return 0;
    }

    this.suspensionLength = clamp(contactLength, minLen, maxLen);
    this.compression = this.restLength - this.suspensionLength;
    // Positive velocity = compressing.
    this.compressionVel = (this.prevSuspensionLength - this.suspensionLength) / Math.max(dt, 1e-6);
    this.onGround = true;
    this.surfaceType = ground.surfaceType;
    this.contactNormal.copy(ground.normal);
    this.contactPoint.copy(hardpoint).addScaled(up, -(this.suspensionLength + this.radius));

    // --- Spring -------------------------------------------------------------
    let force = this.preloadForce + this.springRate * this.compression;

    // Bump stop: a progressive rubber stop, not a hard clip. Slamming into it
    // over a kerb is what pitches the car and unloads the tire.
    const overCompression = this.compression - this.maxCompression;
    if (overCompression > 0) {
      force += this.bumpStopRate * overCompression * overCompression * 40;
      this.kerbImpact = Math.max(this.kerbImpact, clamp01(overCompression / 0.02));
    }
    if (this.surfaceType === SurfaceType.KERB) {
      this.kerbImpact = Math.max(this.kerbImpact, clamp01(this.surfaceHarshness / 0.018));
    }

    // --- Damper -------------------------------------------------------------
    const damping = this.compressionVel > 0 ? this.bumpDamping : this.reboundDamping;
    force += damping * this.compressionVel;

    // Anti-roll contribution is injected by the vehicle before this call.
    force += this.antiRollForce;

    // A suspension can push but never pull the car down onto the road.
    force = Math.max(0, force);

    this.suspensionForce = force;
    // Vertical load on the tire, resolved onto the ground normal.
    this.load = force * cosA;
    return force;
  }

  /**
   * Build the contact-patch frame and measure the slip the tire is working at.
   *
   * Slip is *relaxed* rather than taken instantaneously: the tire carcass needs
   * to travel roughly half a metre before it has fully built its side force.
   * That lag is real, and it is also what stops the integrator ringing.
   */
  updateSlip(body, dt) {
    const up = body.up;
    const N = this.contactNormal;

    // Wheel heading: body forward, steered about the body's up axis, then
    // projected into the contact plane.
    const steer = this.steerAngle + this.toe;
    const cs = Math.cos(steer);
    const sn = Math.sin(steer);
    const bf = body.forward;
    const br = body.right;
    const fx = bf.x * cs + br.x * sn;
    const fy = bf.y * cs + br.y * sn;
    const fz = bf.z * cs + br.z * sn;

    // Project onto the ground plane so slip is measured in the plane the tire
    // is actually working in (matters on banking and over kerbs).
    const dotN = fx * N.x + fy * N.y + fz * N.z;
    this.forwardDir.set(fx - N.x * dotN, fy - N.y * dotN, fz - N.z * dotN);
    if (this.forwardDir.lengthSq() < 1e-8) this.forwardDir.copy(bf);
    this.forwardDir.normalize();
    this.rightDir.crossVectors(this.forwardDir, N).normalize();
    // Keep `right` pointing to the car's right.
    if (this.rightDir.dot(br) < 0) this.rightDir.negate();

    // Velocity of the contact patch.
    this.contactOffset.subVectors(this.contactPoint, body.position);
    body.pointVelocity(this.contactOffset, this.contactVelocity);

    const vLong = this.contactVelocity.dot(this.forwardDir);
    const vLat = this.contactVelocity.dot(this.rightDir);

    this.longSlipVelocity = this.angularVelocity * this.radius - vLong;
    this.latSlipVelocity = vLat;

    // Reference speed keeps the slip definitions well conditioned near rest.
    const vRef = Math.max(Math.abs(vLong), 1.8);

    const targetSlipRatio = clamp(this.longSlipVelocity / vRef, -8, 8);
    // Positive slip angle = the contact patch is sliding toward the car's
    // right. The tire model negates this to produce a force that opposes the
    // slide, so it must NOT be pre-negated here.
    const targetSlipAngle = Math.atan2(vLat, vRef);

    // First-order relaxation toward the target, with the rate set by how far
    // the tire has rolled this step.
    const travel = Math.max(Math.abs(vLong), 0.6) * dt;
    const aLong = clamp01(travel / this.relaxationLong);
    const aLat = clamp01(travel / this.relaxationLat);
    this.slipRatio += (targetSlipRatio - this.slipRatio) * aLong;
    this.slipAngle += (targetSlipAngle - this.slipAngle) * aLat;

    return { vLong, vLat };
  }

  /**
   * Solve the wheel's rotational equation of motion and produce the contact
   * force.
   *
   *   I * dOmega/dt = driveTorque - brakeTorque - Fx * r - rollingResistance
   *
   * The tire force feeds back into the wheel's own spin, which is what makes
   * wheelspin and lockup emerge instead of being scripted.
   */
  solve(body, dt, ctx, vLong) {
    const surf = getSurface(this.surfaceType);

    // --- Tire force ---------------------------------------------------------
    const tireCtx = {
      surfaceType: this.surfaceType,
      wetness: ctx.wetness,
      waterDepth: ctx.waterDepth,
      speed: Math.abs(vLong),
      trackRubber: ctx.trackRubber,
      wearScale: ctx.wearScale ?? 1,
      brakeTemp: ctx.brakeTemp
    };

    // Camber gain with body roll slightly modifies the effective load; a small
    // effect but it is what makes stiffer springs feel different in a corner.
    const camberEffect = 1 - Math.abs(this.staticCamber) * 0.12;

    const { fx, fy } = this.tire.computeForces(
      this.load * camberEffect, this.slipRatio, this.slipAngle, tireCtx
    );

    this.forceLong = fx;
    this.forceLat = fy;

    // --- Wheel spin ---------------------------------------------------------
    const inertia = this.wheelInertia + this.extraInertia;

    const rollingResistTorque = this.load * surf.rollingResistance *
                                this.tire.compound.rollingResistance * this.radius *
                                sign(this.angularVelocity);

    // Reaction of the tire force on the wheel.
    const tireTorque = -fx * this.radius;

    let netTorque = this.driveTorque + tireTorque - rollingResistTorque;

    // Brake torque always opposes rotation and must never drive it backwards
    // within a step, so it is clamped to what would bring the wheel to a stop.
    const brakeDir = -sign(this.angularVelocity);
    let brake = this.brakeTorque;
    const stoppingTorque = Math.abs(this.angularVelocity) * inertia / Math.max(dt, 1e-6);
    if (Math.abs(this.angularVelocity) < 0.5 && Math.abs(netTorque) < brake) {
      // Held stationary by the brakes.
      this.angularVelocity = 0;
      this.appliedBrakeTorque = Math.abs(netTorque);
      netTorque = 0;
    } else {
      brake = Math.min(brake, stoppingTorque + Math.abs(netTorque));
      this.appliedBrakeTorque = brake;
      netTorque += brakeDir * brake;
    }

    this.angularVelocity += (netTorque / inertia) * dt;

    // Airborne wheels spin down toward free-rolling speed rather than holding
    // whatever they had, which stops a hopping car from banking wheelspin.
    if (!this.onGround) {
      const freeRoll = vLong / this.radius;
      this.angularVelocity = lerp(this.angularVelocity, freeRoll, clamp01(dt * 2.2));
    }

    this.spinAngle += this.angularVelocity * dt;
    if (this.spinAngle > Math.PI * 2) this.spinAngle -= Math.PI * 2;
    else if (this.spinAngle < -Math.PI * 2) this.spinAngle += Math.PI * 2;

    this.brakePower = Math.abs(this.appliedBrakeTorque * this.angularVelocity);

    // --- Thermal / wear -----------------------------------------------------
    this.tire.update(dt, tireCtx);

    // --- Assemble the world-space contact force ----------------------------
    this.worldForce.set(0, 0, 0);
    if (this.onGround) {
      this.worldForce.addScaled(this.forwardDir, fx);
      this.worldForce.addScaled(this.rightDir, fy);
      this.worldForce.addScaled(this.contactNormal, this.suspensionForce);
    }
    return this.worldForce;
  }

  /** Visual/audio helper: how hard this tire is sliding, 0..1+. */
  get slipMagnitude() {
    return this.tire.combinedSlip;
  }

  get isSliding() {
    return this.onGround && this.tire.combinedSlip > 1.0;
  }

  /** Normalised suspension travel for the telemetry bar, 0 = droop, 1 = bump. */
  get travelFraction() {
    const total = this.maxCompression + this.maxExtension;
    return clamp01((this.compression + this.maxExtension) / total);
  }

  reset(position) {
    this.suspensionLength = this.restLength;
    this.prevSuspensionLength = this.restLength;
    this.compression = 0;
    this.compressionVel = 0;
    this.angularVelocity = 0;
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.load = 0;
    this.steerAngle = 0;
    this.driveTorque = 0;
    this.brakeTorque = 0;
    this.antiRollForce = 0;
    this.kerbImpact = 0;
    this._groundY = null;
  }
}
