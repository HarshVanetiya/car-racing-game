import { clamp, clamp01, lerp, wrapRange } from '../math/MathUtils.js';

/** Must match the tire model, or the AI's target will not be achievable. */
const TIRE_REFERENCE_LOAD = 3400;
const TIRE_LOAD_SENSITIVITY = 0.160;

/**
 * Fraction of the theoretical four-tire limit a car actually realises. Covers
 * everything the closed-form solve above cannot: suspension compliance, camber
 * loss, the tires not all peaking at the same slip angle, and the fact that a
 * driver has to leave something in hand to make a corner exit. Calibrated
 * against the simulated car's own measured skidpad performance.
 */
const GRIP_UTILISATION = 0.90;

/**
 * Friction coefficient available at a given vertical load, mirroring the tire
 * model's own load sensitivity. Grip is NOT proportional to load: a heavily
 * loaded tire has a lower coefficient than a lightly loaded one.
 */
function muAtLoad(peakGrip, load) {
  const ratio = clamp(load / TIRE_REFERENCE_LOAD, 0.05, 4.0);
  return peakGrip * clamp(1 - TIRE_LOAD_SENSITIVITY * (ratio - 1), 0.55, 1.35);
}

/**
 * Total lateral force a car can generate at a given speed and corner radius,
 * accounting for lateral load transfer.
 *
 * This is the reason a car cannot simply use its peak friction coefficient: in
 * a corner the outside tires are loaded far beyond the reference and the inside
 * tires are unloaded, and because mu falls with load the pair together produce
 * less than two averagely-loaded tires would. Ignoring it makes the AI's target
 * speeds roughly 15% higher than the car can actually achieve, which is the
 * difference between a clean lap and running wide at every corner.
 */
function lateralCapacity(peakGrip, totalLoad, mass, lateralAccel, cogHeight, trackWidth) {
  const transfer = clamp(mass * lateralAccel * cogHeight / Math.max(0.8, trackWidth), 0, totalLoad * 0.48);
  const perTire = totalLoad / 4;
  const outer = perTire + transfer * 0.5;
  const inner = Math.max(0, perTire - transfer * 0.5);
  // Two axles, each with an outer and an inner tire.
  return 2 * (muAtLoad(peakGrip, outer) * outer + muAtLoad(peakGrip, inner) * inner);
}

/**
 * ============================================================================
 *  SPEED PROFILE
 * ============================================================================
 *
 * The achievable speed at every point on the circuit, for a given car and set
 * of conditions. Three passes:
 *
 *   1. CORNERING  — the fastest a car can go through each point's radius. This
 *                   has to be solved iteratively rather than in closed form,
 *                   because downforce depends on speed and the speed depends on
 *                   the grip that downforce provides.
 *   2. BRAKING    — a backward pass that pulls the profile down ahead of every
 *                   corner until it is reachable at the car's real deceleration.
 *                   The braking points fall out of this rather than being
 *                   authored.
 *   3. TRACTION   — a forward pass limiting how fast the profile can rise, since
 *                   a car cannot accelerate out of a hairpin instantly.
 *
 * The same profile drives the AI's target speed, the optional racing-line
 * assist's braking markers, and the strategy planner's lap-time estimates.
 */
export class SpeedProfile {
  /**
   * @param {TrackModel} track
   * @param {object} params car performance description
   */
  constructor(track, params = {}) {
    this.track = track;
    this.params = {
      mass: params.mass ?? 850,
      clA: params.clA ?? 4.10,
      cdA: params.cdA ?? 1.30,
      // Peak friction coefficient the tires can actually deliver. Scaled down
      // for AI skill, tire wear and wet conditions.
      grip: params.grip ?? 1.62,
      // Longitudinal capability, as a fraction of the lateral limit.
      brakeFactor: params.brakeFactor ?? 0.98,
      tractionFactor: params.tractionFactor ?? 0.72,
      maxSpeed: params.maxSpeed ?? 95,
      // Power-limited acceleration at speed (m/s^2 at 60 m/s).
      powerKw: params.powerKw ?? 740,
      airDensity: params.airDensity ?? 1.225,
      // Fraction of the theoretical limit the driver actually uses.
      confidence: params.confidence ?? 1.0,
      cogHeight: params.cogHeight ?? 0.279,
      trackWidth: params.trackWidth ?? 1.59,
      line: params.line ?? 'racing'
    };
    this.build();
  }

  setParams(patch) {
    Object.assign(this.params, patch);
    this.build();
  }

