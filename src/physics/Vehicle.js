import { Vec3, tmpVec } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { RigidBody } from './RigidBody.js';
import { Wheel } from './Wheel.js';
import { Engine, RPM_TO_RADS, RADS_TO_RPM } from './Engine.js';
import { Transmission } from './Transmission.js';
import { Differential } from './Differential.js';
import { Brakes } from './Brakes.js';
import { Aero } from './Aero.js';
import { DamageModel } from './Damage.js';
import { SurfaceType, getSurface } from './Surfaces.js';
import { TireCompound } from './Tire.js';
import { clamp, clamp01, lerp, sign, damp, makeRng } from '../math/MathUtils.js';

export const FL = 0, FR = 1, RL = 2, RR = 3;

/** Clutch, primary gears and driveshafts, referred to the crank (kg m^2). */
const DRIVESHAFT_INERTIA = 0.055;

/** Neutral control state. */
export function createControls() {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: 0,
    drs: false,
    pitLimiter: false,
    shiftUp: false,
    shiftDown: false,
    requestGear: null,
    resetRequest: false
  };
}

/** Default assist configuration — everything off is the "pro" experience. */
export function createAssists(overrides = {}) {
  return {
    tractionControl: 0,      // 0 off, 0.5 medium, 1 full
    abs: 0,                  // 0 off, 0.5 medium, 1 full
    stabilityControl: 0,     // 0..1 yaw damping
    steeringAssist: 0,       // 0..1 countersteer help
    automaticGears: true,
    autoPitLimiter: true,
    racingLine: false,
    // Speed sensitivity is an *input mapping* aid for stick/keyboard, not a
    // physics change: it limits how much lock a full deflection commands at
    // speed. Real drivers do this with their hands.
    steeringSpeedSensitivity: 1,
    ...overrides
  };
}

/**
 * ============================================================================
 *  VEHICLE
 * ============================================================================
 *
 * The assembly point for the whole simulation chain:
 *
 *   driver input -> engine torque -> gearbox -> differential -> wheel torque
 *     -> tire slip -> tire force -> chassis acceleration -> weight transfer
 *     -> wheel load -> tire grip -> (back to tire force)
 *   and in parallel:  speed -> aero -> wheel load -> tire grip
 *
 * Every arrow in that diagram is an actual data dependency in `step()` below.
 * There is no code path anywhere that moves the car directly.
 */
export class Vehicle {
  constructor(carDef, setup = {}, options = {}) {
    this.car = carDef;
    this.id = options.id ?? 'car';
    this.driverName = options.driverName ?? 'Driver';
    this.isPlayer = !!options.isPlayer;
    this.isAI = !!options.isAI;
    this.isRemote = !!options.isRemote;
    this.colour = options.colour ?? carDef.colour;

    this.body = new RigidBody();
    this.controls = createControls();
    this.assists = createAssists(options.assists);
    this.rng = makeRng(options.seed ?? 12345);

    // --- Consumables --------------------------------------------------------
    this.fuel = setup.fuel ?? carDef.fuelCapacity;
    this.fuelUsedTotal = 0;

    // --- Components ---------------------------------------------------------
    this.engine = new Engine(carDef.engine);
    this.transmission = new Transmission(carDef.transmission);
    this.differential = new Differential(carDef.differential);
    this.brakes = new Brakes({ ...carDef.brakes, ambient: options.ambientTemp ?? 28 });
    this.aero = new Aero({
      clA: carDef.clA, cdA: carDef.cdA, balance: carDef.aeroBalance
    });
    this.damage = new DamageModel(options.damageEnabled !== false);

    this.transmission.automatic = this.assists.automaticGears;
    // Peak torque the clutch can transmit while slipping (Nm).
    this.clutchCapacity = carDef.clutchCapacity ?? 820;
    this.clutchEngagement = 0;

    // --- Wheels -------------------------------------------------------------
    this.wheels = this._buildWheels(carDef, setup, options);

    // --- Runtime state ------------------------------------------------------
    this.steerAngle = 0;
    this.targetSteer = 0;
    this.speed = 0;
    this.speedKmh = 0;
    this.gear = 1;
    this.rpm = this.engine.idleRpm;
    this.retired = false;
    this.finished = false;
    this.inPitLane = false;
    this.pitLimiterActive = false;
    this.pitLimiterSpeed = options.pitLimiterSpeed ?? (80 / 3.6);

    this.drsAvailable = false;
    this.drsActive = false;
    this.drsArmed = false;

    // Traction control loop state: how much throttle it is currently holding
    // back, 0..1.
    this._tcCut = 0;
    this.tcActive = false;

    // Telemetry surfaced to HUD, audio, AI and effects.
    this.telemetry = {
      lateralG: 0, longitudinalG: 0, verticalG: 0,
      slipAngleBody: 0, yawRate: 0,
      understeer: 0, oversteer: 0,
      wheelSlip: [0, 0, 0, 0],
      airborne: false,
      kerbLoad: 0,
      maxTireTemp: 0,
      minTireCondition: 1
    };

    this.events = [];        // transient per-step events for audio/UI
    this.lastCollision = null;
    this.stuckTimer = 0;
    this.offTrackTimer = 0;
    this.surfaceUnderCar = SurfaceType.ASPHALT;

    this.applySetup(setup);
    this._configureMass();
  }

