import { clamp, clamp01, lerp, smoothstep, sign } from '../math/MathUtils.js';
import { getSurface } from './Surfaces.js';

/**
 * ============================================================================
 *  TIRE MODEL
 * ============================================================================
 *
 * This is the component every other system ultimately talks through. Engine
 * torque only matters because it reaches a tire; downforce only matters because
 * it loads a tire; a good corner exit is nothing more than keeping the rear
 * tires inside their slip window while opening the throttle.
 *
 * The model is a simplified Pacejka "Magic Formula" with:
 *
 *   - separate longitudinal and lateral curves with a genuine peak followed by
 *     a decaying tail, so exceeding the optimum *loses* grip rather than
 *     saturating at maximum,
 *   - combined slip through a normalised slip vector, which gives a friction
 *     ellipse for free: brake hard and there is simply no grip budget left for
 *     steering,
 *   - load sensitivity, so doubling vertical load does NOT double grip — this
 *     is why lateral load transfer reduces total axle grip and why aero
 *     downforce has diminishing returns,
 *   - a thermal model driven by real friction power,
 *   - wear driven by sliding energy, with a performance cliff near the end.
 */

/** Magic Formula: F(s) = D sin(C atan(B s - E (B s - atan(B s)))) */
function magicFormula(slip, B, C, D, E) {
  const Bs = B * slip;
  const inner = Bs - E * (Bs - Math.atan(Bs));
  return D * Math.sin(C * Math.atan(inner));
}

/**
 * Locate the slip at which the Magic Formula peaks, for a given (B, C, E).
 *
 * This matters more than it looks. The curve peaks where the inner argument
 * reaches tan(pi / 2C); with a non-zero curvature factor E that happens at
 *
 *     x (1 - E) + E atan(x) = tan(pi / 2C),   x = B * slip
 *
 * which has no closed form. Getting this wrong is what turns a tire model into
 * an arcade one: normalise against the wrong peak and the "limit" lands far
 * below the real maximum, so the tire never actually falls off and grip appears
 * constant no matter how hard the car slides. Solved here with Newton's method.
 */
function solvePeakSlip(B, C, E) {
  const K = Math.tan(Math.PI / (2 * C));
  // E >= 1 would make the curve non-monotonic before the peak; clamp for safety.
  const e = Math.min(E, 0.995);
  let x = K; // decent initial guess (exact when E = 0)
  for (let i = 0; i < 12; i++) {
    const f = x * (1 - e) + e * Math.atan(x) - K;
    const df = (1 - e) + e / (1 + x * x);
    if (Math.abs(df) < 1e-9) break;
    const step = f / df;
    x -= step;
    if (x < 1e-6) x = 1e-6;
    if (Math.abs(step) < 1e-9) break;
  }
  return x / B;
}

/**
 * The blended (B, C, E) vary continuously with how much of the slip is
 * longitudinal, so the peak is precomputed across that blend once per compound
 * and interpolated — Newton's method is far too costly to run per wheel per
 * substep.
 */
