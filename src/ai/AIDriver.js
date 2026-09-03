import { Vec3, tmpVec } from '../math/Vec3.js';
import {
  clamp, clamp01, lerp, smoothstep, wrapRange, circularDelta,
  makeRng, randGaussian, damp, wrapAngle
} from '../math/MathUtils.js';
import { SpeedProfile } from './SpeedProfile.js';
import { TireCompound } from '../physics/Tire.js';

/**
 * ============================================================================
 *  AI DRIVER
 * ============================================================================
 *
 * The AI drives the car through exactly the same control inputs a human has:
 * throttle, brake, steering, gears and DRS. It has no extra grip, no speed
 * boost and no ability to ignore the tire model — if it asks for more than the
 * tires can give, it slides, exactly as a player would.
 *
 * Its skill shows up as how close to the limit it dares to run, how precisely
 * it hits its braking points, how quickly it reacts, and how often it makes a
 * mistake — not as a multiplier on the car.
 */

export const AI_SKILL_PRESETS = {
  // `confidence` is the fraction of the car's theoretical grip limit the driver
  // is willing to use. It is the single biggest determinant of pace, and it is
  // applied to the driver's own speed TARGET — the car itself is identical at
  // every level, and none of these values gives anyone extra grip.
  rookie:  { name: 'Rookie',  confidence: 0.700, reaction: 0.34, precision: 0.55, aggression: 0.30, consistency: 0.55 },
  amateur: { name: 'Amateur', confidence: 0.760, reaction: 0.27, precision: 0.66, aggression: 0.42, consistency: 0.66 },
  pro:     { name: 'Pro',     confidence: 0.815, reaction: 0.20, precision: 0.78, aggression: 0.55, consistency: 0.78 },
  expert:  { name: 'Expert',  confidence: 0.860, reaction: 0.14, precision: 0.88, aggression: 0.68, consistency: 0.88 },
  legend:  { name: 'Legend',  confidence: 0.900, reaction: 0.09, precision: 0.95, aggression: 0.80, consistency: 0.95 }
};

/** Lines the AI can choose between, in priority order for a given situation. */
const LINE_RACING = 'racing';
const LINE_DEFENSIVE = 'defensive';
const LINE_OVERTAKE = 'overtake';
const LINE_WET = 'wet';

/**
 * Extra front-wheel angle needed per unit of lateral acceleration, in
 * rad per m/s^2. This is the car's understeer gradient: the slip angle the
 * front tires must run at to generate the force the corner demands.
 */
const UNDERSTEER_GRADIENT = 0.0050;

/**
 * Cross-track correction gains, in lateral acceleration (m/s^2) per metre of
 * position error and per m/s of closing rate.
 */
const CROSS_TRACK_P = 2.2;
const CROSS_TRACK_D = 2.6;

export class AIDriver {
  /**
   * @param {Vehicle} vehicle the car this driver controls
   * @param {TrackModel} track
   * @param {object} opts
   */
  constructor(vehicle, track, opts = {}) {
    this.vehicle = vehicle;
    this.track = track;
    this.id = vehicle.id;

    const skillKey = opts.skill || 'pro';
    const preset = AI_SKILL_PRESETS[skillKey] || AI_SKILL_PRESETS.pro;
    // Per-driver variation so a grid of "Pro" cars is not twenty clones.
    this.rng = makeRng(opts.seed ?? 1234);
    const spread = opts.spread ?? 0.02;
    this.skill = {
      key: skillKey,
      name: preset.name,
      confidence: clamp(preset.confidence + randGaussian(this.rng, 0, spread), 0.70, 1.0),
      reaction: Math.max(0.04, preset.reaction * (1 + randGaussian(this.rng, 0, 0.15))),
      precision: clamp01(preset.precision + randGaussian(this.rng, 0, 0.05)),
      aggression: clamp01(preset.aggression + randGaussian(this.rng, 0, 0.12)),
      consistency: clamp01(preset.consistency + randGaussian(this.rng, 0, 0.05))
    };

    // The AI's model of what the car can do. Rebuilt when conditions change
    // enough to matter — worn tires and rain both make it drive slower, because
    // its own speed target drops, not because anything is subtracted later.
    this.profile = new SpeedProfile(track, this._profileParams(LINE_RACING));
    this._profileLine = LINE_RACING;
    this._profileDirty = 0;

    this.line = LINE_RACING;
    this.lineBlend = 0;            // 0 = racing line, 1 = the chosen alternative
    this.targetLateral = 0;
    this.currentLateral = 0;

    // Smoothed control outputs — see the reaction model in `update`.
    this._appliedSteer = 0;
    this._appliedThrottle = 0;
    this._appliedBrake = 0;
    /** Rolling throttle trim from the driver's traction management. */
    this._tractionTrim = 1;
    /** Rolling brake trim from the driver's threshold braking. */
    this._brakeTrim = 1;
    this._recovering = false;
    this._recoverTimer = 0;
    this._recoverSteer = 1;
    this._nearAimDistance = 0;
    this._nearTargetLateral = 0;
    this._currentLateral = 0;
    this._trackLatX = 1;
    this._trackLatZ = 0;
    this._latDirScratch = new Vec3();
    this._lateralBias = 0;
    this._faProj = {};
    // Front axle in body coordinates — where the steering actually acts.
    this._frontAxleLocal = new Vec3(0, 0, vehicle.car.wheelbase * (1 - vehicle.car.frontWeightBias));

    // Mistakes
    this.mistake = null;
    this.mistakeTimer = 0;
    this.nextMistakeCheck = 2 + this.rng() * 6;
    this.pressure = 0;             // 0..1, from a car close behind

    // Strategy
    this.plannedStops = opts.plannedStops ?? 1;
    this.pitRequested = false;
    this.targetCompound = opts.compound ?? TireCompound.MEDIUM;
    this.stintStartLap = 0;

    // Tactical state
    this.targetCar = null;
    this.overtakeCommit = 0;       // 0..1 commitment to a passing move
    this.overtakeSide = 0;
    this.defendTimer = 0;
    this.lastGapAhead = Infinity;
    /** 0..1 fuel/tire saving, raised by the strategy check when needed. */
    this.savingMode = 0;

    // Speed-sensitive steering exists to make a stick or keyboard usable; it
    // scales down what a full deflection commands. The AI computes an exact
    // roadwheel angle, so applying it would simply stop the car turning enough
    // at speed.
    vehicle.assists.steeringSpeedSensitivity = 0;

    this.debug = {};
  }

