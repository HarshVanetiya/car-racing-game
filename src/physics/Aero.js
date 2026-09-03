import { Vec3, tmpVec } from '../math/Vec3.js';
import { clamp, clamp01, lerp, smoothstep } from '../math/MathUtils.js';

export const AIR_DENSITY_SEA_LEVEL = 1.225; // kg/m^3

/**
 * ============================================================================
 *  AERODYNAMICS
 * ============================================================================
 *
 * Downforce and drag both scale with the square of airspeed, and the two are
 * inseparable: every unit of cornering grip bought with wing costs straight-line
 * speed. Front and rear downforce are applied at their own centres of pressure,
 * at the axles, so aero balance is not a handling "setting" — it is literally
 * where the load lands.
 *
 * Three wake effects sit on top:
 *   - SLIPSTREAM  : less drag behind another car     -> more straight-line speed
 *   - DIRTY AIR   : less downforce behind another car -> less cornering grip
 *   - DRS         : less rear drag AND less rear downforce when deployed
 *
 * Slipstream and dirty air are the same physical wake seen from two sides, which
 * is why following closely is a genuine trade rather than a free boost.
 */
export class Aero {
  constructor(config = {}) {
    // Total downforce coefficient x reference area (Cl * A).
    this.clA = config.clA ?? 4.10;
    // Total drag coefficient x reference area (Cd * A).
    this.cdA = config.cdA ?? 1.30;

    // Fraction of total downforce carried by the front axle. Moving this
    // forward sharpens turn-in and loosens the rear; moving it back does the
    // opposite. It is the single most powerful setup lever on the car.
    this.balance = clamp(config.balance ?? 0.435, 0.34, 0.54);

    // Wing settings, 1..11 in the setup screen. These scale clA and cdA.
    this.frontWing = config.frontWing ?? 6;
    this.rearWing = config.rearWing ?? 6;

    // DRS: how much drag the open flap removes, and how much rear load goes
    // with it. Losing rear load is the reason DRS is not free in a corner.
    this.drsDragReduction = config.drsDragReduction ?? 0.150; // absolute CdA
    this.drsDownforceLoss = config.drsDownforceLoss ?? 0.255; // fraction of rear
    this.drsOpen = false;
    this.drsTransition = 0;   // 0..1, the flap takes a moment to actuate

    // Ground effect: the floor is far more efficient close to the road, so ride
    // height is a real performance lever and bottoming out costs downforce.
    this.rideHeightSensitivity = config.rideHeightSensitivity ?? 0.85;
    this.referenceRideHeight = config.referenceRideHeight ?? 0.052;

    this.airDensity = config.airDensity ?? AIR_DENSITY_SEA_LEVEL;

    // Wake state, refreshed each step by `applyWake`.
    this.slipstream = 0;       // 0..1 drag relief
    this.dirtyAir = 0;         // 0..1 downforce loss
    this.wakeSource = null;    // id of the car generating the wake

    // Damage multipliers, driven by the damage model.
    this.frontWingHealth = 1;
    this.rearWingHealth = 1;
    this.floorHealth = 1;

    // Outputs
    this.downforceFront = 0;
    this.downforceRear = 0;
    this.drag = 0;
    this.lastAirspeed = 0;
  }

  /** Wing scaling: setting 1 is a skinny Monza wing, 11 is maximum load. */
  wingScale(setting) {
    return lerp(0.72, 1.24, clamp01((setting - 1) / 10));
  }

  /** Effective Cl*A after wings, damage and DRS. */
  effectiveClA() {
    const fs = this.wingScale(this.frontWing);
    const rs = this.wingScale(this.rearWing);
    // Blend the wing settings by the aero balance so both ends contribute.
    const scale = fs * this.balance + rs * (1 - this.balance);
    return this.clA * scale;
  }