const PEAK_TABLE_SIZE = 33;
function peakSlipFor(compound, mixLong) {
  let table = compound._peakTable;
  if (!table) {
    table = new Float64Array(PEAK_TABLE_SIZE);
    for (let i = 0; i < PEAK_TABLE_SIZE; i++) {
      const m = i / (PEAK_TABLE_SIZE - 1);
      const B = lerp(compound.stiffnessLat, compound.stiffnessLong, m);
      const C = lerp(compound.shapeLat, compound.shapeLong, m);
      const E = lerp(compound.curvatureLat, compound.curvatureLong, m);
      table[i] = solvePeakSlip(B, C, E);
    }
    Object.defineProperty(compound, '_peakTable', {
      value: table, enumerable: false, writable: false
    });
  }
  const f = clamp01(mixLong) * (PEAK_TABLE_SIZE - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(i0 + 1, PEAK_TABLE_SIZE - 1);
  return lerp(table[i0], table[i1], f - i0);
}

export const TireCompound = {
  SOFT: 'soft',
  MEDIUM: 'medium',
  HARD: 'hard',
  INTERMEDIATE: 'intermediate',
  WET: 'wet'
};

/**
 * Compound definitions. The trade-offs here are the whole basis of race
 * strategy: softs are ~1.5% quicker per lap but fall off roughly three times
 * faster than hards.
 */
export const COMPOUNDS = {
  [TireCompound.SOFT]: {
    key: TireCompound.SOFT,
    name: 'Soft',
    short: 'S',
    colour: '#e8323c',
    peakGrip: 1.72,          // dry friction coefficient at reference load
    optimalTemp: 100,        // deg C
    tempWindowLow: 85,
    tempWindowHigh: 118,
    warmupRate: 1.45,        // how quickly it takes on heat
    coolRate: 0.95,
    wearRate: 1.85,          // relative degradation
    // Grip retained at the end of the tire's usable life, before the cliff.
    endOfLifeGrip: 0.80,
    cliffStart: 0.72,        // wear fraction where the fall-off accelerates
    wetGrip: 0.36,           // multiplier on a soaked track
    aquaplaneResistance: 0.35,
    // Magic-Formula shape parameters.
    stiffnessLong: 11.5,
    stiffnessLat: 10.2,
    shapeLong: 1.58,
    shapeLat: 1.44,
    curvatureLong: 0.42,
    curvatureLat: 0.36,
    peakSlipRatio: 0.115,
    peakSlipAngleDeg: 7.4,
    rollingResistance: 1.0
  },
  [TireCompound.MEDIUM]: {
    key: TireCompound.MEDIUM,
    name: 'Medium',
    short: 'M',
    colour: '#f2c53d',
    peakGrip: 1.66,
    optimalTemp: 104,
    tempWindowLow: 88,
    tempWindowHigh: 124,
    warmupRate: 1.12,
    coolRate: 1.0,
    wearRate: 1.18,
    endOfLifeGrip: 0.84,
    cliffStart: 0.78,
    wetGrip: 0.35,
    aquaplaneResistance: 0.35,
    stiffnessLong: 11.0,
    stiffnessLat: 9.8,
    shapeLong: 1.57,
    shapeLat: 1.43,
    curvatureLong: 0.44,
    curvatureLat: 0.38,
    peakSlipRatio: 0.122,
    peakSlipAngleDeg: 7.9,
    rollingResistance: 0.98
  },
  [TireCompound.HARD]: {
    key: TireCompound.HARD,
    name: 'Hard',
    short: 'H',
    colour: '#e6e6e6',
    peakGrip: 1.58,
    optimalTemp: 110,
    tempWindowLow: 94,
    tempWindowHigh: 132,
    warmupRate: 0.84,
    coolRate: 1.06,
    wearRate: 0.68,
    endOfLifeGrip: 0.88,
    cliffStart: 0.84,
    wetGrip: 0.33,
    aquaplaneResistance: 0.35,
    stiffnessLong: 10.4,
    stiffnessLat: 9.3,
    shapeLong: 1.56,
    shapeLat: 1.42,
    curvatureLong: 0.46,
    curvatureLat: 0.40,
    peakSlipRatio: 0.132,
    peakSlipAngleDeg: 8.5,
    rollingResistance: 0.96
  },
  [TireCompound.INTERMEDIATE]: {
    key: TireCompound.INTERMEDIATE,
    name: 'Intermediate',
    short: 'I',
    colour: '#3fbf52',
    peakGrip: 1.30,
    optimalTemp: 78,
    tempWindowLow: 60,
    tempWindowHigh: 96,
    warmupRate: 1.05,
    coolRate: 1.35,
    wearRate: 1.30,
    endOfLifeGrip: 0.82,
    cliffStart: 0.74,
    // Intermediates are far better than slicks in the wet but overheat and
    // grain badly on a drying line — see `wetnessPerformance` below.
    wetGrip: 0.86,
    aquaplaneResistance: 0.78,
    stiffnessLong: 9.4,
    stiffnessLat: 8.4,
    shapeLong: 1.52,
    shapeLat: 1.38,
    curvatureLong: 0.52,
    curvatureLat: 0.46,
    peakSlipRatio: 0.145,
    peakSlipAngleDeg: 9.4,
    rollingResistance: 1.10,
    idealWetness: 0.42
  },
  [TireCompound.WET]: {
    key: TireCompound.WET,
    name: 'Wet',
    short: 'W',
    colour: '#2f7fd6',
    peakGrip: 1.18,
    optimalTemp: 68,
    tempWindowLow: 50,
    tempWindowHigh: 88,
    warmupRate: 0.95,
    coolRate: 1.55,
    wearRate: 1.15,
    endOfLifeGrip: 0.84,
    cliffStart: 0.76,
    wetGrip: 1.0,
    aquaplaneResistance: 1.0,
    stiffnessLong: 8.6,
    stiffnessLat: 7.7,
    shapeLong: 1.49,
    shapeLat: 1.35,
    curvatureLong: 0.58,
    curvatureLat: 0.52,
    peakSlipRatio: 0.158,
    peakSlipAngleDeg: 10.2,
    rollingResistance: 1.22,
    idealWetness: 0.85
  }
};

export const COMPOUND_ORDER = [
  TireCompound.SOFT,
  TireCompound.MEDIUM,
  TireCompound.HARD,
  TireCompound.INTERMEDIATE,
  TireCompound.WET
];

export function getCompound(key) {
  return COMPOUNDS[key] || COMPOUNDS[TireCompound.MEDIUM];
}

/** Reference vertical load per tire (N) at which `peakGrip` is quoted. */
const REFERENCE_LOAD = 3400;
/**
 * How strongly the friction coefficient falls as load rises. Real tires lose
 * roughly 10-20% of mu per doubling of load; this is what makes lateral load
 * transfer cost an axle its grip, but set too high it also destroys braking
 * under heavy downforce, where every tire is loaded well past its reference.
 */
const LOAD_SENSITIVITY = 0.160;

/** Fraction of contact-patch friction power that heats the tire itself. */
const FRICTION_HEAT_FRACTION = 0.30;
/** Specific heat of the tread and carcass, expressed per metre of width (J/K). */
const TREAD_THERMAL_MASS_PER_M = 9000;
const CARCASS_THERMAL_MASS_PER_M = 32000;

/**
 * Hysteresis heating: a loaded tire dissipates energy simply by being
 * deflected as it rolls, which is most of what warms a tire up on a straight.
 * Expressed as an effective rolling-resistance coefficient, so the heat is
 * `HYSTERESIS_COEFF * load * speed` watts.
 */
const HYSTERESIS_COEFF = 0.0126;

/**
 * Convective cooling of the tread, per second per Kelvin above the ambient
 * reference. Calibrated together with the hysteresis term above so that a car
 * driven at racing pace settles inside its tires' temperature window, an out
 * lap leaves them below it, and sustained sliding drives them well over it.
 */
const COOLING_STATIC = 0.0050;
const COOLING_PER_MS = 0.000105;

export class Tire {
  /**
   * @param {object} opts
   * @param {string} opts.compound compound key
   * @param {number} opts.radius   rolling radius (m)
   * @param {number} opts.width    contact width (m), used for thermal mass
   * @param {number} opts.inertia  rotational inertia of wheel+tire (kg m^2)
   * @param {number} opts.ambient  ambient air temperature (deg C)
   */
  constructor(opts = {}) {
    this.compoundKey = opts.compound || TireCompound.MEDIUM;
    this.compound = getCompound(this.compoundKey);
    this.radius = opts.radius ?? 0.36;
    this.width = opts.width ?? 0.31;
    this.inertia = opts.inertia ?? 1.35;

    this.ambient = opts.ambient ?? 26;
    this.trackTemp = opts.trackTemp ?? 34;

    // Two-layer thermal model: the surface reacts within a corner, the carcass
    // holds heat across a lap. Both matter to the driver in different ways.
    this.surfaceTemp = this.ambient + 8;
    this.coreTemp = this.ambient + 5;

    this.wear = 0;              // 0 = new, 1 = fully worn
    this.flatSpot = 0;          // 0..1 — from locking a wheel
    this.dirt = 0;              // 0..1 — pick-up from running off track
    this.damage = 0;            // 0..1 — puncture / carcass damage

    // Outputs refreshed each step (read by audio, HUD, effects, AI).
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.combinedSlip = 0;      // normalised: 1.0 == at the grip limit
    this.load = 0;
    this.forceLong = 0;
    this.forceLat = 0;
    this.frictionPower = 0;     // W dissipated in the contact patch
    this.slipSpeed = 0;         // m/s of true sliding
    this.isLocked = false;
    this.isSpinning = false;
    this.gripFraction = 1;      // current mu relative to a fresh optimal tire
  }

  setCompound(key) {
    this.compoundKey = key;
    this.compound = getCompound(key);
    return this;
  }

  /** Fit a fresh set — a pit stop calls this. */
  reset(compoundKey = this.compoundKey, preheat = true) {
    this.setCompound(compoundKey);
    this.wear = 0;
    this.flatSpot = 0;
    this.dirt = 0;
    this.damage = 0;
    // Blankets bring the tire close to, but not into, its window.
    const target = preheat
      ? this.compound.optimalTemp - 22
      : this.ambient + 6;
    this.surfaceTemp = target;
    this.coreTemp = target;
    return this;
  }

  /**
   * Temperature performance: a bell around the optimum. Cold tires are greasy
   * and slow to respond; overheated tires go off and degrade far faster.
   */
  temperatureGrip() {
    const c = this.compound;
    const t = this.surfaceTemp * 0.65 + this.coreTemp * 0.35;
    if (t < c.optimalTemp) {
      const x = clamp01((t - (c.tempWindowLow - 45)) / ((c.optimalTemp - c.tempWindowLow) + 45));
      // Cold tires bottom out around 62% of peak grip.
      return lerp(0.62, 1.0, smoothstep(0, 1, x));
    }
    const over = t - c.optimalTemp;
    const span = Math.max(6, c.tempWindowHigh - c.optimalTemp);
    // Overheating falls off faster than cold, and keeps falling.
    return clamp(1.0 - 0.30 * Math.pow(over / span, 1.7), 0.48, 1.0);
  }

  /**
   * Wear performance: gentle linear loss through most of the tire's life, then
   * a distinct cliff. This is what makes a one-stop vs two-stop call real.
   */
  wearGrip() {
    const c = this.compound;
    const w = clamp01(this.wear);
    const linear = lerp(1.0, c.endOfLifeGrip, w);
    if (w <= c.cliffStart) return linear;
    const cliffT = (w - c.cliffStart) / Math.max(1e-3, 1 - c.cliffStart);
    // Beyond the cliff, up to a further 30% is lost.
    return linear * lerp(1.0, 0.70, cliffT * cliffT);
  }

  /**
   * Wetness performance. Deliberately NOT a global grip multiplier: a slick on
   * a damp track is catastrophic, a full wet on a dry track overheats and is
   * merely slow, and an intermediate has a narrow happy band in between.
   */
  wetnessGrip(wetness, waterDepth, speed) {
    const c = this.compound;
    const w = clamp01(wetness);
    if (w < 0.01 && waterDepth < 0.001) {
      // On a dry track, rain tires are hurt by their soft tread squirm.
      if (c.idealWetness) return lerp(1.0, 0.80, clamp01(c.idealWetness));
      return 1.0;
    }
    let g;
    if (c.idealWetness == null) {
      // Slick: grip collapses quickly with any standing moisture.
      g = lerp(1.0, c.wetGrip, Math.pow(w, 0.62));
    } else {
      // Grooved tire: best near its design wetness, penalised either side.
      const distance = Math.abs(w - c.idealWetness);
      const band = lerp(1.0, 0.72, clamp01(distance / 0.55));
      g = lerp(lerp(1.0, 0.86, c.idealWetness), c.wetGrip, Math.pow(w, 0.5)) * band;
    }
    // Aquaplaning: above a critical speed the tread cannot clear the water and
    // the contact patch simply lifts. Wets resist this far better than slicks.
    if (waterDepth > 0.0015) {
      const critical = 26 + 78 * c.aquaplaneResistance * (1 - clamp01(this.wear * 0.6));
      const depthFactor = clamp01((waterDepth - 0.0015) / 0.010);
      const over = clamp01((speed - critical) / 34);
      g *= lerp(1.0, lerp(1.0, 0.18, over), depthFactor);
    }
    return clamp(g, 0.08, 1.2);
  }

  /**
   * Load sensitivity. mu falls as vertical load rises, which is the reason a
   * heavily loaded outside tire cannot make up for an unloaded inside one —
   * total axle grip drops with lateral load transfer.
   */
  loadSensitivity(load) {
    const ratio = clamp(load / REFERENCE_LOAD, 0.05, 4.0);
    return clamp(1.0 - LOAD_SENSITIVITY * (ratio - 1.0), 0.55, 1.35);
  }

  /**
   * Current friction coefficient for the given conditions, before slip is
   * taken into account.
   */
  frictionCoefficient(load, surfaceType, wetness, waterDepth, speed, trackRubber = 0) {
    const c = this.compound;
    const surf = getSurface(surfaceType);
    let mu = c.peakGrip;
    mu *= this.loadSensitivity(load);
    mu *= this.temperatureGrip();
    mu *= this.wearGrip();
    mu *= this.wetnessGrip(wetness, waterDepth, speed);
    mu *= surf.grip;
    // Rubbered-in racing line adds grip in the dry, washes away in the wet.
    mu *= 1.0 + clamp01(trackRubber) * 0.055 * (1 - clamp01(wetness));
    // Dirt pick-up from an excursion takes a few corners to clean off.
    mu *= 1.0 - clamp01(this.dirt) * 0.30;
    // A flat spot destroys the contact patch periodically; average effect.
    mu *= 1.0 - clamp01(this.flatSpot) * 0.16;
    mu *= 1.0 - clamp01(this.damage) * 0.55;
    this.gripFraction = mu / c.peakGrip;
    return Math.max(0.05, mu);
  }

  /**
   * ------------------------------------------------------------------------
   * Core force solve.
   * ------------------------------------------------------------------------
   * @param {number} load        vertical load on the contact patch (N)
   * @param {number} slipRatio   (wheelSpeed - roadSpeed) / |roadSpeed|
   * @param {number} slipAngle   radians between wheel heading and velocity
   * @param {object} ctx         surface / weather context
   * @returns {{fx:number, fy:number}} longitudinal and lateral contact forces
   */
  computeForces(load, slipRatio, slipAngle, ctx) {
    const c = this.compound;
    this.load = load;

    if (load <= 1) {
      // Wheel is airborne — no contact, no force, and the tire cools rapidly.
      this.slipRatio = slipRatio;
      this.slipAngle = slipAngle;
      this.combinedSlip = 0;
      this.forceLong = 0;
      this.forceLat = 0;
      this.frictionPower = 0;
      this.slipSpeed = 0;
      this.isLocked = false;
      this.isSpinning = false;
      return { fx: 0, fy: 0 };
    }

    const mu = this.frictionCoefficient(
      load, ctx.surfaceType, ctx.wetness, ctx.waterDepth, ctx.speed, ctx.trackRubber
    );

    // --- Normalised slip vector -> friction ellipse ------------------------
    // Both slips are divided by the slip at which their own curve peaks, so a
    // combined magnitude of 1.0 means "exactly at the limit" in any direction.
    const peakSR = c.peakSlipRatio * lerp(1.0, 1.25, clamp01(ctx.wetness));
    const peakSA = Math.tan(c.peakSlipAngleDeg * Math.PI / 180) *
                   lerp(1.0, 1.20, clamp01(ctx.wetness));

    const sx = clamp(slipRatio, -6, 6) / peakSR;
    const sy = Math.tan(clamp(slipAngle, -1.45, 1.45)) / peakSA;
    const sMag = Math.sqrt(sx * sx + sy * sy);

    this.slipRatio = slipRatio;
    this.slipAngle = slipAngle;
    this.combinedSlip = sMag;

    if (sMag < 1e-5) {
      this.forceLong = 0;
      this.forceLat = 0;
      this.frictionPower = 0;
      this.slipSpeed = 0;
      this.isLocked = false;
      this.isSpinning = false;
      return { fx: 0, fy: 0 };
    }

    // Evaluate the shared curve once at the combined magnitude. Directional
    // stiffness/shape are blended by how much of the slip is long vs lateral,
    // which keeps braking feel distinct from cornering feel.
    const mixLong = (sx * sx) / (sx * sx + sy * sy);
    const B = lerp(c.stiffnessLat, c.stiffnessLong, mixLong);
    const C = lerp(c.shapeLat, c.shapeLong, mixLong);
    const E = lerp(c.curvatureLat, c.curvatureLong, mixLong);

    // `sMag` is normalised so that 1.0 means "at the peak of the curve", so
    // rescale it onto the Magic Formula's own argument, whose true peak is
    // solved for above. Past sMag = 1 the curve genuinely decays toward
    // D * sin(C * pi/2) — that decay is the sliding tire losing grip.
    const normalised = sMag * peakSlipFor(c, mixLong);

    const D = mu * load;
    const forceMag = magicFormula(normalised, B, C, D, E);

    // Distribute along the slip direction — this is the friction ellipse: the
    // budget spent on braking is unavailable for turning.
    //
    // Sign convention (SAE): slip *ratio* is defined positive when the wheel
    // overspeeds the road, so the contact patch slides backwards and friction
    // pushes the car forwards — fx therefore follows the sign of sx. Slip
    // *angle* is defined positive when the patch slides sideways, and friction
    // opposes it, so fy takes the opposite sign to sy.
    const fx = (sx / sMag) * forceMag;
    const fy = -(sy / sMag) * forceMag;

    this.forceLong = fx;
    this.forceLat = fy;

    // --- Sliding energy ----------------------------------------------------
    const roadSpeed = Math.max(Math.abs(ctx.speed), 0.25);
    const slipVx = slipRatio * roadSpeed;
    const slipVy = Math.tan(clamp(slipAngle, -1.45, 1.45)) * roadSpeed;
    this.slipSpeed = Math.min(Math.sqrt(slipVx * slipVx + slipVy * slipVy), 90);
    this.frictionPower = Math.abs(fx * slipVx) + Math.abs(fy * slipVy);

    this.isLocked = ctx.speed > 3 && slipRatio < -0.62;
    this.isSpinning = slipRatio > 0.32;

    return { fx, fy };
  }

  /**
   * Thermal + wear update. Both are driven by the friction power computed
   * above, so a driver who slides the car everywhere genuinely destroys their
   * tires while a smooth one makes them last.
   */
  update(dt, ctx) {
    const c = this.compound;
    const surf = getSurface(ctx.surfaceType);

    // Thermal mass scales with contact width, in real J/K, so the heat balance
    // below is an honest energy budget rather than a tuned curve.
    const treadMass = TREAD_THERMAL_MASS_PER_M * this.width;
    const carcassMass = CARCASS_THERMAL_MASS_PER_M * this.width;

    // Heating from sliding friction. Only part of the dissipated power ends up
    // in the rubber; the rest goes into the road surface and the air.
    const frictionHeat = this.frictionPower * FRICTION_HEAT_FRACTION *
                         c.warmupRate * surf.heatFactor;
    // Hysteresis: a tire heats simply by being deflected under load as it
    // rolls, which is why a tire warms up on a straight as well as in a corner.
    const deflectionHeat = this.load * HYSTERESIS_COEFF *
                           Math.min(Math.abs(ctx.speed), 95) * c.warmupRate;
    // Brake heat soaks out through the rim into the carcass.
    const brakeHeat = (ctx.brakeTemp != null)
      ? Math.max(0, ctx.brakeTemp - this.surfaceTemp) * 1.8
      : 0;

    const heatIn = frictionHeat + deflectionHeat + brakeHeat; // watts

    // Convective cooling. Rain cools the tread dramatically, which is exactly
    // why slicks never come in on a wet track.
    const airspeed = Math.min(Math.abs(ctx.speed), 100);
    const wetCooling = 1.0 + clamp01(ctx.wetness) * 2.6 + clamp01(ctx.waterDepth * 90);
    const convection = (COOLING_STATIC + airspeed * COOLING_PER_MS) *
                       c.coolRate * wetCooling;
    const ambientRef = lerp(this.ambient, ctx.trackTemp ?? this.trackTemp, 0.55);

    const dSurface = heatIn / treadMass
                   - (this.surfaceTemp - ambientRef) * convection
                   - (this.surfaceTemp - this.coreTemp) * 0.55;
    this.surfaceTemp += dSurface * dt;

    const dCore = (this.surfaceTemp - this.coreTemp) * 0.14
                - (this.coreTemp - ambientRef) * convection * 0.35;
    this.coreTemp += dCore * dt;

    this.surfaceTemp = clamp(this.surfaceTemp, -10, 320);
    this.coreTemp = clamp(this.coreTemp, -10, 260);

    // --- Wear --------------------------------------------------------------
    // Sliding energy is the dominant term; a small rolling term means even a
    // perfectly smooth lap still uses the tire up.
    // Calibrated so that a medium runs roughly 20 laps of the circuit before
    // the cliff, a soft around 13 and a hard past 35 — the spread that makes a
    // one-stop versus two-stop call a genuine decision.
    const slidingWear = this.frictionPower * 3.60e-8 * c.wearRate * surf.wearFactor;
    const rollingWear = Math.abs(ctx.speed) * 1.20e-7 * c.wearRate * surf.wearFactor;
    // Running outside the temperature window accelerates degradation sharply.
    const t = this.surfaceTemp;
    let thermalMult = 1.0;
    if (t > c.tempWindowHigh) {
      thermalMult += Math.pow((t - c.tempWindowHigh) / 26, 1.6) * 1.9;
    } else if (t < c.tempWindowLow) {
      // Cold tires grain rather than wear, but still lose performance.
      thermalMult += clamp01((c.tempWindowLow - t) / 40) * 0.55;
    }

    const wearScale = ctx.wearScale ?? 1;
    this.wear = clamp01(this.wear + (slidingWear + rollingWear) * thermalMult * dt * wearScale);

    // --- Flat-spotting -----------------------------------------------------
    if (this.isLocked && Math.abs(ctx.speed) > 12) {
      this.flatSpot = clamp01(this.flatSpot + this.slipSpeed * 0.00042 * dt * 60);
    } else {
      // A flat spot never heals, but the reported severity is capped.
      this.flatSpot = clamp01(this.flatSpot);
    }

    // --- Dirt pick-up and cleaning ----------------------------------------
    if (surf.dirtPickup > 0) {
      this.dirt = clamp01(this.dirt + surf.dirtPickup * dt * 1.6);
    } else {
      this.dirt = Math.max(0, this.dirt - dt * 0.34);
    }
  }

  /** Aggregate 0..1 condition indicator for the HUD. */
  get condition() {
    return clamp01(1 - this.wear) * (1 - clamp01(this.damage) * 0.5);
  }

  /** How far outside its window the tire is, for HUD colouring: -1..1. */
  get thermalState() {
    const c = this.compound;
    const t = this.surfaceTemp;
    if (t < c.tempWindowLow) return -clamp01((c.tempWindowLow - t) / 45);
    if (t > c.tempWindowHigh) return clamp01((t - c.tempWindowHigh) / 40);
    return 0;
  }

  serialize() {
    return {
      c: this.compoundKey,
      w: Math.round(this.wear * 1000) / 1000,
      t: Math.round(this.surfaceTemp * 10) / 10,
      ct: Math.round(this.coreTemp * 10) / 10,
      f: Math.round(this.flatSpot * 100) / 100,
      d: Math.round(this.damage * 100) / 100
    };
  }

  deserialize(s) {
    if (!s) return this;
    if (s.c && s.c !== this.compoundKey) this.setCompound(s.c);
    this.wear = s.w ?? this.wear;
    this.surfaceTemp = s.t ?? this.surfaceTemp;
    this.coreTemp = s.ct ?? this.coreTemp;
    this.flatSpot = s.f ?? this.flatSpot;
    this.damage = s.d ?? this.damage;
    return this;
  }
}
