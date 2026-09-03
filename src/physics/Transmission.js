import { clamp, clamp01 } from '../math/MathUtils.js';
import { RPM_TO_RADS, RADS_TO_RPM } from './Engine.js';

/**
 * Eight-speed sequential gearbox with a seamless-shift torque cut.
 *
 * The gearbox is not a speed multiplier bolted on top of the car — it sits
 * between the engine's torque curve and the tire's grip limit, and both ends
 * push back. First gear multiplies torque far beyond what the rear tires can
 * take, which is exactly why a standing start is a test of throttle control.
 */
export class Transmission {
  constructor(config = {}) {
    // Ratio 0 is reverse, 1..N are forward gears.
    this.gearRatios = config.gearRatios ?? [
      -3.10, 5.24, 4.35, 3.72, 3.24, 2.87, 2.57, 2.26, 2.00
    ];
    this.finalDrive = config.finalDrive ?? 3.00;
    this.efficiency = config.efficiency ?? 0.94;

    this.shiftTime = config.shiftTime ?? 0.055;   // seconds of torque cut
    this.downshiftTime = config.downshiftTime ?? 0.075;
    this.autoUpshiftRpm = config.autoUpshiftRpm ?? 14300;
    this.autoDownshiftRpm = config.autoDownshiftRpm ?? 9600;

    this.gear = 1;               // current gear index into gearRatios
    this.targetGear = 1;
    this.shiftTimer = 0;
    this.isShifting = false;
    this.automatic = config.automatic ?? true;
    this.lastShiftDirection = 0;
    this.shiftEventPending = 0;  // +1 upshift, -1 downshift; consumed by audio
    this.shiftCooldown = 0;      // lockout preventing back-to-back shifts

    // Clutch is only meaningfully modelled at low speed / launch.
    this.clutch = 1;             // 0 open, 1 locked
  }

  get topGear() {
    return this.gearRatios.length - 1;
  }

  /** Total ratio from crank to wheel for the current gear. */
  get ratio() {
    return this.gearRatios[this.gear] * this.finalDrive;
  }

  ratioFor(gear) {
    const g = clamp(gear, 0, this.topGear);
    return this.gearRatios[g] * this.finalDrive;
  }

  get inNeutral() {
    return this.gear === 0 && this.gearRatios[0] === 0;
  }

  requestUpshift() {
    if (this.isShifting) return false;
    if (this.gear >= this.topGear) return false;
    this.targetGear = this.gear + 1;
    this.shiftTimer = this.shiftTime;
    this.isShifting = true;
    this.lastShiftDirection = 1;
    return true;
  }

  requestDownshift() {
    if (this.isShifting) return false;
    if (this.gear <= 0) return false;
    this.targetGear = this.gear - 1;
    this.shiftTimer = this.downshiftTime;
    this.isShifting = true;
    this.lastShiftDirection = -1;
    return true;
  }

  requestGear(g) {
    const target = clamp(g, 0, this.topGear);
    if (target === this.gear || this.isShifting) return false;
    return target > this.gear ? this.requestUpshift() : this.requestDownshift();
  }

  /**
   * Automatic mode. Shift points are load aware: it holds a gear under full
   * throttle and short-shifts when cruising, and refuses a downshift that would
   * over-rev — a small thing, but it stops the auto box destabilising the car
   * on corner entry.
   */
  autoShift(roadRpm, roadOmega, throttle, brake, engine) {
    if (this.isShifting || !this.automatic) return;
    // A gearbox that has just shifted needs a moment before it shifts again;
    // without this a wheelspinning car cascades straight through the box.
    if (this.shiftCooldown > 0) return;

    // Decisions are made on the engine speed implied by ROAD speed, not by the
    // measured engine speed. Under wheelspin the two diverge wildly, and
    // shifting on the spinning value would run the car up through the gears
    // while it is barely moving.
    const upshiftAt = this.autoUpshiftRpm - (1 - throttle) * 2600;
    if (this.gear >= 1 && this.gear < this.topGear && roadRpm > upshiftAt) {
      this.requestUpshift();
      return;
    }
    if (this.gear > 1) {
      const lowerRatio = this.ratioFor(this.gear - 1);
      const rpmAfter = Math.abs(roadOmega * lowerRatio) * RADS_TO_RPM;
      const threshold = this.autoDownshiftRpm + brake * 1500;
      if (roadRpm < threshold && rpmAfter < engine.limiterRpm - 400) {
        this.requestDownshift();
      }
    }
  }

  update(dt) {
    this.shiftEventPending = 0;
    if (this.shiftCooldown > 0) this.shiftCooldown -= dt;
    if (this.isShifting) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) {
        this.gear = this.targetGear;
        this.isShifting = false;
        this.shiftTimer = 0;
        this.shiftCooldown = 0.22;
        this.shiftEventPending = this.lastShiftDirection;
      }
    }
  }

  /**
   * Torque delivered to the differential input.
   * During a shift the torque path is cut, which is felt as a momentary loss of
   * drive — and, on a downshift, as the engine braking arriving all at once.
   */
  outputTorque(engineTorque) {
    if (this.isShifting) return 0;
    if (this.gear === 0 && this.gearRatios[0] === 0) return 0;
    return engineTorque * this.ratio * this.efficiency;
  }

  /** Engine rpm implied by driveshaft speed when the clutch is locked. */
  engineRpmFromWheels(driveshaftOmega) {
    return Math.abs(driveshaftOmega * this.ratio) * RADS_TO_RPM;
  }

  /**
   * Clutch engagement. Fully open below walking pace so the engine can idle,
   * blended in as the car gets going. `launchAssist` keeps the clutch slipping
   * a little longer, which is what lets a standing start work at all.
   */
  updateClutch(vehicleSpeed, dt) {
    const target = clamp01((vehicleSpeed - 0.6) / 4.5);
    const rate = dt * 4.0;
    this.clutch += clamp(target - this.clutch, -rate, rate);
    this.clutch = clamp01(this.clutch);
    return this.clutch;
  }

  reset(gear = 1) {
    this.gear = gear;
    this.targetGear = gear;
    this.isShifting = false;
    this.shiftTimer = 0;
    this.shiftCooldown = 0;
    this.clutch = 0;
  }
}