  _profileParams(line) {
    const v = this.vehicle;
    const car = v.car;
    return {
      mass: car.dryMass + v.fuel,
      clA: v.aero.effectiveClA(),
      cdA: v.aero.effectiveCdA(),
      grip: v.wheels[0].tire.compound.peakGrip,
      powerKw: v.engine.peakPowerKw,
      maxSpeed: 98,
      cogHeight: car.cogHeight,
      trackWidth: (car.trackFront + car.trackRear) * 0.5,
      confidence: this.skill.confidence,
      line
    };
  }

  /**
   * Rebuild the speed target when the car's own capability has changed —
   * tires worn, fuel burnt off, rain arrived, damage taken.
   */
  _refreshProfile(env, line) {
    const v = this.vehicle;
    const tire = v.wheels[0].tire;

    // Grip the AI believes it has: compound peak, degraded by wear and by
    // being outside the temperature window, and cut hard in the wet.
    let grip = tire.compound.peakGrip * tire.wearGrip();
    grip *= lerp(1.0, tire.temperatureGrip(), 0.7);
    grip *= tire.wetnessGrip(env.wetness ?? 0, env.waterDepth ?? 0, 60);
    // Damage makes the car slower because the AI trusts it less and because
    // the aero really has gone.
    grip *= lerp(0.82, 1.0, v.damage.overall);

    this.profile.setParams({
      ...this._profileParams(line),
      grip,
      clA: v.aero.effectiveClA() * v.damage.frontWing,
      cdA: v.aero.effectiveCdA(),
      mass: v.car.dryMass + v.fuel,
      line
    });
    this._profileLine = line;
  }

