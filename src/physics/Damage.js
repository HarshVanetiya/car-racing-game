import { clamp01, clamp } from '../math/MathUtils.js';

/**
 * Component damage.
 *
 * Every value here feeds the physics rather than a texture: a broken front wing
 * removes front downforce (and adds drag), a bent suspension corner changes that
 * wheel's geometry and spring rate, a hurt engine loses torque. The car gets
 * genuinely harder to drive, which is the point.
 */
export class DamageModel {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.frontWing = 1;     // 1 = perfect, 0 = destroyed
    this.rearWing = 1;
    this.floor = 1;
    this.engine = 1;
    this.gearbox = 1;
    this.radiator = 1;
    this.suspension = [1, 1, 1, 1];  // FL FR RL RR
    this.bodywork = 1;
    this.punctures = [false, false, false, false];
    this.totalEvents = 0;
    this.lastEvent = null;
  }

  get isTerminal() {
    // A car with a destroyed suspension corner or a dead engine cannot continue.
    return this.suspension.some((s) => s <= 0.02) || this.engine <= 0.05;
  }

  /** 0..1 summary for the HUD damage readout. */
  get overall() {
    const susp = this.suspension.reduce((a, b) => a + b, 0) / 4;
    return clamp01(
      this.frontWing * 0.18 + this.rearWing * 0.16 + this.floor * 0.12 +
      this.engine * 0.16 + this.gearbox * 0.10 + susp * 0.22 + this.bodywork * 0.06
    );
  }

  /**
   * Apply an impact.
   *
   * @param {number} energy   kinetic energy absorbed (J)
   * @param {object} local    impact point in body space
   * @param {number} severity 0..1 scaling from the collision solver
   */
  applyImpact(energy, local, severity = 1) {
    if (!this.enabled) return null;
    // Below this threshold it is rubbing, not damage — light contact should not
    // ruin a race.
    if (energy < 2200) return null;

    const scale = clamp01((energy - 2200) / 90000) * severity;
    if (scale <= 0.001) return null;

    const front = local.z > 1.0;
    const rear = local.z < -1.0;
    const left = local.x < -0.45;
    const right = local.x > 0.45;
    const low = local.y < -0.05;

    const event = { parts: [], energy, scale };

    if (front) {
      const d = scale * 1.35;
      this.frontWing = clamp01(this.frontWing - d);
      event.parts.push('frontWing');
      if (scale > 0.24) {
        const i = left ? 0 : 1;
        this.suspension[i] = clamp01(this.suspension[i] - scale * 0.55);
        event.parts.push('suspension');
      }
    } else if (rear) {
      this.rearWing = clamp01(this.rearWing - scale * 1.1);
      event.parts.push('rearWing');
      if (scale > 0.3) {
        this.gearbox = clamp01(this.gearbox - scale * 0.45);
        event.parts.push('gearbox');
      }
      if (scale > 0.42) {
        const i = left ? 2 : 3;
        this.suspension[i] = clamp01(this.suspension[i] - scale * 0.5);
        event.parts.push('suspension');
      }
    } else {
      // Side impact: sidepod, floor and the wheels on that side.
      this.bodywork = clamp01(this.bodywork - scale * 0.9);
      this.floor = clamp01(this.floor - scale * 0.5);
      this.radiator = clamp01(this.radiator - scale * 0.6);
      event.parts.push('bodywork');
      if (scale > 0.3) {
        const a = left ? 0 : 1;
        const b = left ? 2 : 3;
        this.suspension[a] = clamp01(this.suspension[a] - scale * 0.35);
        this.suspension[b] = clamp01(this.suspension[b] - scale * 0.35);
        event.parts.push('suspension');
      }
    }

    if (low) {
      this.floor = clamp01(this.floor - scale * 0.7);
      if (!event.parts.includes('floor')) event.parts.push('floor');
    }

    // A cooked radiator slowly kills the engine.
    if (this.radiator < 0.4) {
      this.engine = clamp01(this.engine - scale * 0.25);
    }

    this.totalEvents++;
    this.lastEvent = event;
    return event;
  }

  /** Wheel contact at speed can cut a tire. */
  tryPuncture(wheelIndex, energy, rng) {
    if (!this.enabled) return false;
    if (energy < 8000) return false;
    const chance = clamp01((energy - 8000) / 70000) * 0.65;
    if (rng() < chance) {
      this.punctures[wheelIndex] = true;
      return true;
    }
    return false;
  }

  /** Heat soak from a damaged radiator degrades the engine over time. */
  update(dt, engineLoad) {
    if (!this.enabled) return;
    if (this.radiator < 0.65) {
      const stress = (0.65 - this.radiator) * engineLoad * dt * 0.0045;
      this.engine = clamp01(this.engine - stress);
    }
  }

  repair(parts = null) {
    if (!parts) {
      this.frontWing = 1; this.rearWing = 1; this.floor = 1;
      this.engine = Math.max(this.engine, 0.85);
      this.gearbox = Math.max(this.gearbox, 0.9);
      this.radiator = 1; this.bodywork = 1;
      this.suspension = [1, 1, 1, 1];
      this.punctures = [false, false, false, false];
      return;
    }
    for (const p of parts) {
      if (p === 'suspension') this.suspension = [1, 1, 1, 1];
      else if (p === 'tires') this.punctures = [false, false, false, false];
      else if (p in this) this[p] = 1;
    }
  }

  /** Time cost of repairing in the pits, in seconds. */
  repairTime() {
    let t = 0;
    if (this.frontWing < 0.92) t += 4.2 + (1 - this.frontWing) * 6.5;
    if (this.rearWing < 0.9) t += 5.5 + (1 - this.rearWing) * 7.0;
    if (this.bodywork < 0.75) t += 3.0;
    const worstSusp = Math.min(...this.suspension);
    if (worstSusp < 0.8) t += 9.0 + (1 - worstSusp) * 12;
    return t;
  }

  serialize() {
    return {
      fw: Math.round(this.frontWing * 100) / 100,
      rw: Math.round(this.rearWing * 100) / 100,
      fl: Math.round(this.floor * 100) / 100,
      en: Math.round(this.engine * 100) / 100,
      gb: Math.round(this.gearbox * 100) / 100,
      sp: this.suspension.map((s) => Math.round(s * 100) / 100),
      bw: Math.round(this.bodywork * 100) / 100
    };
  }

  deserialize(d) {
    if (!d) return this;
    this.frontWing = d.fw ?? this.frontWing;
    this.rearWing = d.rw ?? this.rearWing;
    this.floor = d.fl ?? this.floor;
    this.engine = d.en ?? this.engine;
    this.gearbox = d.gb ?? this.gearbox;
    this.suspension = d.sp ?? this.suspension;
    this.bodywork = d.bw ?? this.bodywork;
    return this;
  }
}
