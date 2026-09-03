import { clamp, clamp01, lerp } from '../math/MathUtils.js';

export const RPM_TO_RADS = Math.PI / 30;
export const RADS_TO_RPM = 30 / Math.PI;

/**
 * Naturally-aspirated-feeling hybrid V6 in the modern formula idiom.
 *
 * Power is *derived* from the torque curve rather than declared, so the driver
 * experiences a real power band: short-shifting out of the peak genuinely costs
 * acceleration, and holding a gear past peak power does too.
 */
export class Engine {
  constructor(config = {}) {
    this.idleRpm = config.idleRpm ?? 4200;
    this.maxRpm = config.maxRpm ?? 15000;
    this.limiterRpm = config.limiterRpm ?? 14800;
    this.stallRpm = config.stallRpm ?? 2600;

    // [rpm, torque Nm] — monotone in rpm.
    this.torqueCurve = config.torqueCurve ?? [
      [0, 150], [3000, 340], [5000, 450], [7000, 530], [9000, 590],
      [10000, 615], [11000, 605], [12000, 585], [13000, 545],
      [14000, 490], [15000, 420]
    ];

    // Rotational inertia of crank + flywheel + clutch (kg m^2). Small on a
    // formula car, which is why the revs fall away so fast off throttle.
    this.inertia = config.inertia ?? 0.24;

    // Engine braking: pumping and friction losses, scaled with rpm.
    this.engineBrakingCoeff = config.engineBrakingCoeff ?? 0.0165;
    this.engineBrakingBase = config.engineBrakingBase ?? 22;

    // Throttle actuation lag (s to move 0 -> 1).
    this.throttleLag = config.throttleLag ?? 0.045;

    // Fuel use: kg per Joule of crank work, plus idle consumption in kg/s.
    // Calibrated so a racing lap of the circuit burns ~2 kg, which is what
    // makes fuel saving a real strategic lever rather than a rounding error.
    this.fuelPerJoule = config.fuelPerJoule ?? 6.4e-8;
    this.idleFuelRate = config.idleFuelRate ?? 0.0016;

    this.rpm = this.idleRpm;
    this.throttle = 0;          // actual (lagged) throttle position
    this.targetThrottle = 0;
    this.limiterActive = false;
    this._limiterTimer = 0;
    this.outputTorque = 0;
    this.fuelUsedThisStep = 0;
    this.powerKw = 0;
    this.healthFactor = 1;      // reduced by engine damage
  }

  /** Interpolated wide-open-throttle torque at a given rpm. */
  torqueAt(rpm) {
    const c = this.torqueCurve;
    if (rpm <= c[0][0]) return c[0][1];
    const last = c[c.length - 1];
    if (rpm >= last[0]) {
      // Extrapolate the fall-off past the last point rather than flat-lining.
      const prev = c[c.length - 2];
      const slope = (last[1] - prev[1]) / (last[0] - prev[0]);
      return Math.max(0, last[1] + slope * (rpm - last[0]));
    }
    for (let i = 1; i < c.length; i++) {
      if (rpm <= c[i][0]) {
        const t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
        return lerp(c[i - 1][1], c[i][1], t);
      }
    }
    return last[1];
  }

  /** Peak power (kW) — used for HUD and AI performance estimates. */
  get peakPowerKw() {
    if (this._peakPower != null) return this._peakPower;
    let best = 0;
    for (let rpm = 1000; rpm <= this.maxRpm; rpm += 100) {
      const p = this.torqueAt(rpm) * rpm * RPM_TO_RADS / 1000;
      if (p > best) best = p;
    }
    this._peakPower = best;
    return best;
  }

  setThrottle(v) {
    this.targetThrottle = clamp01(v);
  }

  /**
   * Net crank torque for this step.
   *
   * @param {number} dt seconds
   * @param {boolean} clutchEngaged false during a shift or when stationary in neutral
   * @returns {number} torque at the crankshaft (Nm), may be negative (engine braking)
   */
  update(dt, clutchEngaged) {
    // Throttle actuation lag — makes stabbing the pedal slightly less abrupt
    // than a perfect step, and gives the driver something to modulate.
    const rate = dt / Math.max(1e-4, this.throttleLag);
    this.throttle += clamp(this.targetThrottle - this.throttle, -rate, rate);
    this.throttle = clamp01(this.throttle);

    // Rev limiter: a hard cut with a short hold, which is what produces the
    // characteristic stutter on the limiter.
    if (this._limiterTimer > 0) {
      this._limiterTimer -= dt;
      this.limiterActive = true;
    } else if (this.rpm >= this.limiterRpm) {
      this._limiterTimer = 0.035;
      this.limiterActive = true;
    } else {
      this.limiterActive = false;
    }

    const effectiveThrottle = this.limiterActive ? 0 : this.throttle;

    // Drive torque
    let torque = this.torqueAt(this.rpm) * effectiveThrottle * this.healthFactor;

    // Engine braking. Rises with rpm and is strongest with a fully closed
    // throttle — this is what a driver uses to help rotate the car on entry,
    // and what makes an aggressive downshift able to lock the rear.
    const braking = (this.engineBrakingBase + this.rpm * this.engineBrakingCoeff) *
                    (1 - effectiveThrottle);
    torque -= braking;

    // Idle control: keep the engine alive when it is disconnected or crawling.
    if (this.rpm < this.idleRpm && !clutchEngaged) {
      const deficit = (this.idleRpm - this.rpm) / this.idleRpm;
      torque += deficit * 240;
    }

    this.outputTorque = torque;
    this.powerKw = Math.max(0, torque * this.rpm * RPM_TO_RADS) / 1000;

    // Fuel burn tracks actual crank work, so lifting and short-shifting really
    // do save fuel — which is what makes fuel a strategic lever.
    const work = Math.max(0, this.outputTorque) * this.rpm * RPM_TO_RADS * dt;
    this.fuelUsedThisStep = work * this.fuelPerJoule + this.idleFuelRate * dt;

    return torque;
  }

  /**
   * Free-revving integration, used when the clutch is open (neutral, shifting
   * or stationary). When the clutch is closed the transmission drives the rpm
   * directly from wheel speed instead.
   */
  integrateFree(netTorque, dt) {
    const omega = this.rpm * RPM_TO_RADS;
    const newOmega = omega + (netTorque / this.inertia) * dt;
    this.rpm = clamp(newOmega * RADS_TO_RPM, this.stallRpm, this.maxRpm + 400);
  }

  setRpmFromWheels(wheelRpm) {
    // Head-room above the limiter so that a wheelspinning car actually sits on
    // the limiter and gets its torque cut, rather than being clamped silently.
    this.rpm = clamp(wheelRpm, this.idleRpm * 0.55, this.maxRpm * 1.2);
  }

  /** 0..1 position in the rev range, for the shift-light strip. */
  get revFraction() {
    return clamp01((this.rpm - this.idleRpm) / (this.limiterRpm - this.idleRpm));
  }
}