  build() {
    const t = this.track;
    const n = t.sampleCount;
    const p = this.params;
    const g = 9.80665;

    if (!this.speed || this.speed.length !== n) {
      this.speed = new Float32Array(n);
      this.corneringSpeed = new Float32Array(n);
      this.lineCurvature = new Float32Array(n);
      this.brakePoint = new Uint8Array(n);
      this.throttleHint = new Float32Array(n);
    }

    // --- Curvature of the chosen line, not of the centreline ---------------
    // The racing line straightens a corner considerably; using the centreline
    // curvature would make the AI several seconds a lap too slow.
    const lineArr = p.line === 'wet' ? t.lineWet
                  : p.line === 'defensive' ? t.lineDefensive
                  : p.line === 'overtake' ? t.lineOvertake
                  : t.lineRacing;
    const ds = t.sampleSpacing;
    // Wide stencil: the second derivative of the line offset is noisy over a
    // short baseline, and noise here becomes a phantom corner in the profile.
    const H = Math.max(2, Math.round(9 / ds));
    for (let i = 0; i < n; i++) {
      const im = (i - H + n) % n;
      const ip = (i + H) % n;
      // Curvature of a line offset by n(s) from the centreline:
      //   kappa_line ~= kappa / (1 - kappa * n)  +  n''
      // The offset's own second derivative is what makes a racing line quicker
      // than the centreline: at the apex the line is at its maximum offset, so
      // n'' is negative and it SUBTRACTS from the corner's curvature. Getting
      // this sign wrong makes the racing line tighter than the centreline,
      // which is the exact opposite of its purpose.
      const k = t.curvature[i];
      const off = lineArr[i];
      const denom = 1 - k * off;
      const base = Math.abs(denom) > 1e-6 ? k / denom : k;
      const h = H * ds;
      const d2 = (lineArr[ip] - 2 * lineArr[i] + lineArr[im]) / (h * h);
      this.lineCurvature[i] = base + d2;
    }

    // --- Pass 1: cornering limit -------------------------------------------
    // Longitudinal passes still use a single representative coefficient; only
    // the cornering solve needs the full load-transfer treatment.
    const mu = muAtLoad(p.grip, p.mass * g / 4) * p.confidence * GRIP_UTILISATION;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.lineCurvature[i]);
      if (k < 1e-5) {
        this.corneringSpeed[i] = p.maxSpeed;
        continue;
      }
      const r = 1 / k;
      // Banking helps: the road's own tilt carries part of the lateral load.
      // Track banking is already signed so the outside of the corner is raised,
      // so its magnitude always works in the car's favour.
      const bankTerm = Math.abs(Math.tan(t.banking[i]));

