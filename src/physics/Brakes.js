import { clamp, clamp01, lerp } from '../math/MathUtils.js';

/**
 * Carbon brake system with per-corner temperature.
 *
 * Carbon discs are close to useless cold and fade when cooked, so the brake
 * temperature is not decoration: an overheating front-left really does mean a
 * longer stop and a car that wants to run wide at the next corner.
 */
export class Brakes {
  constructor(config = {}) {
    // Total peak brake torque across all four corners (Nm).
    this.maxTorque = config.maxTorque ?? 17000;
    // Fraction applied to the front axle. Higher = more stable, more front lockup.
    this.balance = clamp(config.balance ?? 0.58, 0.40, 0.75);

    this.optimalTemp = config.optimalTemp ?? 480;
    this.minEffectiveTemp = config.minEffectiveTemp ?? 220;
    this.fadeTemp = config.fadeTemp ?? 780;
    this.ambient = config.ambient ?? 28;

    this.thermalMass = config.thermalMass ?? 7800;  // J/K per corner
    this.coolingBase = config.coolingBase ?? 5.5;
    this.coolingSpeed = config.coolingSpeed ?? 0.95;

    // Per-corner disc temperatures: FL, FR, RL, RR.
    this.temps = [this.ambient + 60, this.ambient + 60, this.ambient + 50, this.ambient + 50];
    this.brakeInput = 0;
  }

  /** Torque available at one corner, before the tire has its say. */
  torqueAt(index, brakeInput, isFront) {
    const axleShare = isFront ? this.balance : (1 - this.balance);
    const perWheel = this.maxTorque * axleShare * 0.5;
    return perWheel * clamp01(brakeInput) * this.efficiencyAt(index);
  }

  /**
   * Temperature-dependent pad friction. Cold carbon gives roughly 55% of peak;
   * beyond the fade point the pads glaze and fall away sharply.
   */
  efficiencyAt(index) {
    const t = this.temps[index];
    if (t < this.optimalTemp) {
      const x = clamp01((t - this.minEffectiveTemp) / (this.optimalTemp - this.minEffectiveTemp));
      return lerp(0.55, 1.0, x * x * (3 - 2 * x));
    }
    if (t <= this.fadeTemp) return 1.0;
    return clamp(1.0 - (t - this.fadeTemp) / 420, 0.35, 1.0);
  }

  /**
   * Thermal update from actual braking work.
   * @param {number[]} powers watts dissipated at each corner
   * @param {number} speed vehicle speed (m/s) driving the brake duct airflow
   */
  update(dt, powers, speed, wetness = 0) {
    const cooling = (this.coolingBase + Math.min(speed, 95) * this.coolingSpeed) *
                    (1 + clamp01(wetness) * 1.4);
    for (let i = 0; i < 4; i++) {
      const heat = (powers[i] || 0) / this.thermalMass;
      const loss = (this.temps[i] - this.ambient) * cooling / this.thermalMass;
      this.temps[i] = clamp(this.temps[i] + (heat - loss) * dt, this.ambient, 1400);
    }
  }

  /** 0..1 heat indicator per corner for the HUD. */
  heatFraction(index) {
    return clamp01((this.temps[index] - this.ambient) / (this.fadeTemp - this.ambient));
  }

  setBalance(v) {
    this.balance = clamp(v, 0.40, 0.75);
  }

  reset() {
    this.temps = [this.ambient + 60, this.ambient + 60, this.ambient + 50, this.ambient + 50];
  }
}