  // -------------------------------------------------------------------------
  //  Main update
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt seconds
   * @param {object} ctx {
   *   env, raceState, progress (this car's {distance, lateral, lap}),
   *   cars: [{ id, vehicle, progress, racePosition }], phase
   * }
   */
  update(dt, ctx) {
    const v = this.vehicle;
    const c = v.controls;
    if (v.retired) {
      c.throttle = 0; c.brake = 1; c.steer = 0;
      return;
    }

    const env = ctx.env || {};
    const prog = ctx.progress;
    const distance = prog.distance;
    const speed = v.speed;

    // --- Recovery -----------------------------------------------------------
    // A spun or beached car has to get itself pointing the right way again
    // before any of the normal driving logic makes sense.
    if (this._updateRecovery(dt, ctx)) return;

    // --- Situation ----------------------------------------------------------
    const traffic = this._assessTraffic(ctx);
    this._chooseLine(dt, ctx, traffic, env);

    // Refresh the performance model periodically; it is not free and nothing
    // it depends on changes fast.
    this._profileDirty += dt;
    if (this._profileDirty > 1.6 || this._profileLine !== this.line) {
      this._profileDirty = 0;
      this._refreshProfile(env, this.line);
    }

    // --- Mistakes -----------------------------------------------------------
    this._updateMistakes(dt, ctx, traffic);

    // --- Lateral bias -------------------------------------------------------
    // Everything that shifts the car off its chosen line: avoiding a car
    // alongside, and the driver's own errors.
    this._lateralBias = this._avoidanceOffset(ctx, traffic, distance);
    if (this.mistake?.type === 'wideLine') this._lateralBias += this.mistake.amount;

    // --- Steering -----------------------------------------------------------
    const steer = this._computeSteering(distance, speed, ctx);

    // --- Speed target -------------------------------------------------------
    let { throttle, brake } = this._computeLongitudinal(dt, distance, speed, ctx, traffic, env);

    // --- Pit lane -----------------------------------------------------------
    if (v.inPitLane) {
      const limit = v.pitLimiterSpeed;
      c.pitLimiter = true;
      if (speed > limit * 0.98) { throttle = 0; brake = speed > limit * 1.04 ? 0.35 : 0; }
      else throttle = Math.min(throttle, 0.65);
    } else {
      c.pitLimiter = false;
    }

    // --- DRS ----------------------------------------------------------------
    // The AI uses DRS whenever it is legally available; the race director
    // decides whether it actually is.
    c.drs = v.drsAvailable && speed > 60 && !this.profile.isBrakingZone(distance + 40);

    // --- Reaction -----------------------------------------------------------
    // Modelled as neuromuscular lag — a first-order response toward the input
    // the driver wants — rather than a transport delay. A pure delay inside a
    // continuous steering loop is destabilising: the driver keeps applying
    // corrections for a situation that has already changed, and the car
    // oscillates itself off the road.
    //
    // Steering is tracked continuously and so responds faster than the pedals,
    // where the delay is genuinely a decision being made.
    const steerRate = 1 / Math.max(0.02, this.skill.reaction * 0.30);
    const pedalRate = 1 / Math.max(0.03, this.skill.reaction * 0.85);
    this._appliedSteer = damp(this._appliedSteer, steer, steerRate, dt);
    this._appliedThrottle = damp(this._appliedThrottle, throttle, pedalRate, dt);
    // Getting off the throttle and onto the brakes is quick; a driver does not
    // ease into an emergency stop.
    const brakeRate = brake > this._appliedBrake ? pedalRate * 2.4 : pedalRate;
    this._appliedBrake = damp(this._appliedBrake, brake, brakeRate, dt);

    c.throttle = clamp01(this._appliedThrottle);
    c.brake = clamp01(this._appliedBrake);
    c.steer = clamp(this._appliedSteer, -1, 1);

    this.debug.line = this.line;
    this.debug.targetSpeed = this._lastTargetSpeed;
    this.debug.gapAhead = traffic.gapAhead;
  }

  // -------------------------------------------------------------------------
  //  Steering
  // -------------------------------------------------------------------------

  /**
   * Pure-pursuit steering toward a point on the target line, corrected for the
   * car's own sideslip. The correction is what lets the AI catch a slide — the
   * same countersteer input a human would make, not an invisible stabiliser.
   */
  _computeSteering(distance, speed, ctx) {
    const v = this.vehicle;
    const body = v.body;

    // ----- Feedforward: what the line itself asks for ----------------------
    // Aim slightly ahead so the car turns in with the corner rather than after
    // it. The curvature comes from the speed profile, which already knows the
    // curvature of the chosen LINE rather than of the centreline.
    const previewTime = lerp(0.42, 0.26, this.skill.precision);
    const preview = distance + clamp(speed * previewTime, 4, 34);
    const kappa = this.profile.curvatureAt(preview);

    // Geometric angle for that curvature, plus the front slip angle the tires
    // must run at to generate the cornering force. At racing speeds the second
    // term is several times the first: leaving it out is why a purely geometric
    // controller quietly drifts wide out of every corner.
    const lateralDemand = speed * speed * kappa;
    let delta = Math.atan(v.car.wheelbase * kappa) +
                lateralDemand * UNDERSTEER_GRADIENT;

    // ----- Feedback: correct position and heading error --------------------
    // A Stanley-style controller measured at the front axle, which is where the
    // steering actually acts and which gives the loop natural damping.
    const fa = body.localToWorldPoint(this._frontAxleLocal, tmpVec());
    this.track.project(fa.x, fa.z, this._faProj);
    const faDist = this._faProj.distance;

    let targetLat = this.track.lineOffsetAt(faDist, this.line);
    if (this.lineBlend > 0 && this.line !== LINE_RACING) {
      targetLat = lerp(this.track.lineOffsetAt(faDist, LINE_RACING), targetLat, this.lineBlend);
    }
    targetLat += this._lateralBias;
    const halfWidth = this.track.widthAtDistance(faDist) * 0.5 - 1.25;
    targetLat = clamp(targetLat, -halfWidth, halfWidth);
    this.targetLateral = targetLat;

    // Positive error means the line is to the car's right, so steer right.
    const crossTrack = targetLat - this._faProj.lateral;
    // Positive heading error means the line points right of the car's nose.
    const lineHeading = this.track.lineHeadingAt(faDist, this.line);
    const headingError = wrapAngle(lineHeading - body.orientation.getYaw());

    const kHeading = lerp(0.55, 0.95, this.skill.precision);
    const kCross = lerp(2.2, 3.4, this.skill.precision);

    // Both feedback terms are BOUNDED. A car that has run wide can be fifteen
    // metres off its line, and an unbounded correction would then demand more
    // than fifty degrees of lock — far past the angle at which the front tires
    // stop producing more force. The car would saturate its fronts, understeer
    // harder, drift further off, and demand more lock still. Capping the
    // correction means a car that is off line rejoins over the next few car
    // lengths instead of throwing itself off the circuit trying to do it at once.
    const maxCorrection = v.car.maxSteerAngle * 0.62;
    const correction = kHeading * headingError +
                       Math.atan2(kCross * crossTrack, speed + 6.0);
    delta += clamp(correction, -maxCorrection, maxCorrection);

    // ----- Anti-spin -------------------------------------------------------
    //
    // In a right-hand turn the car's velocity sits slightly LEFT of its nose,
    // so the body slip angle is negative; if the rear steps out it becomes more
    // negative still. Catching that slide means steering left — a negative
    // contribution — so the correction ADDS the slip angle rather than
    // subtracting it.
    //
    // Gated on OVERSTEER: a car running wide under understeer also carries a
    // large body slip angle, but there countersteering would point the car
    // straight off the outside of the circuit.
    const lv = body.getLocalVelocity(tmpVec());
    const oversteer = v.telemetry.oversteer;
    if (Math.abs(lv.z) > 5 && oversteer > 0.22) {
      const bodySlip = Math.atan2(lv.x, Math.abs(lv.z));
      const DEADBAND = 0.10; // ~5.7 degrees
      const excess = Math.max(0, Math.abs(bodySlip) - DEADBAND) * Math.sign(bodySlip);
      const authority = clamp01((oversteer - 0.22) / 0.4);
      delta += excess * lerp(0.9, 2.2, this.skill.precision) * authority;
    }

    // ----- Front-axle slip limiter -----------------------------------------
    //
    // The most important stabiliser here. Past the peak of its curve a tire
    // produces LESS force the more it is asked for, so adding lock to a front
    // axle that has already let go makes the car run wider still — a runaway
    // that ends off the circuit or in a spin. A driver feels this through the
    // wheel and unwinds until the front bites again.
    const frontSlip = Math.max(
      v.wheels[0].tire.combinedSlip, v.wheels[1].tire.combinedSlip
    );
    //
    // It must NOT apply while catching a slide. During oversteer the front
    // tires are sliding too — the whole car is — but the answer there is more
    // lock, in the opposite direction. Capping against the small angle the car
    // happens to be carrying would latch the steering near zero and make the
    // spin unrecoverable.
    if (frontSlip > 1.05 && Math.abs(lv.z) > 6 && oversteer < 0.35) {
      // Cap against the lock the car is ALREADY carrying, and wind it back from
      // there. Scaling the demand instead would still leave a huge number huge.
      const over = clamp01((frontSlip - 1.05) / 0.7);
      const cap = Math.max(
        Math.abs(v.steerAngle) * lerp(1.0, 0.78, over),
        v.car.maxSteerAngle * 0.22
      );
      delta = clamp(delta, -cap, cap);
    }

    // A driver cannot resolve steering more finely than their own precision.
    delta += (1 - this.skill.precision) * 0.015 * (this.rng() - 0.5);

    return clamp(delta / v.car.maxSteerAngle, -1, 1);
  }

  // -------------------------------------------------------------------------
  //  Throttle and brake
  // -------------------------------------------------------------------------

  /**
   * Decide throttle and brake from the speed the car will need shortly, not the
   * speed it needs now. The braking point emerges from comparing the distance
   * available with the distance required at the car's real deceleration.
   */
  _computeLongitudinal(dt, distance, speed, ctx, traffic, env) {
    const v = this.vehicle;
    const g = 9.80665;

    // Deceleration the car can actually achieve here, including downforce and
    // the tires' own load sensitivity — mu falls as downforce piles load on.
    const down = 0.5 * (env.airDensity ?? 1.225) * v.aero.effectiveClA() * speed * speed;
    const mass = v.body.mass;
    const totalLoad = mass * g + down;
    const loadRatio = clamp(totalLoad / 4 / 3400, 0.05, 4);
    const grip = this.profile.params.grip *
                 clamp(1 - 0.160 * (loadRatio - 1), 0.55, 1.35) *
                 this.skill.confidence * 0.90;
    const maxDecel = (grip * totalLoad) / mass;

    // How much of that the driver is willing to commit. Leaving margin is what
    // lets them still steer while braking, and a less precise driver leaves
    // more of it — which is exactly why they brake earlier and lap slower.
    // Measured against the car's real stopping performance, so the margin here
    // is genuine margin rather than wishful thinking.
    let aBrake = maxDecel * lerp(0.55, 0.76, this.skill.precision);
    if (this.mistake?.type === 'lateBrake') aBrake *= this.mistake.amount;
    if (this.mistake?.type === 'earlyBrake') aBrake /= this.mistake.amount;
    aBrake = Math.max(3, aBrake);

    // ----- The binding speed limit -----------------------------------------
    //
    // For every point ahead, the fastest the car can be going HERE and still
    // reach that point at its target speed is sqrt(v_target^2 + 2 a d). The
    // lowest of those is the limit right now, and the braking point falls out
    // of it rather than being decided separately.
    //
    // Expressing the whole problem as one speed limit — rather than a braking
    // "demand" measured against a separately maintained deceleration model —
    // keeps the controller self-consistent with the profile it is tracking.
    let vLimit = this.profile.speedAt(distance);
    const scan = clamp(speed * speed / (2 * aBrake) * 1.3 + 25, 40, 460);
    for (let d = 6; d <= scan; d += 6) {
      const vt = this.profile.speedAt(distance + d);
      if (vt >= vLimit) continue;
      const allowed = Math.sqrt(vt * vt + 2 * aBrake * d);
      if (allowed < vLimit) vLimit = allowed;
    }

    // ----- Traffic ----------------------------------------------------------
    // A car ahead is just another speed limit, placed at its own gap.
    if (traffic.ahead) {
      const gap = Math.max(2.0, traffic.gapAhead - 6.5);
      // Committed to a pass? Then run right up to them and use the braking
      // zone; otherwise leave room and protect the front tires in their wake.
      const commit = this.overtakeCommit > 0.4;
      const followSpeed = traffic.ahead.speed + (commit ? 1.5 : 0);
      const allowed = Math.sqrt(
        followSpeed * followSpeed + 2 * aBrake * (commit ? 0.95 : 0.7) * gap
      );
      if (allowed < vLimit) vLimit = allowed;
      // Do not sit in the very worst of the dirty air unless passing.
      if (traffic.gapAhead < 7 && !commit) {
        vLimit = Math.min(vLimit, traffic.ahead.speed * 0.97);
      }
    }

    // Aim just under the limit. Arriving at turn-in still braking means the
    // front tires have no grip left to turn with, and the car goes straight on.
    vLimit *= lerp(0.955, 0.985, this.skill.precision);
    this._lastTargetSpeed = vLimit;

    // ----- Pedals -----------------------------------------------------------
    const error = vLimit - speed;
    let throttle = 0;
    let brake = 0;

    if (error < -0.25) {
      // Full pedal at ~3 m/s over the limit; proportional below that.
      brake = clamp01(-error / 3.0);
      // Trail braking: bleed the brakes off as the car is turned IN, so the
      // front tires have grip left for the corner.
      //
      // Keyed on the curvature under the car right now, not on the curvature
      // ahead. Looking ahead means the release starts while the car is still
      // braking in a straight line, which throws away a third of the stopping
      // power exactly where all of it is needed.
      const k = Math.abs(this.profile.curvatureAt(distance));
      if (k > 0.004) {
        brake *= lerp(1.0, 0.45, clamp01((k - 0.004) * 110) * this.skill.precision);
      }
      // ----- Brake modulation ---------------------------------------------
      //
      // Threshold braking, as a driver does it with their foot. Without it the
      // AI simply stands on the pedal, locks the fronts, and gets about 1.2 g
      // out of a car capable of over 4 — while also losing every bit of
      // steering authority exactly where it needs to turn in.
      //
      // An integrator rather than a gate, for the same reason as the traction
      // trim: it has to hold a modulated pedal position, not flick on and off.
      const frontSlip = Math.max(
        v.wheels[0].tire.combinedSlip, v.wheels[1].tire.combinedSlip
      );
      if (speed > 6) {
        const TARGET_BRAKE_SLIP = 1.22;   // just past the peak, where force is still ~97%
        if (frontSlip > TARGET_BRAKE_SLIP) {
          const excess = clamp01((frontSlip - TARGET_BRAKE_SLIP) / 2.0);
          this._brakeTrim -= dt * (1.1 + 3.2 * excess);
        } else {
          this._brakeTrim += dt * 2.6;
        }
        // A less precise driver both locks up more and recovers more slowly.
        this._brakeTrim = clamp(this._brakeTrim, lerp(0.42, 0.55, this.skill.precision), 1);
        brake *= lerp(1.0, this._brakeTrim, lerp(0.55, 1.0, this.skill.precision));
      } else {
        this._brakeTrim = Math.min(1, this._brakeTrim + dt * 3);
      }
    } else {
      // Well below the limit: full throttle. Close to it: feather, so the car
      // settles at the limit instead of sawing at it.
      throttle = clamp01(error * 0.55 + 0.12);
    }

    // ----- Feedforward traction limit --------------------------------------
    //
    // Work out, before touching the pedal, how much engine torque the rear
    // tires can actually take in the gear the car is in, and cap the throttle
    // there. This is the experience a driver has of their own car: in first
    // gear the drivetrain multiplies torque by nearly sixteen, so even half
    // throttle at a corner exit asks the rears for far more than they have.
    //
    // Feedback alone cannot cover this. By the time the wheels have spun up
    // enough for the trim below to notice, the car is already sideways.
    if (speed > 4 && throttle > 0) {
      const rearLoad = v.wheels[2].load + v.wheels[3].load;
      if (rearLoad > 200) {
        const rearRatio = clamp(rearLoad / 2 / 3400, 0.05, 4);
        const rearMu = this.profile.params.grip *
                       clamp(1 - 0.160 * (rearRatio - 1), 0.55, 1.35);
        // Lateral force already being used leaves less for driving out.
        // Compare like with like: only the REAR axle's share of the car's
        // cornering force competes with the rear tires' drive. Comparing the
        // whole car's lateral force against the rear axle alone reads as fully
        // saturated at barely 1 g, which pins the throttle at its floor through
        // every corner exit on the circuit.
        const rearLateralForce =
          mass * Math.abs(v.telemetry.lateralG) * 9.80665 * (1 - v.car.frontWeightBias);
        const latUse = clamp01(rearLateralForce / Math.max(1, rearMu * rearLoad));
        const longFrac = Math.sqrt(Math.max(0.05, 1 - latUse * latUse));
        const maxDriveForce = rearMu * rearLoad * longFrac;
        const ratio = Math.abs(v.transmission.ratio) * v.transmission.efficiency;
        if (ratio > 0.1) {
          const maxEngineTorque =
            (maxDriveForce * v.car.wheelRadiusRear) / ratio;
          const available = v.engine.torqueAt(v.rpm);
          if (available > 1) {
            // A less precise driver overshoots the limit and lights up the rears.
            const overshoot = lerp(1.40, 1.04, this.skill.precision);
            const cap = clamp01((maxEngineTorque / available) * overshoot);
            throttle = Math.min(throttle, Math.max(cap, 0.06));
          }
        }
      }
    }

    // ----- Traction management ---------------------------------------------
    // A driver feeling the rear axle and modulating the pedal. This is an
    // integrator, not a gate: it eases off while the rears are spinning and
    // feeds back in as they hook up, settling near the slip ratio that actually
    // produces the most drive.
    const rearSlip = Math.max(v.wheels[2].slipRatio, v.wheels[3].slipRatio);
    const TARGET_SLIP = 0.20;
    if (speed < 7) {
      // Below walking pace the slip ratio is meaningless: it is divided by a
      // road speed of nearly zero, so any wheel rotation reads as enormous
      // wheelspin and the throttle would pin at its floor forever.
      this._tractionTrim = Math.min(1, this._tractionTrim + dt * 2.5);
    } else if (rearSlip > TARGET_SLIP) {
      const excess = clamp01((rearSlip - TARGET_SLIP) / 0.45);
      this._tractionTrim -= dt * (1.6 + 4.0 * excess);
    } else {
      this._tractionTrim += dt * 1.4;
    }
    const floor = lerp(0.30, 0.14, this.skill.precision);
    this._tractionTrim = clamp(this._tractionTrim, floor, 1);
    throttle *= this._tractionTrim;

    // Understeering into a corner with the throttle open loads the rear and
    // unloads the already-saturated front. Lift instead — which is also what
    // rotates the car back toward the apex.
    if (v.telemetry.understeer > 0.5 && speed > 15) {
      const wash = clamp01((v.telemetry.understeer - 0.5) / 0.5);
      throttle *= lerp(1.0, 0.35, wash * lerp(0.5, 1.0, this.skill.precision));
    }
    // Same for oversteer: a sliding car gets less throttle from a good driver.
    if (v.telemetry.oversteer > 0.45 && speed > 15) {
      throttle *= lerp(1.0, 0.55, (v.telemetry.oversteer - 0.45) / 0.55 * this.skill.precision);
    }
    if (this.mistake?.type === 'throttleSnap') throttle = Math.min(1, throttle * this.mistake.amount);

    // Fuel and tire saving when the race situation allows it.
    if (this.savingMode > 0) throttle *= lerp(1.0, 0.86, this.savingMode);

    return { throttle, brake };
  }

  // -------------------------------------------------------------------------
  //  Traffic assessment
  // -------------------------------------------------------------------------

  _assessTraffic(ctx) {
    const me = ctx.progress;
    const myV = this.vehicle;
    const L = this.track.length;

    let ahead = null, aheadGap = Infinity;
    let behind = null, behindGap = Infinity;
    const alongside = [];

    for (const other of ctx.cars) {
      if (other.id === this.id) continue;
      const ov = other.vehicle;
      if (!ov || ov.retired) continue;

      const delta = circularDelta(me.distance, other.progress.distance, L);
      const lateralDelta = other.progress.lateral - me.lateral;

      if (delta > 0 && delta < aheadGap) {
        aheadGap = delta;
        ahead = { id: other.id, vehicle: ov, speed: ov.speed, gap: delta,
                  lateral: other.progress.lateral, lateralDelta };
      }
      if (delta < 0 && -delta < behindGap) {
        behindGap = -delta;
        behind = { id: other.id, vehicle: ov, speed: ov.speed, gap: -delta,
                   lateral: other.progress.lateral, lateralDelta };
      }
      // Side by side: within a car length longitudinally and close laterally.
      if (Math.abs(delta) < 5.4 && Math.abs(lateralDelta) < 5.0) {
        alongside.push({ id: other.id, vehicle: ov, delta, lateralDelta });
      }
    }

    return {
      ahead, behind, alongside,
      gapAhead: ahead ? aheadGap : Infinity,
      gapBehind: behind ? behindGap : Infinity
    };
  }

  /** Lateral shift to keep clear of a car occupying the same piece of road. */
  _avoidanceOffset(ctx, traffic, aimDistance) {
    let offset = 0;
    for (const other of traffic.alongside) {
      // Push away from them, harder the closer they are.
      const d = other.lateralDelta;
      const urgency = 1 - clamp01(Math.abs(d) / 5.0);
      offset -= Math.sign(d || 1) * urgency * 2.6;
    }
    // Do not drive into the back of a car directly ahead — step aside early.
    if (traffic.ahead && traffic.gapAhead < 26) {
      const closing = this.vehicle.speed - traffic.ahead.speed;
      if (closing > 1.5) {
        const urgency = (1 - clamp01(traffic.gapAhead / 26)) * clamp01(closing / 12);
        const side = this.overtakeSide !== 0
          ? this.overtakeSide
          : -Math.sign(traffic.ahead.lateralDelta || 1);
        offset += side * urgency * 3.4;
      }
    }
    return clamp(offset, -6, 6);
  }

  // -------------------------------------------------------------------------
  //  Line selection: attack, defend, or drive the racing line
  // -------------------------------------------------------------------------

  _chooseLine(dt, ctx, traffic, env) {
    const v = this.vehicle;
    const distance = ctx.progress.distance;

    // Wet conditions move everyone off the rubbered-in dry line.
    if ((env.wetness ?? 0) > 0.32) {
      this.line = LINE_WET;
      this.lineBlend = clamp01(this.lineBlend + dt * 1.5);
      this.overtakeCommit = Math.max(0, this.overtakeCommit - dt);
      return;
    }

    // Pressure from behind builds the case for defending.
    const targetPressure = traffic.behind && traffic.gapBehind < 24
      ? 1 - clamp01(traffic.gapBehind / 24)
      : 0;
    this.pressure = lerp(this.pressure, targetPressure, clamp01(dt * 2));

    // --- Attack -------------------------------------------------------------
    // Commit to a pass only when there is a real chance: close enough, quicker,
    // and approaching somewhere a pass is actually possible.
    let wantOvertake = false;
    if (traffic.ahead && traffic.gapAhead < 34) {
      const closing = v.speed - traffic.ahead.speed;
      const nearBraking = this._brakingZoneWithin(distance, 190);
      const hasDrs = v.drsActive;
      const worthIt = closing > 0.6 || hasDrs || traffic.gapAhead < 12;
      if (worthIt && (nearBraking || hasDrs)) {
        wantOvertake = this.rng() < 0.5 + this.skill.aggression * 0.5 || this.overtakeCommit > 0;
      }
    }

    if (wantOvertake) {
      this.overtakeCommit = clamp01(this.overtakeCommit + dt * (0.6 + this.skill.aggression));
      if (this.overtakeSide === 0 && traffic.ahead) {
        // Go to whichever side has more room, preferring the inside for the
        // upcoming corner.
        const k = this.track.curvatureAtDistance(distance + 90);
        const inside = Math.sign(k) || (this.rng() < 0.5 ? -1 : 1);
        const theirSide = Math.sign(traffic.ahead.lateral || 0);
        this.overtakeSide = (theirSide !== 0 && theirSide === inside) ? -inside : inside;
      }
      this.line = LINE_OVERTAKE;
      this.lineBlend = clamp01(this.lineBlend + dt * 2.2);
      this.defendTimer = 0;
      return;
    }

    this.overtakeCommit = Math.max(0, this.overtakeCommit - dt * 0.7);
    if (this.overtakeCommit <= 0) this.overtakeSide = 0;

    // --- Defend -------------------------------------------------------------
    // Move to the inside on the approach to a braking zone. Only once per
    // approach — weaving is both unsporting and slow.
    if (this.pressure > 0.45 && this._brakingZoneWithin(distance, 150)) {
      this.defendTimer += dt;
      if (this.defendTimer < 4.5) {
        this.line = LINE_DEFENSIVE;
        this.lineBlend = clamp01(this.lineBlend + dt * 1.8);
        return;
      }
    } else {
      this.defendTimer = Math.max(0, this.defendTimer - dt * 0.5);
    }

    this.line = LINE_RACING;
    this.lineBlend = Math.max(0, this.lineBlend - dt * 1.6);
  }

  /**
   * Spin and beaching recovery.
   *
   * Returns true when it has taken control of the car. A spun car reverses to
   * straighten up and only then rejoins; the time this costs is real, which is
   * exactly the point — spinning has to be expensive.
   */
  _updateRecovery(dt, ctx) {
    const v = this.vehicle;
    const c = v.controls;
    const trackHeading = this.track.headingAtDistance(ctx.progress.distance);
    let yawErr = v.yaw - trackHeading;
    yawErr = ((yawErr + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const facingWrongWay = Math.abs(yawErr) > 1.75;   // > 100 degrees
    const crawling = v.speed < 6;

    if (this._recovering) {
      this._recoverTimer += dt;
      const done = (!facingWrongWay && v.speed > 2) || this._recoverTimer > 9;
      if (done) {
        this._recovering = false;
        c.requestGear = 1;
        return false;
      }
    } else if (facingWrongWay && crawling) {
      this._recovering = true;
      this._recoverTimer = 0;
      // Reverse out toward whichever way needs less rotation.
      this._recoverSteer = Math.sign(yawErr) || 1;
    } else {
      return false;
    }

    // Select reverse and back up, steering so the nose swings round.
    c.requestGear = 0;
    c.throttle = 0.42;
    c.brake = 0;
    c.drs = false;
    // In reverse the steering acts the other way round.
    c.steer = clamp(-this._recoverSteer * 0.9, -1, 1);
    this._appliedSteer = c.steer;
    this._appliedThrottle = c.throttle;
    this._appliedBrake = 0;
    return true;
  }

  _brakingZoneWithin(distance, range) {
    for (let d = 0; d < range; d += 8) {
      if (this.profile.isBrakingZone(distance + d)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  //  Mistakes
  // -------------------------------------------------------------------------

  /**
   * Drivers make mistakes, and more of them under pressure. Each mistake is an
   * error in a real control input, so it produces a real consequence — a lockup,
   * a wide exit, a snap of oversteer — rather than a scripted time loss.
   */
  _updateMistakes(dt, ctx, traffic) {
    if (this.mistakeTimer > 0) {
      this.mistakeTimer -= dt;
      if (this.mistakeTimer <= 0) this.mistake = null;
      return;
    }
    this.nextMistakeCheck -= dt;
    if (this.nextMistakeCheck > 0) return;
    this.nextMistakeCheck = 3.5 + this.rng() * 7;

    // Base rate from consistency, amplified by pressure, worn tires and rain.
    const v = this.vehicle;
    let rate = (1 - this.skill.consistency) * 0.22;
    rate *= 1 + this.pressure * 0.9;
    rate *= 1 + (1 - v.tireCondition) * 0.7;
    rate *= 1 + clamp01(ctx.env?.wetness ?? 0) * 1.1;
    if (v.damage.overall < 0.8) rate *= 1.3;

    if (this.rng() > rate) return;

    const roll = this.rng();
    if (roll < 0.34) {
      this.mistake = { type: 'lateBrake', amount: 0.80 + this.rng() * 0.12 };
      this.mistakeTimer = 0.9 + this.rng() * 0.8;
    } else if (roll < 0.56) {
      this.mistake = { type: 'earlyBrake', amount: 1.16 + this.rng() * 0.16 };
      this.mistakeTimer = 1.0 + this.rng();
    } else if (roll < 0.82) {
      this.mistake = { type: 'wideLine', amount: (this.rng() < 0.5 ? -1 : 1) * (1.2 + this.rng() * 2.2) };
      this.mistakeTimer = 1.4 + this.rng() * 1.4;
    } else {
      this.mistake = { type: 'throttleSnap', amount: 1.28 + this.rng() * 0.3 };
      this.mistakeTimer = 0.5 + this.rng() * 0.6;
    }
  }

  // -------------------------------------------------------------------------
  //  Strategy
  // -------------------------------------------------------------------------

  /**
   * Decide whether to pit. Called once per lap by the race director.
   * @returns {{pit:boolean, compound:string, reason:string}}
   */
  considerPitStop(raceState, myEntry) {
    const v = this.vehicle;
    const lapsLeft = raceState.totalLaps - myEntry.lap;
    const wear = 1 - v.tireCondition;
    const wet = (raceState.weather?.wetness ?? 0);
    const currentCompound = v.compound;

    // Weather changes force a stop regardless of tire life.
    const onWets = currentCompound === TireCompound.WET ||
                   currentCompound === TireCompound.INTERMEDIATE;
    if (wet > 0.55 && !onWets) {
      return { pit: true, compound: TireCompound.WET, reason: 'rain' };
    }
    if (wet > 0.22 && wet <= 0.55 && !onWets) {
      return { pit: true, compound: TireCompound.INTERMEDIATE, reason: 'rain' };
    }
    if (wet < 0.10 && onWets && lapsLeft > 3) {
      return { pit: true, compound: TireCompound.MEDIUM, reason: 'track drying' };
    }

    // Damage bad enough to be costing real lap time.
    if (v.damage.frontWing < 0.45 && lapsLeft > 2) {
      return { pit: true, compound: currentCompound, reason: 'damage' };
    }

    if (lapsLeft <= 1) return { pit: false };

    // Tire life. Pit near the cliff, and never so late that the last stint
    // cannot reach the end.
    const cliff = v.wheels[0].tire.compound.cliffStart;
    const willingness = 0.82 + this.skill.aggression * 0.10;
    if (wear > cliff * willingness) {
      // Choose a compound that can go the distance.
      const compound = lapsLeft > 22 ? TireCompound.HARD
                     : lapsLeft > 12 ? TireCompound.MEDIUM
                     : TireCompound.SOFT;
      return { pit: true, compound, reason: 'tires' };
    }

    // Out of fuel to finish? Lift and coast rather than stopping.
    const fuelPerLap = v.car.fuelPerLap;
    const needed = lapsLeft * fuelPerLap;
    this.savingMode = v.fuel < needed ? clamp01((needed - v.fuel) / (fuelPerLap * 2)) : 0;

    return { pit: false };
  }

  reset() {
    this._appliedSteer = 0;
    this._appliedThrottle = 0;
    this._appliedBrake = 0;
    this._tractionTrim = 1;
    this._brakeTrim = 1;
    this.mistake = null;
    this.mistakeTimer = 0;
    this.overtakeCommit = 0;
    this.overtakeSide = 0;
    this.line = LINE_RACING;
    this.lineBlend = 0;
    this.savingMode = 0;
  }
}