      // Solve for the speed at which the lateral force required to follow this
      // radius equals the lateral force the tires can produce at the load that
      // speed generates. Both sides depend on v, so it is solved iteratively.
      let v = 30;
      for (let it = 0; it < 30; it++) {
        const down = 0.5 * p.airDensity * p.clA * v * v;
        const totalLoad = p.mass * g + down;
        const a = v * v / r;
        const capacity = lateralCapacity(
          p.grip, totalLoad, p.mass, a, p.cogHeight, p.trackWidth
        ) * p.confidence * GRIP_UTILISATION;
        const vNew = Math.sqrt(Math.max(1, (capacity + p.mass * g * bankTerm) * r / p.mass));
        if (Math.abs(vNew - v) < 0.01) { v = vNew; break; }
        v = v * 0.55 + vNew * 0.45;
      }
      this.corneringSpeed[i] = Math.min(v, p.maxSpeed);
    }

    // Smooth the cornering limit slightly: a real driver reads a corner as one
    // radius rather than reacting to every metre of it.
    const smoothed = new Float32Array(n);
    const rad = Math.max(1, Math.round(9 / ds));
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let k = -rad; k <= rad; k++) {
        const j = (i + k + n) % n;
        if (this.corneringSpeed[j] < m) m = this.corneringSpeed[j];
      }
      smoothed[i] = m;
    }
    this.speed.set(smoothed);

    // --- Pass 2: braking (backward) ----------------------------------------
    // Two full laps of the loop so the constraint propagates all the way around
    // a closed circuit.
    for (let pass = 0; pass < 2; pass++) {
      for (let step = n - 1; step >= 0; step--) {
        const i = step;
        const next = (i + 1) % n;
        const vNext = this.speed[next];
        const v = this.speed[i];

        // Deceleration available here, given the load at this speed and the
        // lateral grip already being used for cornering.
        //
        // The friction coefficient MUST be evaluated at the load the car
        // actually carries at this speed. At 300 km/h downforce nearly trebles
        // the load on every tire and mu falls by about a quarter; using the
        // static-load value instead over-predicts braking by that much, and the
        // braking points it produces are far too late to make the corner.
        const down = 0.5 * p.airDensity * p.clA * v * v;
        const drag = 0.5 * p.airDensity * p.cdA * v * v;
        const totalLoad = p.mass * g + down;
        const muHere = muAtLoad(p.grip, totalLoad / 4) * p.confidence * GRIP_UTILISATION;
        const totalGrip = muHere * totalLoad * p.brakeFactor;
        const lateralUse = Math.min(
          1, (p.mass * v * v * Math.abs(this.lineCurvature[i])) / Math.max(1, totalGrip)
        );
        // Friction ellipse: what is left for braking after cornering.
        const longFrac = Math.sqrt(Math.max(0, 1 - lateralUse * lateralUse));
        const decel = (totalGrip * longFrac + drag) / p.mass;
        // Gradient: braking downhill is harder.
        const gradeAccel = -t.gradient[i] * g;

        const vMax = Math.sqrt(Math.max(0, vNext * vNext + 2 * Math.max(0.5, decel - gradeAccel) * ds));
        if (vMax < this.speed[i]) this.speed[i] = vMax;
      }
    }

    // --- Pass 3: traction / power (forward) --------------------------------
    for (let pass = 0; pass < 2; pass++) {
      for (let step = 0; step < n; step++) {
        const i = step;
        const prev = (i - 1 + n) % n;
        const vPrev = this.speed[prev];
        const v = Math.max(vPrev, 1);

        const down = 0.5 * p.airDensity * p.clA * v * v;
        const drag = 0.5 * p.airDensity * p.cdA * v * v;
        // Traction limit at the driven axle, again at the real load.
        const totalLoadF = p.mass * g + down;
        const muF = muAtLoad(p.grip, totalLoadF / 4) * p.confidence * GRIP_UTILISATION;
        const rearLoad = totalLoadF * 0.56;
        const tractionForce = muF * rearLoad * p.tractionFactor;
        // Power limit.
        const powerForce = (p.powerKw * 1000 * 0.92) / v;
        const force = Math.min(tractionForce, powerForce) - drag;

        const lateralUse = Math.min(
          1, (p.mass * v * v * Math.abs(this.lineCurvature[i])) /
             Math.max(1, muF * totalLoadF)
        );
        const longFrac = Math.sqrt(Math.max(0, 1 - lateralUse * lateralUse));
        const accel = (force * longFrac) / p.mass - t.gradient[i] * g;

        const vMax = Math.sqrt(Math.max(0, vPrev * vPrev + 2 * Math.max(0, accel) * ds));
        if (vMax < this.speed[i]) this.speed[i] = vMax;
      }
    }

    // --- Derived hints ------------------------------------------------------
    // A braking point is anywhere the profile is falling meaningfully; the
    // racing-line assist colours the track from this.
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const dv = this.speed[next] - this.speed[i];
      this.brakePoint[i] = dv < -0.06 ? 1 : 0;
      this.throttleHint[i] = clamp01(0.5 + dv * 3.0);
    }

    this.estimatedLapTime = this.computeLapTime();
  }

  computeLapTime() {
    const n = this.track.sampleCount;
    const ds = this.track.sampleSpacing;
    let t = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.max(3, (this.speed[i] + this.speed[(i + 1) % n]) * 0.5);
      t += ds / v;
    }
    return t;
  }

  /** Target speed at a distance around the lap. */
  speedAt(distance) {
    const n = this.track.sampleCount;
    const f = wrapRange(distance / this.track.sampleSpacing, n);
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    return lerp(this.speed[i0], this.speed[i1], f - Math.floor(f));
  }

  /**
   * The lowest target speed within `lookahead` metres. This is what a driver
   * actually brakes for — not the speed here, but the speed they need soon.
   */
  minSpeedAhead(distance, lookahead) {
    const n = this.track.sampleCount;
    const ds = this.track.sampleSpacing;
    const steps = Math.max(1, Math.round(lookahead / ds));
    let start = Math.floor(wrapRange(distance / ds, n));
    let min = Infinity, minAt = 0;
    for (let k = 0; k <= steps; k++) {
      const i = (start + k) % n;
      if (this.speed[i] < min) { min = this.speed[i]; minAt = k * ds; }
    }
    return { speed: min, distance: minAt };
  }

  curvatureAt(distance) {
    const n = this.track.sampleCount;
    const f = wrapRange(distance / this.track.sampleSpacing, n);
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    return lerp(this.lineCurvature[i0], this.lineCurvature[i1], f - Math.floor(f));
  }

  isBrakingZone(distance) {
    const n = this.track.sampleCount;
    const i = Math.floor(wrapRange(distance / this.track.sampleSpacing, n)) % n;
    return this.brakePoint[i] === 1;
  }
}