  // -------------------------------------------------------------------------
  //  Construction
  // -------------------------------------------------------------------------

  _buildWheels(car, setup, options) {
    const halfFront = car.trackFront * 0.5;
    const halfRear = car.trackRear * 0.5;
    // Longitudinal axle positions relative to the centre of mass, derived from
    // the weight distribution rather than picked by eye.
    const a = car.wheelbase * (1 - car.frontWeightBias);  // CoM -> front axle
    const b = car.wheelbase * car.frontWeightBias;        // CoM -> rear axle

    const hardpointYFront = -car.cogHeight + car.wheelRadiusFront + car.restLengthFront;
    const hardpointYRear = -car.cogHeight + car.wheelRadiusRear + car.restLengthRear;

    const compound = setup.compound ?? car.defaultCompound;
    const common = {
      compound,
      ambient: options.ambientTemp ?? 26,
      trackTemp: options.trackTemp ?? 34,
      maxCompression: car.maxCompression,
      maxExtension: car.maxExtension
    };

    const mk = (name, index, side, front) => new Wheel({
      ...common,
      name, index, side, front,
      steered: front,
      driven: !front,     // rear-wheel drive, as a formula car is
      position: new Vec3(
        side * (front ? halfFront : halfRear),
        front ? hardpointYFront : hardpointYRear,
        front ? a : -b
      ),
      radius: front ? car.wheelRadiusFront : car.wheelRadiusRear,
      width: front ? car.tireWidthFront : car.tireWidthRear,
      wheelInertia: front ? car.wheelInertiaFront : car.wheelInertiaRear,
      restLength: front ? car.restLengthFront : car.restLengthRear,
      springRate: front ? car.springRateFront : car.springRateRear,
      bumpDamping: front ? car.bumpDampingFront : car.bumpDampingRear,
      reboundDamping: front ? car.reboundDampingFront : car.reboundDampingRear
    });

    return [
      mk('FL', FL, -1, true),
      mk('FR', FR, +1, true),
      mk('RL', RL, -1, false),
      mk('RR', RR, +1, false)
    ];
  }

  /**
   * Recompute mass properties. Called on construction and whenever fuel changes
   * enough to matter — a full tank is ~14% of the car's mass, and burning it off
   * genuinely changes how the car brakes and turns.
   */
  _configureMass() {
    const car = this.car;
    const total = car.dryMass + this.fuel;
    this.body.setMass(total);
    this.body.setBoxInertia(
      total, car.bodyWidth, car.bodyHeight, car.bodyLength, car.inertiaScale
    );

    // Static corner loads set the spring preloads so the car sits at its design
    // ride height regardless of fuel load.
    const W = total * 9.80665;
    const frontLoad = W * car.frontWeightBias * 0.5;
    const rearLoad = W * (1 - car.frontWeightBias) * 0.5;
    this.wheels[FL].setStaticLoad(frontLoad);
    this.wheels[FR].setStaticLoad(frontLoad);
    this.wheels[RL].setStaticLoad(rearLoad);
    this.wheels[RR].setStaticLoad(rearLoad);
    this.body.updateDerived();
  }

  /**
   * Apply a setup. Every field maps onto a physical parameter — nothing here is
   * cosmetic, and a bad setup makes a genuinely worse car.
   */
  applySetup(setup) {
    const car = this.car;
    this.setup = { ...setup };

    if (setup.frontWing != null) this.aero.frontWing = clamp(setup.frontWing, 1, 11);
    if (setup.rearWing != null) this.aero.rearWing = clamp(setup.rearWing, 1, 11);

    // Aero balance follows the wing settings: more front wing moves the centre
    // of pressure forward, which is what actually changes the handling.
    const wingDelta = (this.aero.frontWing - this.aero.rearWing) / 10;
    this.aero.balance = clamp(
      car.aeroBalance + wingDelta * 0.052 + (setup.aeroBalanceTrim ?? 0) * 0.01,
      0.34, 0.54
    );

    const springScale = (v) => lerp(0.72, 1.32, clamp01(((v ?? 5) - 1) / 10));
    const dampScale = (v) => lerp(0.75, 1.30, clamp01(((v ?? 5) - 1) / 10));

    const sf = springScale(setup.springFront);
    const sr = springScale(setup.springRear);
    const db = dampScale(setup.dampingBump);
    const dr = dampScale(setup.dampingRebound);

    this.wheels[FL].springRate = car.springRateFront * sf;
    this.wheels[FR].springRate = car.springRateFront * sf;
    this.wheels[RL].springRate = car.springRateRear * sr;
    this.wheels[RR].springRate = car.springRateRear * sr;

    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      this.wheels[i].bumpDamping = (front ? car.bumpDampingFront : car.bumpDampingRear) * db;
      this.wheels[i].reboundDamping = (front ? car.reboundDampingFront : car.reboundDampingRear) * dr;
    }

    // Ride height changes the rest length, which changes the aero platform.
    const rhScale = (v) => lerp(-0.012, 0.018, clamp01(((v ?? 5) - 1) / 10));
    this.wheels[FL].restLength = car.restLengthFront + rhScale(setup.rideHeightFront);
    this.wheels[FR].restLength = this.wheels[FL].restLength;
    this.wheels[RL].restLength = car.restLengthRear + rhScale(setup.rideHeightRear);
    this.wheels[RR].restLength = this.wheels[RL].restLength;