  effectiveCdA() {
    const fs = this.wingScale(this.frontWing);
    const rs = this.wingScale(this.rearWing);
    const scale = fs * 0.40 + rs * 0.60;
    let cd = this.cdA * scale;
    // A damaged wing sheds downforce but *adds* drag — a broken front wing is
    // slow in a straight line as well as in the corners.
    cd += (1 - this.frontWingHealth) * 0.22;
    cd += (1 - this.rearWingHealth) * 0.16;
    return cd;
  }

  /**
   * Ground-effect efficiency from the current front ride height.
   * Running the car lower recovers downforce, but there is a floor: once it
   * touches down the seal is lost and the load goes away.
   */
  groundEffect(rideHeight) {
    const h = Math.max(0.001, rideHeight);
    const ref = this.referenceRideHeight;
    if (h <= ref) {
      // Below the reference the floor starts to stall as it seals against the road.
      const t = clamp01(h / ref);
      return lerp(0.80, 1.0, t);
    }
    const excess = (h - ref) / 0.075;
    return clamp(1.0 / (1.0 + excess * this.rideHeightSensitivity), 0.45, 1.0);
  }

  /** Progress the DRS flap actuation. */
  update(dt, drsRequested, drsAllowed) {
    const shouldOpen = drsRequested && drsAllowed;
    this.drsOpen = shouldOpen;
    const rate = dt / 0.16; // ~160 ms to open or close
    this.drsTransition += clamp(
      (shouldOpen ? 1 : 0) - this.drsTransition, -rate, rate
    );
    this.drsTransition = clamp01(this.drsTransition);
  }

  /**
   * Compute aerodynamic forces.
   *
   * @param {number} airspeed    speed through the air along the car's heading (m/s)
   * @param {number} rideHeight  front floor height above the road (m)
   * @param {number} yawAngle    sideslip angle (rad) — a sliding car loses load
   * @returns {{downforceFront:number, downforceRear:number, drag:number}}
   */
  computeForces(airspeed, rideHeight, yawAngle = 0) {
    const v = Math.max(0, airspeed);
    const q = 0.5 * this.airDensity * v * v; // dynamic pressure
    this.lastAirspeed = v;

    let clA = this.effectiveClA() * this.groundEffect(rideHeight);
    let cdA = this.effectiveCdA();

    // Sideslip spoils the aero platform: a car pointing 15 degrees away from
    // where it is travelling has stalled much of its floor.
    const yawLoss = 1 - clamp01(Math.abs(yawAngle) / 0.45) * 0.42;
    clA *= yawLoss;
    // ...and picks up drag doing it.
    cdA *= 1 + clamp01(Math.abs(yawAngle) / 0.45) * 0.55;

    // Dirty air removes downforce. It hurts the front wing far more than the
    // rear because the front wing is the first thing into the disturbed flow —
    // this is precisely why following through a fast corner produces understeer.
    const dirty = clamp01(this.dirtyAir);
    const frontLoss = 1 - dirty * 0.38;
    const rearLoss = 1 - dirty * 0.17;

    let dfFront = q * clA * this.balance * frontLoss * this.frontWingHealth * this.floorHealth;
    let dfRear = q * clA * (1 - this.balance) * rearLoss * this.rearWingHealth * this.floorHealth;

    // DRS: opening the flap unloads the rear wing and removes its drag.
    const drs = this.drsTransition;
    if (drs > 0) {
      dfRear *= 1 - this.drsDownforceLoss * drs;
      cdA -= this.drsDragReduction * this.wingScale(this.rearWing) * drs;
    }

    // Slipstream: sitting in another car's wake means less air to push aside.
    cdA *= 1 - clamp01(this.slipstream) * 0.36;

    this.downforceFront = dfFront;
    this.downforceRear = dfRear;
    this.drag = q * Math.max(0.15, cdA);

    return {
      downforceFront: this.downforceFront,
      downforceRear: this.downforceRear,
      drag: this.drag
    };
  }

  get totalDownforce() {
    return this.downforceFront + this.downforceRear;
  }

  /** Downforce in "car weights" — the number that makes aero intuitive. */
  downforceInG(mass) {
    return this.totalDownforce / (mass * 9.80665);
  }

