import { clamp } from '../math/MathUtils.js';

export const DiffType = {
  OPEN: 'open',
  LSD: 'lsd',
  LOCKED: 'locked'
};

/**
 * Salisbury-style limited-slip differential.
 *
 * The differential is what decides whether a corner exit is a clean launch or a
 * lit-up inside rear tire. With an open diff the unloaded inside wheel simply
 * spins and takes all the torque with it; with a tight power ramp the loaded
 * outside wheel keeps driving, at the cost of the car wanting to run wide.
 */
export class Differential {
  constructor(config = {}) {
    this.type = config.type ?? DiffType.LSD;
    // Static preload torque (Nm) — resists any speed difference at all.
    this.preload = config.preload ?? 55;
    // Fraction of input torque converted to locking torque on power / on coast.
    this.powerRamp = config.powerRamp ?? 0.45;
    this.coastRamp = config.coastRamp ?? 0.22;
    // How sharply the clutch pack reacts to a speed difference (Nm per rad/s).
    this.lockStiffness = config.lockStiffness ?? 130;

    this.lockTorque = 0;
    this.transferTorque = 0;
  }

  /**
   * Split an input torque across the two driven wheels.
   *
   * @param {number} inputTorque torque at the differential input (Nm)
   * @param {number} omegaLeft   left wheel angular velocity (rad/s)
   * @param {number} omegaRight  right wheel angular velocity (rad/s)
   * @returns {{left:number,right:number}} torque to each wheel
   */
  split(inputTorque, omegaLeft, omegaRight) {
    const half = inputTorque * 0.5;

    if (this.type === DiffType.OPEN) {
      this.lockTorque = 0;
      this.transferTorque = 0;
      return { left: half, right: half };
    }

    if (this.type === DiffType.LOCKED) {
      // Effectively infinite locking: modelled as a very stiff coupling.
      const delta = omegaLeft - omegaRight;
      const transfer = clamp(delta * 900, -6000, 6000);
      this.lockTorque = 6000;
      this.transferTorque = transfer;
      return { left: half - transfer, right: half + transfer };
    }

    // Salisbury LSD: the ramp angle in use depends on whether the diff is being
    // driven (power) or driving the engine (coast).
    const onPower = inputTorque >= 0;
    const ramp = onPower ? this.powerRamp : this.coastRamp;
    const lock = this.preload + Math.abs(inputTorque) * ramp;
    this.lockTorque = lock;

    const delta = omegaLeft - omegaRight;
    const transfer = clamp(delta * this.lockStiffness, -lock, lock);
    this.transferTorque = transfer;

    return { left: half - transfer, right: half + transfer };
  }

  /** Effective locking percentage, for the setup screen. */
  get lockPercent() {
    if (this.type === DiffType.OPEN) return 0;
    if (this.type === DiffType.LOCKED) return 100;
    return Math.round(this.powerRamp * 100);
  }
}