    this.antiRollFront = car.antiRollFront * springScale(setup.antiRollFront);
    this.antiRollRear = car.antiRollRear * springScale(setup.antiRollRear);

    if (setup.brakeBalance != null) this.brakes.setBalance(setup.brakeBalance);
    this.brakePressure = clamp(setup.brakePressure ?? 1, 0.6, 1.0);

    if (setup.diffPower != null) this.differential.powerRamp = clamp(setup.diffPower, 0, 0.85);
    if (setup.diffCoast != null) this.differential.coastRamp = clamp(setup.diffCoast, 0, 0.85);
    if (setup.diffPreload != null) this.differential.preload = clamp(setup.diffPreload, 0, 220);
    if (setup.finalDrive != null) this.transmission.finalDrive = clamp(setup.finalDrive, 2.3, 3.8);

    if (setup.compound) this.setCompound(setup.compound);
    if (setup.fuel != null) {
      this.fuel = clamp(setup.fuel, 0, car.fuelCapacity);
      this._configureMass();
    }
    return this;
  }

  setCompound(key) {
    for (const w of this.wheels) w.setCompound(key);
    this.currentCompound = key;
  }

  get compound() {
    return this.wheels[0].tire.compoundKey;
  }

  // -------------------------------------------------------------------------
  //  Placement
  // -------------------------------------------------------------------------

  placeAt(position, yaw, options = {}) {
    this.body.position.copy(position);
    this.body.orientation.setFromYaw(yaw);
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
    this.body.updateDerived();
    for (const w of this.wheels) w.reset();
    this.steerAngle = 0;
    this.transmission.reset(options.gear ?? 1);
    this.engine.rpm = this.engine.idleRpm;
    this.brakes.reset();
    this.aero.reset();
    this.stuckTimer = 0;
    return this;
  }

  // -------------------------------------------------------------------------
  //  Simulation step
  // -------------------------------------------------------------------------

  /**
   * Advance the vehicle by one fixed timestep.
   *
   * @param {number} dt seconds (fixed, typically 1/240)
   * @param {object} terrain object with sampleGround(x, z, out)
   * @param {object} env     { wetness, waterDepth, trackRubber, airDensity, wind, ... }
   */
  step(dt, terrain, env) {
    if (this.retired) {
      this.body.velocity.scale(Math.max(0, 1 - dt * 2));
      return;
    }
    this.events.length = 0;

    const body = this.body;
    body.clearAccumulators();

    this.speed = body.speed;
    this.speedKmh = this.speed * 3.6;
    const forwardSpeed = body.forwardSpeed;

    // --- 1. Steering --------------------------------------------------------
    this._updateSteering(dt, forwardSpeed);

    // --- 2. Ground sampling and suspension ---------------------------------
    // Suspension first, because the vertical load it produces is the input to
    // every tire force computed later in this same step.
    const grounds = this._sampleGround(terrain, env);
    this._updateAntiRoll();
    let anyGround = false;
    for (let i = 0; i < 4; i++) {
      this.wheels[i].updateSuspension(body, grounds[i], dt);
      if (this.wheels[i].onGround) anyGround = true;
    }

    // --- 3. Aerodynamics ----------------------------------------------------
    this._applyAero(dt, env, forwardSpeed);

    // --- 4. Slip measurement ------------------------------------------------
    const slipInfo = [];
    for (let i = 0; i < 4; i++) slipInfo.push(this.wheels[i].updateSlip(body, dt));

    // --- 5. Powertrain ------------------------------------------------------
    this._updatePowertrain(dt, forwardSpeed);

    // --- 6. Brakes ----------------------------------------------------------
    this._updateBrakes(dt, env);

    // --- 7. Tire forces, applied at the contact patches --------------------
    // This is where load transfer becomes real: each force is applied at its
    // own contact point, so the resulting torque pitches and rolls the body,
    // which changes the loads used on the *next* step.
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const ctx = {
        wetness: grounds[i].wetness,
        waterDepth: grounds[i].waterDepth,
        trackRubber: grounds[i].rubber,
        wearScale: env.tireWearScale ?? 1,
        brakeTemp: this.brakes.temps[i]
      };
      const force = w.solve(body, dt, ctx, slipInfo[i].vLong);
      if (w.onGround) {
        const offset = tmpVec().subVectors(w.contactPoint, body.position);
        body.applyForceAtPoint(force, offset);
      }
    }

    // --- 8. Surface drag (grass and gravel really do slow the car) ---------
    this._applySurfaceDrag(grounds, dt);

    // --- 9. Assists that act on the chassis --------------------------------
    if (this.assists.stabilityControl > 0) this._applyStabilityControl(dt);

    // --- 10. Fuel and damage ------------------------------------------------
    this._consumeFuel(dt);
    this.damage.update(dt, this.engine.throttle);
    this._applyDamageToSystems();

    // --- 11. Integrate ------------------------------------------------------
    body.integrate(dt);
    if (!body.sanitize()) {
      this.events.push({ type: 'physicsReset' });
    }

    // --- 12. Telemetry ------------------------------------------------------
    this._updateTelemetry(dt, anyGround, grounds);
  }

  // -------------------------------------------------------------------------

  _updateSteering(dt, forwardSpeed) {
    const car = this.car;
    let input = clamp(this.controls.steer, -1, 1);

    // Speed-sensitive input mapping. This limits the lock a full deflection
    // asks for; it does not touch the tire model or add any yaw of its own.
    if (this.assists.steeringSpeedSensitivity > 0) {
      // The floor must stay above the lock a high-downforce car genuinely needs
      // at speed (roughly 9 degrees once slip angles are included), or the aid
      // would cap cornering below the tires' own limit.
      const s = Math.abs(forwardSpeed);
      const reduction = lerp(
        1.0, 0.42,
        clamp01((s - 20) / 70) * this.assists.steeringSpeedSensitivity
      );
      input *= reduction;
    }

    // Optional countersteer assist: nudges the target toward the direction the
    // car is actually sliding. Off by default; capped so it can never drive.
    if (this.assists.steeringAssist > 0 && Math.abs(forwardSpeed) > 8) {
      const lv = this.body.getLocalVelocity(tmpVec());
      const bodySlip = Math.atan2(lv.x, Math.abs(lv.z));
      const correction = clamp(-bodySlip * 0.85, -0.45, 0.45);
      input = clamp(input + correction * this.assists.steeringAssist, -1, 1);
    }

    this.targetSteer = input * car.maxSteerAngle;

    // The roadwheels cannot snap instantly: rack and driver both take time.
    const maxDelta = car.steerRate * dt;
    this.steerAngle += clamp(this.targetSteer - this.steerAngle, -maxDelta, maxDelta);

    // Ackermann: the inside wheel needs more angle on the same radius.
    const base = this.steerAngle;
    const ack = 0.16;
    const inner = base * (1 + ack);
    const outer = base * (1 - ack);
    if (base >= 0) {
      // Turning right: the right wheel is on the inside.
      this.wheels[FR].steerAngle = inner;
      this.wheels[FL].steerAngle = outer;
    } else {
      this.wheels[FL].steerAngle = inner;
      this.wheels[FR].steerAngle = outer;
    }

    // A bent front corner pulls the steering.
    const suspFL = this.damage.suspension[FL];
    const suspFR = this.damage.suspension[FR];
    if (suspFL < 0.9 || suspFR < 0.9) {
      const pull = (suspFR - suspFL) * 0.10;
      this.wheels[FL].steerAngle += pull;
      this.wheels[FR].steerAngle += pull;
    }
  }

  _sampleGround(terrain, env) {
    if (!this._groundCache) {
      this._groundCache = [0, 1, 2, 3].map(() => ({
        point: new Vec3(), normal: new Vec3(0, 1, 0),
        surfaceType: SurfaceType.ASPHALT, wetness: 0, waterDepth: 0,
        rubber: 0, distanceAlong: 0, lateral: 0
      }));
    }
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const hp = this.body.localToWorldPoint(w.position, tmpVec());
      terrain.sampleGround(hp.x, hp.z, this._groundCache[i], env);
    }
    return this._groundCache;
  }

  /**
   * Anti-roll bars couple the two wheels on an axle. Stiffening one end
   * transfers more lateral load across that axle, and because tire grip falls
   * off with load, that end loses grip — the classic balance adjustment.
   */
  _updateAntiRoll() {
    const fl = this.wheels[FL], fr = this.wheels[FR];
    const rl = this.wheels[RL], rr = this.wheels[RR];

    const frontDelta = fl.compression - fr.compression;
    const rearDelta = rl.compression - rr.compression;

    fl.antiRollForce = this.antiRollFront * frontDelta;
    fr.antiRollForce = -this.antiRollFront * frontDelta;
    rl.antiRollForce = this.antiRollRear * rearDelta;
    rr.antiRollForce = -this.antiRollRear * rearDelta;
  }

  _applyAero(dt, env, forwardSpeed) {
    const body = this.body;
    const car = this.car;

    // DRS eligibility is decided by the race director; the car only actuates.
    this.aero.update(dt, this.controls.drs, this.drsAvailable);
    this.drsActive = this.aero.drsTransition > 0.5;

    // Apparent airspeed includes wind.
    const wind = env.wind;
    let airVx = body.velocity.x, airVz = body.velocity.z;
    if (wind) { airVx -= wind.x; airVz -= wind.z; }
    const airVel = tmpVec().set(airVx, body.velocity.y, airVz);
    const airspeed = airVel.length();
    const alongHeading = airVel.dot(body.forward);

    // Sideslip: how far the car is pointing away from where it is going.
    const lv = body.getLocalVelocity(tmpVec());
    const sideslip = Math.abs(lv.z) > 3 ? Math.atan2(lv.x, Math.abs(lv.z)) : 0;

    // Ride height from the actual front suspension state.
    const rideHeight = Math.max(
      0.004,
      car.rideHeightFront - (this.wheels[FL].compression + this.wheels[FR].compression) * 0.5
    );

    this.aero.airDensity = env.airDensity ?? 1.225;
    this.aero.frontWingHealth = this.damage.frontWing;
    this.aero.rearWingHealth = this.damage.rearWing;
    this.aero.floorHealth = this.damage.floor;

    const { downforceFront, downforceRear, drag } =
      this.aero.computeForces(Math.max(0, alongHeading), rideHeight, sideslip);

    // Downforce is applied at the front and rear centres of pressure, so it
    // loads the axles individually. This is what makes aero balance a real
    // handling parameter rather than a number on a menu.
    const downDir = tmpVec().copy(body.up).negate();

    const fFront = new Vec3().copy(downDir).scale(downforceFront);
    body.applyForceAtPoint(fFront, body.localToWorldDir(
      tmpVec().set(0, 0.06, car.frontCopZ), new Vec3()
    ));

    const fRear = new Vec3().copy(downDir).scale(downforceRear);
    body.applyForceAtPoint(fRear, body.localToWorldDir(
      tmpVec().set(0, 0.22, car.rearCopZ), new Vec3()
    ));

    // Drag opposes the airflow, applied above the centre of mass so that
    // lifting off produces a small forward pitch, as it does in reality.
    if (airspeed > 0.5) {
      const dragForce = new Vec3().copy(airVel).scale(-drag / airspeed);
      body.applyForceAtPoint(dragForce, body.localToWorldDir(
        tmpVec().set(0, car.dragCopHeight, 0), new Vec3()
      ));
    }
  }

  _updatePowertrain(dt, forwardSpeed) {
    const trans = this.transmission;
    const engine = this.engine;

    trans.automatic = this.assists.automaticGears;

    // --- Throttle, with optional traction control --------------------------
    let throttle = clamp01(this.controls.throttle);

    // --- Traction control ---------------------------------------------------
    // A closed loop on the driven wheels, which is how the real thing works and
    // the only way it can actually hold slip where the driver wants it. The
    // open-loop version this replaces scaled the throttle by a fixed fraction
    // of how far past a threshold the wheels were, which left the rears
    // spinning at eighty percent slip on a medium setting — traction control
    // that did not control traction, and a car that spun under power.
    //
    // It works purely through the throttle. It gives away no grip the tyres do
    // not have, and switching it off gives the car back exactly as it was.
    if (this.assists.tractionControl > 0) {
      const level = this.assists.tractionControl;
      const rl = this.wheels[RL], rr = this.wheels[RR];

      // Target a wheel SPEED, not a slip ratio. Slip ratio runs to eight under
      // real wheelspin, and a loop fed a number with that range can only slam
      // the throttle shut and then fling it open again. Expressed as a speed
      // the error is naturally bounded, which is what makes the loop settle.
      const road = Math.max(Math.abs(forwardSpeed), 2.5);
      const targetSlip = lerp(0.22, 0.10, level);
      const targetOmega = (road * (1 + targetSlip)) / this.car.wheelRadiusRear;
      const fastest = Math.max(rl.angularVelocity, rr.angularVelocity);
      let error = clamp((fastest - targetOmega) / Math.max(targetOmega, 6), -1, 1);

      // Combined slip is normalised so 1.0 means "at the limit in any
      // direction". Watching it catches power-on oversteer, which a system
      // looking only at wheel speed never sees: a rear tyre can be right at
      // its limit sideways while turning at exactly the right speed.
      //
      // It counts only while the wheels are being DRIVEN. Under braking the
      // same reading means something else entirely, and cutting a throttle
      // that is already closed cannot help.
      if (fastest > targetOmega * 0.5) {
        const worst = Math.max(rl.tire.combinedSlip, rr.tire.combinedSlip);
        error = Math.max(error, clamp((worst - 1.1) * 0.5, -1, 1));
      }

      // Cut briskly, restore gently: the asymmetry is what stops it hunting.
      // How briskly scales with how bad it is, so a standing start — where the
      // wheels can be turning many times road speed within a few milliseconds
      // — is caught almost at once, while small corrections stay gentle enough
      // not to feel like the throttle is being snatched away.
      const rate = error > 0 ? lerp(5.5, 24, clamp01(error)) : 2.0;
      this._tcCut = clamp01(this._tcCut + error * rate * dt);
      // It needs real authority to hold slip in a short first gear: even a
      // fifth of the throttle is a couple of thousand newton-metres at the
      // axle, which spins the wheels regardless. Stopping just short of a
      // fully closed throttle keeps the driveline in tension rather than
      // pushing it into overrun.
      throttle *= 1 - this._tcCut * lerp(0.80, 0.97, level);
      this.tcActive = this._tcCut > 0.02;
    } else {
      this._tcCut = 0;
      this.tcActive = false;
    }

    // Pit limiter: a hard speed cap enforced through the throttle, exactly as
    // the real system works.
    this.pitLimiterActive = this.controls.pitLimiter ||
      (this.assists.autoPitLimiter && this.inPitLane);
    if (this.pitLimiterActive && this.speed > this.pitLimiterSpeed * 0.985) {
      const over = clamp01((this.speed - this.pitLimiterSpeed * 0.985) / 2.0);
      throttle *= 1 - over;
    }

    engine.setThrottle(throttle);

    // --- Gear selection -----------------------------------------------------
    const drivenOmega = (this.wheels[RL].angularVelocity + this.wheels[RR].angularVelocity) * 0.5;
    if (this.controls.shiftUp) { trans.requestUpshift(); this.controls.shiftUp = false; }
    if (this.controls.shiftDown) { trans.requestDownshift(); this.controls.shiftDown = false; }
    const gearRequest = this.controls.requestGear;
    if (gearRequest != null) {
      trans.requestGear(gearRequest);
      this.controls.requestGear = null;
    } else if (trans.automatic && trans.gear === 0 && !trans.inNeutral &&
               forwardSpeed > -0.5) {
      // An automatic box never sits in reverse unless the car is actually
      // reversing. Without this, anything that leaves it in reverse — a spin
      // recovery that ran out of time, a request dropped during a shift —
      // strands the car driving backwards under full throttle, because the
      // auto shift logic below only ever shifts up from first.
      trans.requestGear(1);
    }
    // Shift decisions use the engine speed implied by ROAD speed so that
    // wheelspin cannot run the car up through the gearbox while it is barely
    // moving, and a slipping clutch off the line cannot upshift at all.
    const roadOmega = Math.abs(forwardSpeed) / this.car.wheelRadiusRear;
    const roadRpm = roadOmega * Math.abs(trans.ratio) * RADS_TO_RPM;
    const rolling = Math.abs(forwardSpeed) > 2.0;
    if (trans.automatic && (rolling || trans.gear > 1)) {
      trans.autoShift(roadRpm, roadOmega, throttle, this.controls.brake, engine);
    }
    trans.update(dt);
    if (trans.shiftEventPending !== 0) {
      this.events.push({ type: 'shift', direction: trans.shiftEventPending, gear: trans.gear });
    }

    // --- Clutch -------------------------------------------------------------
    // A real slipping clutch rather than an on/off switch. Torque capacity is
    // ramped in by engine speed and throttle, which makes a standing start
    // self-regulating: bog the engine and the clutch backs off, revs recover,
    // it bites again. It is also the only reason the car can move at all from
    // rest, since at zero road speed the gearbox input is stationary.
    let engagement, speedEngage;
    // Only a shift or true neutral opens the clutch outright. Reverse is a
    // gear like any other and engages the same way, or the car could never
    // back out of a gravel trap.
    if (trans.isShifting || trans.inNeutral) {
      engagement = 0;
      speedEngage = 0;
    } else {
      speedEngage = clamp01((Math.abs(forwardSpeed) - 0.4) / 3.2);
      const revEngage = clamp01((engine.rpm - engine.idleRpm * 1.08) / 2400) * throttle;
      engagement = clamp01(Math.max(speedEngage, revEngage));
    }
    trans.clutch = engagement;

    const engineTorque = engine.update(dt, engagement > 0.5);

    const engineOmega = engine.rpm * RPM_TO_RADS;
    // Signed, not a magnitude. Through a forward gear with the wheels turning
    // forwards this is positive, and through reverse with the wheels turning
    // backwards it is positive too — but when the wheels turn the wrong way
    // for the selected gear it goes negative, which is precisely what the
    // clutch below needs to know. Taking the magnitude here hides that, and a
    // hidden sign becomes a driveline that accelerates the wheels harder the
    // further backwards they go.
    const gearboxOmega = drivenOmega * trans.ratio;
    const deltaOmega = engineOmega - gearboxOmega;

    let clutchTorque;
    // Lock on road speed alone, never on the engine/gearbox speed difference.
    // Under wheelspin that difference is large *because* the wheels are
    // spinning downstream of a clutch that is genuinely locked; treating it as
    // slip would have the clutch fight the drivetrain instead of letting the
    // rev limiter do its job.
    // A locked clutch ties engine speed to wheel speed through the gear, and
    // that relationship only holds while the wheels turn the way the gear
    // drives them. If they are turning the other way — dragged backwards by
    // engine braking, or the car rolling back on a slope — the engine cannot
    // follow them, and pretending otherwise sends the driveline into a
    // runaway: the rpm is read as a magnitude, so the engine keeps making
    // forward torque while the wheels accelerate further backwards.
    const gearDirection = Math.sign(trans.ratio) || 1;
    const drivelineAligned = drivenOmega * gearDirection >= -0.5;

    if (speedEngage > 0.9 && drivelineAligned) {
      // Locked: the engine is geared straight to the wheels, so its speed is
      // dictated by wheel speed and all of its torque reaches the differential.
      this._clutchSlipping = false;
      clutchTorque = engineTorque;
      const geared = gearboxOmega * RADS_TO_RPM;
      engine.setRpmFromWheels(Math.max(geared, engine.idleRpm * 0.7));
    } else {
      // Slipping: the clutch passes only what its capacity allows, and the
      // engine accelerates or decelerates on the difference.
      this._clutchSlipping = engagement > 0.02;
      const capacity = this.clutchCapacity * engagement;
      clutchTorque = clamp(deltaOmega * 45, -capacity, capacity);
      if (engagement <= 0.02) clutchTorque = 0;
      engine.integrateFree(engineTorque - clutchTorque, dt);
    }

    this.rpm = engine.rpm;
    this.gear = trans.gear;
    this.clutchEngagement = engagement;

    // --- Driveline inertia --------------------------------------------------
    // Reflect the engine and gearbox inertia onto the driven wheels through the
    // square of the current ratio. This is what gives the drivetrain its real
    // rotational mass: in first gear the engine contributes tens of kg m^2 at
    // the wheel, which is why a low gear feels heavy and why wheelspin builds
    // progressively instead of instantaneously.
    const lockFactor = this._clutchSlipping ? engagement * 0.35 : 1;
    const ratioSq = trans.ratio * trans.ratio;
    const reflected = (engine.inertia + DRIVESHAFT_INERTIA) * ratioSq * lockFactor;
    this.wheels[RL].extraInertia = reflected * 0.5;
    this.wheels[RR].extraInertia = reflected * 0.5;

    // --- Torque to the driven wheels ---------------------------------------
    let axleTorque = trans.outputTorque(clutchTorque);
    axleTorque *= this.damage.gearbox;

    const split = this.differential.split(
      axleTorque, this.wheels[RL].angularVelocity, this.wheels[RR].angularVelocity
    );
    this.wheels[RL].driveTorque = split.left;
    this.wheels[RR].driveTorque = split.right;
    this.wheels[FL].driveTorque = 0;
    this.wheels[FR].driveTorque = 0;
  }

  _updateBrakes(dt, env) {
    let input = clamp01(this.controls.brake) * this.brakePressure;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const front = i < 2;
      let torque = this.brakes.torqueAt(i, input, front);

      // ABS releases pressure when the wheel starts to lock. It works on the
      // measured slip ratio of that individual wheel, exactly like the real
      // system, so it costs a little braking performance in exchange for
      // keeping steering authority.
      if (this.assists.abs > 0 && this.speed > 3) {
        const lockThreshold = lerp(-0.28, -0.16, this.assists.abs);
        if (w.slipRatio < lockThreshold) {
          const excess = clamp01((lockThreshold - w.slipRatio) / 0.30);
          torque *= lerp(1, 0.15, excess * this.assists.abs);
        }
      }

      // A punctured tire cannot take brake torque properly.
      if (this.damage.punctures[i]) torque *= 0.55;

      w.brakeTorque = torque;
    }

    // Handbrake locks the rears — mostly used to hold the car on the grid.
    if (this.controls.handbrake > 0) {
      const hb = this.controls.handbrake * 5200;
      this.wheels[RL].brakeTorque += hb;
      this.wheels[RR].brakeTorque += hb;
    }

    const powers = [
      this.wheels[FL].brakePower, this.wheels[FR].brakePower,
      this.wheels[RL].brakePower, this.wheels[RR].brakePower
    ];
    this.brakes.update(dt, powers, this.speed, env.wetness ?? 0);
    this.brakes.brakeInput = input;
  }

  _applySurfaceDrag(grounds, dt) {
    // Ploughing resistance from soft surfaces, applied at the contact patches
    // so that dropping two wheels onto the grass yaws the car toward them.
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.onGround) continue;
      const surf = getSurface(w.surfaceType);
      if (surf.dragFactor <= 0) continue;
      const v = w.contactVelocity;
      const sp = v.length();
      if (sp < 0.5) continue;
      const mag = surf.dragFactor * sp * sp * 0.5 * (w.load / 3000);
      const f = tmpVec().copy(v).scale(-mag / sp);
      const offset = tmpVec().subVectors(w.contactPoint, this.body.position);
      this.body.applyForceAtPoint(f, offset);
    }
  }

  /**
   * Optional electronic stability control: a small yaw-damping torque when the
   * car is rotating faster than the steering asks for. Deliberately weak, and
   * it cannot save a car that is already gone.
   */
  _applyStabilityControl(dt) {
    const body = this.body;
    if (this.speed < 8) return;
    const lv = body.getLocalVelocity(tmpVec());
    const bodySlip = Math.atan2(lv.x, Math.abs(lv.z));
    const yawRate = body.angularVelocity.dot(body.up);
    // The yaw rate a neutral car would have on this steering angle and speed.
    const targetYaw = (this.steerAngle * this.speed) /
                      (this.car.wheelbase + this.speed * this.speed * 0.0018);
    // It may only ever SLOW the car's rotation, never speed it up.
    //
    // Damping toward the commanded yaw rate sounds right and is not: a car
    // already sliding at full lock is usually rotating SLOWER than that lock
    // demands, so a plain error term pushes it to rotate faster — the
    // stability system driving the spin it exists to prevent. Acting only on
    // the amount by which the car is over-rotating, and only against it, means
    // the worst it can do is nothing.
    const overRotating = Math.abs(yawRate) - Math.abs(targetYaw);
    if (overRotating <= 0) return;

    const excess = Math.abs(bodySlip) > 0.10 ? clamp01((Math.abs(bodySlip) - 0.10) / 0.25) : 0;
    const gain = this.assists.stabilityControl * excess * 2600;
    if (gain <= 0) return;

    const torque = tmpVec().copy(body.up)
      .scale(-Math.sign(yawRate) * overRotating * gain);
    body.applyTorque(torque);
  }

  _consumeFuel(dt) {
    if (this.fuel <= 0) {
      this.fuel = 0;
      this.engine.healthFactor = 0;   // out of fuel: the engine cuts
      return;
    }
    const used = this.engine.fuelUsedThisStep;
    this.fuel = Math.max(0, this.fuel - used);
    this.fuelUsedTotal += used;
    // Refresh mass properties periodically rather than every step — the change
    // per step is tiny but over a stint it is worth several tenths a lap.
    this._fuelDirty = (this._fuelDirty || 0) + used;
    if (this._fuelDirty > 0.25) {
      this._fuelDirty = 0;
      this._configureMass();
    }
  }

  _applyDamageToSystems() {
    this.engine.healthFactor = this.fuel > 0 ? this.damage.engine : 0;
    for (let i = 0; i < 4; i++) {
      const s = this.damage.suspension[i];
      const w = this.wheels[i];
      if (s < 1) {
        // A damaged corner loses spring rate and gains negative camber, which
        // costs that tire grip and pulls the car toward it.
        w.springRate = w.springRate * 0.999 + (w.springRate * s) * 0.001;
        w.tire.damage = Math.max(w.tire.damage, (1 - s) * 0.6);
      }
      if (this.damage.punctures[i]) w.tire.damage = 1;
    }
  }

  _updateTelemetry(dt, anyGround, grounds) {
    const body = this.body;
    const t = this.telemetry;
    const acc = body.orientation.rotateVectorInverse(body.acceleration, tmpVec());
    const G = 1 / 9.80665;
    t.lateralG = damp(t.lateralG, acc.x * G, 22, dt);
    t.longitudinalG = damp(t.longitudinalG, acc.z * G, 22, dt);
    t.verticalG = damp(t.verticalG, acc.y * G, 18, dt);

    const lv = body.getLocalVelocity(tmpVec());
    t.slipAngleBody = Math.abs(lv.z) > 2 ? Math.atan2(lv.x, Math.abs(lv.z)) : 0;
    t.yawRate = body.angularVelocity.dot(body.up);
    t.airborne = !anyGround;

    // Understeer / oversteer, measured from the difference between front and
    // rear axle slip angles. This is the number that drives the HUD's balance
    // indicator and the AI's own sense of what the car is doing.
    const frontSlip = (Math.abs(this.wheels[FL].slipAngle) + Math.abs(this.wheels[FR].slipAngle)) * 0.5;
    const rearSlip = (Math.abs(this.wheels[RL].slipAngle) + Math.abs(this.wheels[RR].slipAngle)) * 0.5;
    const balance = frontSlip - rearSlip;
    t.understeer = clamp01(balance / 0.16);
    t.oversteer = clamp01(-balance / 0.16);

    let maxTemp = 0, minCond = 1, kerb = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      t.wheelSlip[i] = w.tire.combinedSlip;
      maxTemp = Math.max(maxTemp, w.tire.surfaceTemp);
      minCond = Math.min(minCond, w.tire.condition);
      kerb = Math.max(kerb, w.kerbImpact);
      w.kerbImpact *= Math.max(0, 1 - dt * 6);
    }
    t.maxTireTemp = maxTemp;
    t.minTireCondition = minCond;
    t.kerbLoad = kerb;

    this.surfaceUnderCar = grounds[0].surfaceType;

    // Stuck detection for the recovery system.
    if (this.speed < 1.2 && !this.finished) this.stuckTimer += dt;
    else this.stuckTimer = 0;

    if (this.damage.isTerminal) {
      this.retired = true;
      this.events.push({ type: 'retired', reason: 'damage' });
    }
  }

  // -------------------------------------------------------------------------
  //  Queries used by race logic, HUD and AI
  // -------------------------------------------------------------------------

  get position() { return this.body.position; }
  get velocity() { return this.body.velocity; }
  get forward() { return this.body.forward; }
  get yaw() { return this.body.orientation.getYaw(); }

  /** Average tire condition 0..1. */
  get tireCondition() {
    let s = 0;
    for (const w of this.wheels) s += w.tire.condition;
    return s / 4;
  }

  get tireTemps() {
    return this.wheels.map((w) => w.tire.surfaceTemp);
  }

  get tireWear() {
    return this.wheels.map((w) => w.tire.wear);
  }

  /** Fit a new set of tires — the pit stop calls this. */
  changeTires(compound, preheat = true) {
    for (const w of this.wheels) w.tire.reset(compound, preheat);
    this.currentCompound = compound;
    this.damage.punctures = [false, false, false, false];
  }

  refuel(kg) {
    this.fuel = clamp(this.fuel + kg, 0, this.car.fuelCapacity);
    this._configureMass();
  }

  /** Snapshot for network transmission. */
  serializeState() {
    const b = this.body;
    return {
      p: [r3(b.position.x), r3(b.position.y), r3(b.position.z)],
      q: [r4(b.orientation.x), r4(b.orientation.y), r4(b.orientation.z), r4(b.orientation.w)],
      v: [r2(b.velocity.x), r2(b.velocity.y), r2(b.velocity.z)],
      w: [r2(b.angularVelocity.x), r2(b.angularVelocity.y), r2(b.angularVelocity.z)],
      st: r3(this.steerAngle),
      g: this.gear,
      r: Math.round(this.rpm),
      th: Math.round(this.engine.throttle * 100) / 100,
      br: Math.round(this.controls.brake * 100) / 100,
      drs: this.drsActive ? 1 : 0,
      ws: this.wheels.map((w) => r2(w.angularVelocity)),
      wc: this.wheels.map((w) => r3(w.compression)),
      sl: this.wheels.map((w) => Math.round(w.tire.combinedSlip * 100) / 100),
      sf: this.wheels.map((w) => w.surfaceType)
    };
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;