  reset() {
    this.drsOpen = false;
    this.drsTransition = 0;
    this.slipstream = 0;
    this.dirtyAir = 0;
    this.frontWingHealth = 1;
    this.rearWingHealth = 1;
    this.floorHealth = 1;
  }
}

// ---------------------------------------------------------------------------
//  Wake solver
// ---------------------------------------------------------------------------

/** Longitudinal reach of a car's wake (m). */
const WAKE_LENGTH = 52;
/** Distance at which the wake is at full strength (m). */
const WAKE_CORE = 6;
/** Half-width of the wake at the leading car (m); it fans out behind. */
const WAKE_BASE_HALF_WIDTH = 1.5;
const WAKE_SPREAD = 0.075;

/**
 * Compute the slipstream and dirty-air experienced by every car from every
 * other car's wake.
 *
 * This runs once per physics step over the whole field rather than per car, so
 * the effect is symmetric and consistent: the car generating the wake and the
 * car sitting in it always agree about it.
 *
 * @param {Array} cars objects exposing { id, body, aero, speed }
 */
export function solveWakes(cars) {
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c || !c.aero) continue;
    c.aero.slipstream = 0;
    c.aero.dirtyAir = 0;
    c.aero.wakeSource = null;
  }

  const delta = new Vec3();

  for (let i = 0; i < cars.length; i++) {
    const lead = cars[i];
    if (!lead || !lead.aero || lead.retired) continue;
    const leadSpeed = lead.body.speed;
    // A slow or stationary car makes no meaningful wake.
    if (leadSpeed < 12) continue;

    for (let j = 0; j < cars.length; j++) {
      if (i === j) continue;
      const follow = cars[j];
      if (!follow || !follow.aero || follow.retired) continue;

      delta.subVectors(follow.body.position, lead.body.position);

      // Distance behind the leading car, measured along ITS heading.
      const behind = -delta.dot(lead.body.forward);
      if (behind <= 0.5 || behind > WAKE_LENGTH) continue;

      // Vertical separation rules out cars on a different part of the circuit.
      if (Math.abs(delta.y) > 4.0) continue;

      const lateral = Math.abs(delta.dot(lead.body.right));
      const halfWidth = WAKE_BASE_HALF_WIDTH + behind * WAKE_SPREAD;
      if (lateral > halfWidth * 1.9) continue;

      // Both cars must be travelling the same way — this stops a car on the
      // opposite side of the circuit from handing out a tow.
      const headingAlignment = follow.body.forward.dot(lead.body.forward);
      if (headingAlignment < 0.55) continue;

      // Longitudinal profile: full strength in the core, fading to nothing at
      // the end of the wake.
      let axial;
      if (behind <= WAKE_CORE) {
        axial = 1.0;
      } else {
        axial = 1 - smoothstep(WAKE_CORE, WAKE_LENGTH, behind);
      }

      // Lateral profile: strongest directly behind, gone at the wake edge.
      const lateralFactor = 1 - smoothstep(halfWidth * 0.45, halfWidth * 1.9, lateral);

      // The wake only carries energy if the leading car is actually pushing air.
      const speedFactor = clamp01((leadSpeed - 12) / 45);

      const strength = axial * lateralFactor * headingAlignment * speedFactor;
      if (strength <= 0.001) continue;

      // Slipstream (drag relief) is strongest in the near wake and needs the
      // follower to be genuinely close.
      const draft = strength * clamp01(1.15 - behind / WAKE_LENGTH);
      if (draft > follow.aero.slipstream) {
        follow.aero.slipstream = clamp01(draft);
        follow.aero.wakeSource = lead.id;
      }

      // Dirty air decays faster than the tow: by ~25 m the drag benefit is
      // still worthwhile while the downforce loss has largely gone.
      const dirty = strength * (1 - smoothstep(4, 28, behind)) * 0.92;
      if (dirty > follow.aero.dirtyAir) {
        follow.aero.dirtyAir = clamp01(dirty);
      }
    }
  }
}
