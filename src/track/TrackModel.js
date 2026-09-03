import { Vec3 } from '../math/Vec3.js';
import { Spline } from '../math/Spline.js';
import { clamp, clamp01, lerp, smoothstep, wrapRange, circularDelta } from '../math/MathUtils.js';
import { SurfaceType, surfaceHeightOffset } from '../physics/Surfaces.js';
import * as Apex from './circuitApex.js';

/**
 * ============================================================================
 *  TRACK MODEL
 * ============================================================================
 *
 * Turns a circuit definition into something the simulation can query tens of
 * thousands of times a second.
 *
 * `sampleGround` is on the hottest path in the whole game — four calls per car
 * per physics substep, so roughly 19,000 calls a second with a full grid at
 * 240 Hz. A nearest-point search along the spline would be far too slow, so the
 * centreline is pre-sampled at one-metre intervals and a uniform spatial grid
 * maps any world position straight to a nearby sample index. From there only a
 * handful of samples need checking.
 */

const SAMPLE_SPACING = 1.0;   // metres between centreline samples
const GRID_CELL = 8.0;        // metres per spatial grid cell
const GRID_MARK_RADIUS = 90;  // how far each sample stamps itself into the grid

/** Interpolate a [fraction, value] profile with a smooth blend. */
function sampleProfile(profile, t) {
  const f = wrapRange(t, 1);
  if (f <= profile[0][0]) return profile[0][1];
  for (let i = 1; i < profile.length; i++) {
    if (f <= profile[i][0]) {
      const a = profile[i - 1], b = profile[i];
      const span = b[0] - a[0];
      const u = span > 1e-9 ? (f - a[0]) / span : 0;
      return lerp(a[1], b[1], smoothstep(0, 1, u));
    }
  }
  return profile[profile.length - 1][1];
}

export class TrackModel {
  constructor(circuit = Apex) {
    this.circuit = circuit;
    this.info = circuit.CIRCUIT_INFO;
    this.name = circuit.CIRCUIT_INFO.name;

    this._buildCentreline();
    this._buildSpatialGrid();
    this._buildFeatures();
    this._buildPitLane();
    this._buildGrid();
    this._buildBarriers();
    this._buildRacingLines();

    // Rubber laid down on the racing line, 0..1, evolving during a session.
    this.rubber = new Float32Array(this.sampleCount).fill(0.15);
    // Per-sample wetness and standing water, driven by the weather system.
    // `wetness` is the OFF-LINE baseline; `lineDry` is how far traffic has
    // swept the racing line clear of it. Storing the dry line as its own
    // channel, resolved laterally at query time, is what lets a drying track
    // have a usable line while the rest of the circuit is still soaked —
    // a single value per sample could not represent that at all.
    this.wetness = new Float32Array(this.sampleCount).fill(0);
    this.waterDepth = new Float32Array(this.sampleCount).fill(0);
    this.lineDry = new Float32Array(this.sampleCount).fill(0);
  }

  // -------------------------------------------------------------------------
  //  Geometry construction
  // -------------------------------------------------------------------------

  /**
   * Walk the layout description to produce centreline control points, then
   * resample the resulting spline at a uniform arc length.
   */
  _buildCentreline() {
    const raw = [];
    let x = 0, z = 0, hdg = 0;
    raw.push({ x, z });

    // The turtle walk. Heading 0 points along +Z; positive angles turn right,
    // matching the clockwise direction of the circuit.
    // Control points are laid down at a roughly uniform arc length everywhere.
    // Mixing 25 m spacing on the straights with 2 m spacing round the hairpin
    // makes a Catmull-Rom spline overshoot badly at the transitions — enough to
    // put a spurious 3 m radius in the middle of a 21 m corner.
    const CONTROL_SPACING = 6.0;

    for (const seg of this.circuit.LAYOUT) {
      if (seg.t === 's') {
        const n = Math.max(2, Math.round(seg.len / CONTROL_SPACING));
        for (let i = 1; i <= n; i++) {
          const d = seg.len / n;
          x += Math.sin(hdg) * d;
          z += Math.cos(hdg) * d;
          raw.push({ x, z });
        }
      } else {
        const rad = seg.deg * Math.PI / 180;
        const arcLen = Math.abs(rad) * seg.r;
        const n = Math.max(4, Math.round(arcLen / CONTROL_SPACING));
        for (let i = 1; i <= n; i++) {
          const dA = rad / n;
          const chord = 2 * seg.r * Math.sin(Math.abs(dA) / 2);
          const mid = hdg + dA / 2;
          x += Math.sin(mid) * chord;
          z += Math.cos(mid) * chord;
          hdg += dA;
          raw.push({ x, z });
        }
      }
    }
    // The walk returns to within half a metre of the start; drop the duplicate
    // final point so the closed spline does not double back on itself.
    raw.pop();

    // A first pass with flat elevation gives the true planform length, which is
    // needed before elevation can be applied as a function of lap fraction.
    const flat = new Spline(raw.map((p) => ({ x: p.x, y: 0, z: p.z })), true, 24);
    this.planformLength = flat.length;

    // Resample uniformly and attach elevation, width and banking.
    const count = Math.max(64, Math.round(flat.length / SAMPLE_SPACING));
    this.sampleCount = count;
    this.length = flat.length;
    this.sampleSpacing = flat.length / count;

    this.sx = new Float64Array(count);
    this.sy = new Float64Array(count);
    this.sz = new Float64Array(count);
    this.tx = new Float64Array(count);   // tangent (horizontal, normalised)
    this.tz = new Float64Array(count);
    this.lx = new Float64Array(count);   // lateral (right-hand side of travel)
    this.lz = new Float64Array(count);
    this.dist = new Float64Array(count);
    this.width = new Float32Array(count);
    this.banking = new Float32Array(count);
    this.gradient = new Float32Array(count);
    this.curvature = new Float32Array(count);

    const p = new Vec3();
    const t = new Vec3();
    for (let i = 0; i < count; i++) {
      const d = i * this.sampleSpacing;
      flat.pointAtDistance(d, p);
      flat.tangentAtDistance(d, t);
      const frac = d / flat.length;

      this.sx[i] = p.x;
      this.sz[i] = p.z;
      this.sy[i] = sampleProfile(this.circuit.ELEVATION, frac);
      this.dist[i] = d;

      // Horizontal tangent and the lateral axis to its right.
      const tl = Math.hypot(t.x, t.z) || 1;
      this.tx[i] = t.x / tl;
      this.tz[i] = t.z / tl;
      this.lx[i] = this.tz[i];
      this.lz[i] = -this.tx[i];

      this.width[i] = sampleProfile(this.circuit.WIDTH_PROFILE, frac);
      this.banking[i] = sampleProfile(this.circuit.BANKING, frac);
      // Negated so the sign reads naturally everywhere downstream: POSITIVE
      // curvature means the circuit turns to the RIGHT, and therefore that the
      // inside of the corner is at positive lateral offset. The raw spline
      // curvature uses the opposite convention.
      this.curvature[i] = -flat.curvatureAtDistance(d, 4);
    }

    // Banking is authored as a magnitude; give it the sign that raises the
    // OUTSIDE of each corner. Without this every right-hander ends up banked
    // the wrong way, tipping the car toward the outside exactly where it is
    // already loaded hardest.
    //
    // The sign has to come in SMOOTHLY. Using Math.sign() flips it abruptly
    // wherever curvature crosses zero — and on a straight, curvature hovers
    // around zero and flickers — which turns a 3-degree cross-slope into a
    // washboard that throws the car off the road. tanh ramps the banking in
    // with the corner and fades it to nothing on the straights.
    for (let i = 0; i < count; i++) {
      this.banking[i] = Math.abs(this.banking[i]) * -Math.tanh(this.curvature[i] * 220);
    }
    // Smooth over ~24 m so banking transitions are gradual, as they are when a
    // circuit is actually built.
    {
      const radius = Math.max(1, Math.round(24 / this.sampleSpacing));
      const src = Float32Array.from(this.banking);
      for (let i = 0; i < count; i++) {
        let sum = 0, w = 0;
        for (let k = -radius; k <= radius; k++) {
          const j = (i + k + count) % count;
          const ww = 1 - Math.abs(k) / (radius + 1);
          sum += src[j] * ww; w += ww;
        }
        this.banking[i] = sum / w;
      }
    }

    // Longitudinal gradient, from the elevation of neighbouring samples.
    for (let i = 0; i < count; i++) {
      const a = this.sy[(i - 1 + count) % count];
      const b = this.sy[(i + 1) % count];
      this.gradient[i] = (b - a) / (2 * this.sampleSpacing);
    }

    // A 3D spline over the finished samples, used for cameras and the renderer.
    const every = Math.max(1, Math.round(6 / this.sampleSpacing));
    const pts3d = [];
    for (let i = 0; i < count; i += every) {
      pts3d.push({ x: this.sx[i], y: this.sy[i], z: this.sz[i] });
    }
    this.spline = new Spline(pts3d, true, 16);

    // Bounding box, for the spatial grid and the minimap.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      if (this.sx[i] < minX) minX = this.sx[i];
      if (this.sx[i] > maxX) maxX = this.sx[i];
      if (this.sz[i] < minZ) minZ = this.sz[i];
      if (this.sz[i] > maxZ) maxZ = this.sz[i];
    }
    const margin = 140;
    this.bounds = {
      minX: minX - margin, maxX: maxX + margin,
      minZ: minZ - margin, maxZ: maxZ + margin
    };
  }

  /**
   * Uniform grid mapping any world position to a nearby centreline sample.
   * Built by stamping each sample outward rather than searching per cell, which
   * keeps construction to roughly a million operations instead of hundreds of
   * millions.
   */
  _buildSpatialGrid() {
    const b = this.bounds;
    this.gridW = Math.ceil((b.maxX - b.minX) / GRID_CELL) + 1;
    this.gridH = Math.ceil((b.maxZ - b.minZ) / GRID_CELL) + 1;
    this.gridIndex = new Int32Array(this.gridW * this.gridH).fill(-1);
    const bestDist = new Float32Array(this.gridW * this.gridH).fill(Infinity);

    const r = Math.ceil(GRID_MARK_RADIUS / GRID_CELL);
    for (let i = 0; i < this.sampleCount; i++) {
      const px = this.sx[i], pz = this.sz[i];
      const cx = Math.floor((px - b.minX) / GRID_CELL);
      const cz = Math.floor((pz - b.minZ) / GRID_CELL);
      for (let dz = -r; dz <= r; dz++) {
        const gz = cz + dz;
        if (gz < 0 || gz >= this.gridH) continue;
        for (let dx = -r; dx <= r; dx++) {
          const gx = cx + dx;
          if (gx < 0 || gx >= this.gridW) continue;
          const wx = b.minX + (gx + 0.5) * GRID_CELL;
          const wz = b.minZ + (gz + 0.5) * GRID_CELL;
          const d = (wx - px) * (wx - px) + (wz - pz) * (wz - pz);
          const k = gz * this.gridW + gx;
          if (d < bestDist[k]) { bestDist[k] = d; this.gridIndex[k] = i; }
        }
      }
    }

    // Any cell still unassigned (far outside the circuit) falls back to a
    // linear scan on first use; in practice the margin makes this rare.
    this._gridFallback = 0;
  }

  /** Named features and per-sample metadata derived from the layout. */
  _buildFeatures() {
    const features = [];
    let dist = 0;
    for (const seg of this.circuit.LAYOUT) {
      const len = seg.t === 's'
        ? seg.len
        : Math.abs(seg.deg * Math.PI / 180) * seg.r;
      if (seg.name) {
        features.push({
          name: seg.name,
          kind: seg.kind || (seg.t === 'a' ? 'corner' : 'straight'),
          corner: seg.corner ?? null,
          radius: seg.t === 'a' ? seg.r : Infinity,
          direction: seg.t === 'a' ? Math.sign(seg.deg) : 0,
          startDistance: dist,
          endDistance: dist + len,
          length: len
        });
      }
      dist += len;
    }
    // The walk length and the resampled spline length differ by a fraction of a
    // percent; rescale so feature distances line up with the sampled track.
    const scale = this.length / dist;
    for (const f of features) {
      f.startDistance *= scale;
      f.endDistance *= scale;
      f.length *= scale;
      f.midDistance = (f.startDistance + f.endDistance) * 0.5;
    }
    this.features = features;
    this.corners = features.filter((f) => f.corner != null);

    // Sectors, DRS zones and traps in absolute metres.
    this.sectors = this.circuit.SECTORS.map((s) => ({
      ...s,
      fromDistance: s.from * this.length,
      toDistance: s.to * this.length
    }));
    this.drsZones = this.circuit.DRS_ZONES.map((z) => ({
      ...z,
      detectionDistance: z.detectionFraction * this.length,
      startDistance: z.startFraction * this.length,
      endDistance: z.endFraction * this.length
    }));
    this.speedTraps = (this.circuit.SPEED_TRAPS || []).map((t) => ({
      ...t, distance: t.fraction * this.length
    }));

    // Per-sample runoff description, so `sampleGround` never has to search.
    this.runoffType = new Uint8Array(this.sampleCount);
    this.runoffWidth = new Float32Array(this.sampleCount);
    for (let i = 0; i < this.sampleCount; i++) {
      const f = this.dist[i] / this.length;
      let entry = this.circuit.RUNOFF_PROFILE[0];
      for (const r of this.circuit.RUNOFF_PROFILE) {
        if (f >= r.from && f < r.to) { entry = r; break; }
      }
      this.runoffType[i] = entry.type;
      this.runoffWidth[i] = entry.width;
    }
  }

  /**
   * The pit lane, built as its own spline offset from the racing surface. It is
   * a real path with a real length, so the time cost of a stop comes out of
   * driving it at the limiter rather than from a fixed penalty.
   */
  _buildPitLane() {
    const cfg = this.circuit.PIT_LANE;
    this.pit = { ...cfg };
    const entryD = cfg.entryFraction * this.length;
    const exitD = cfg.exitFraction * this.length;

    // Walk from entry to exit the "long way" if the pit lane crosses the line.
    let span = exitD - entryD;
    if (span < 0) span += this.length;
    this.pit.entryDistance = entryD;
    this.pit.exitDistance = exitD;
    this.pit.span = span;

    const steps = Math.max(24, Math.round(span / 8));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const d = wrapRange(entryD + span * u, this.length);
      // Blend the lateral offset in and out so the pit lane merges smoothly
      // with the racing surface at both ends instead of stepping sideways.
      const blend = smoothstep(0, 0.16, u) * (1 - smoothstep(0.86, 1, u));
      const off = cfg.offset * blend;
      const s = this._sampleAtDistance(d);
      pts.push({
        x: s.x + s.lx * off,
        y: s.y + 0.02,
        z: s.z + s.lz * off
      });
    }
    this.pitSpline = new Spline(pts, false, 18);
    this.pit.laneLength = this.pitSpline.length;
    this.pit.speedLimit = cfg.speedLimitKmh / 3.6;

    // Pit box positions along the lane.
    this.pit.boxes = [];
    for (let i = 0; i < 24; i++) {
      const d = this.pit.laneLength * cfg.boxStart + i * cfg.boxSpacing;
      if (d > this.pit.laneLength - 60) break;
      const p = this.pitSpline.pointAtDistance(d, new Vec3());
      const t = this.pitSpline.tangentAtDistance(d, new Vec3());
      this.pit.boxes.push({
        index: i,
        distance: d,
        position: p,
        heading: Math.atan2(t.x, t.z)
      });
    }
  }

  /** Starting grid slots, staggered either side of the centreline. */
  _buildGrid() {
    const g = this.circuit.GRID;
    this.gridSlots = [];
    for (let i = 0; i < 24; i++) {
      const row = Math.floor(i / 2);
      const side = (i % 2 === 0 ? g.poleSide : -g.poleSide);
      // Measured backwards from the start/finish line.
      const d = wrapRange(-g.poleOffset - row * g.rowSpacing, this.length);
      const s = this._sampleAtDistance(d);
      const off = side * g.lateralOffset;
      this.gridSlots.push({
        index: i,
        position: new Vec3(s.x + s.lx * off, s.y + 0.02, s.z + s.lz * off),
        heading: Math.atan2(s.tx, s.tz),
        distance: d,
        lateral: off
      });
    }
  }

  /**
   * Barriers as a polyline either side of the runoff. Stored per sample so the
   * collision query is a direct index lookup rather than a search.
   */
  _buildBarriers() {
    const n = this.sampleCount;
    this.barrierLeft = new Float32Array(n * 3);
    this.barrierRight = new Float32Array(n * 3);
    this.barrierOffsetL = new Float32Array(n);
    this.barrierOffsetR = new Float32Array(n);
    this.barrierType = new Uint8Array(n); // 0 = solid wall, 1 = energy absorbing

    for (let i = 0; i < n; i++) {
      const half = this.width[i] * 0.5;
      const runoff = this.runoffWidth[i];
      const offset = half + this.circuit.KERB_WIDTH + runoff;
      this.barrierOffsetL[i] = offset;
      this.barrierOffsetR[i] = offset;
      // Tyre walls (energy absorbing) at the slow corners, where cars arrive
      // head-on; steel barriers along the fast, glancing sections.
      const c = Math.abs(this.curvature[i]);
      this.barrierType[i] = c > 0.012 ? 1 : 0;

      this.barrierLeft[i * 3] = this.sx[i] - this.lx[i] * offset;
      this.barrierLeft[i * 3 + 1] = this.sy[i];
      this.barrierLeft[i * 3 + 2] = this.sz[i] - this.lz[i] * offset;
      this.barrierRight[i * 3] = this.sx[i] + this.lx[i] * offset;
      this.barrierRight[i * 3 + 1] = this.sy[i];
      this.barrierRight[i * 3 + 2] = this.sz[i] + this.lz[i] * offset;
    }
  }

  /**
   * Racing lines, as a lateral offset from the centreline per sample.
   *
   * The ideal line is generated from curvature: turn in from the outside, clip
   * the apex, run wide on exit. It is then smoothed, because a line the car
   * cannot physically follow is no use to the AI or to the driving aid.
   */
  _buildRacingLines() {
    const n = this.sampleCount;
    const ds = this.sampleSpacing;
    const raw = new Float32Array(n);

    // Box average of the centreline curvature over +/- `radius` samples.
    const avgCurv = (radius) => {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0, w = 0;
        for (let k = -radius; k <= radius; k++) {
          const j = (i + k + n) % n;
          const ww = 1 - Math.abs(k) / (radius + 1);
          sum += this.curvature[j] * ww; w += ww;
        }
        out[i] = sum / w;
      }
      return out;
    };

    // The line is built from the DIFFERENCE between a narrow and a wide average
    // of curvature.
    //
    // At the apex the local curvature is at its highest and exceeds the corner's
    // broader average, so the difference is positive and the line goes to the
    // inside. On the approach and on the exit the local curvature is still near
    // zero while the wide average already sees the corner, so the difference is
    // negative and the line goes to the outside. That produces the classic
    // outside-inside-outside line for free.
    //
    // A single smoothed curvature — which is what an average alone gives —
    // cannot do this: it puts the car on the INSIDE the whole way through,
    // which makes the line's radius tighter than the centreline's and the
    // corner harder rather than easier.
    const narrow = avgCurv(Math.max(2, Math.round(22 / ds)));
    const wide = avgCurv(Math.max(4, Math.round(140 / ds)));

    const diff = new Float32Array(n);
    for (let i = 0; i < n; i++) diff[i] = narrow[i] - wide[i];

    // Normalise the amplitude LOCALLY rather than globally. A driver uses the
    // full width of the road in every corner, tight or fast; scaling the whole
    // circuit by its single sharpest corner would leave every other corner
    // barely using the road at all.
    const magRadius = Math.max(4, Math.round(160 / ds));
    const localMag = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let k = -magRadius; k <= magRadius; k++) {
        const j = (i + k + n) % n;
        const a = Math.abs(diff[j]);
        if (a > peak) peak = a;
      }
      localMag[i] = peak;
    }

    for (let i = 0; i < n; i++) {
      const usable = this.width[i] * 0.5 - 1.9;   // keep the car's width on the road
      // Below this the road is effectively straight and the line stays central.
      const STRAIGHT_FLOOR = 0.0016;
      const mag = Math.max(localMag[i], STRAIGHT_FLOOR);
      const commit = clamp01((localMag[i] - STRAIGHT_FLOOR * 0.5) / (STRAIGHT_FLOOR * 2));
      raw[i] = clamp(diff[i] / mag, -1, 1) * usable * commit;
    }

    // Two smoothing passes: a racing line has to be continuous in curvature,
    // not just in position.
    const smooth = (src, radius, passes) => {
      let cur = src;
      for (let p = 0; p < passes; p++) {
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          let s = 0, w = 0;
          for (let k = -radius; k <= radius; k++) {
            const j = (i + k + n) % n;
            const ww = 1 - Math.abs(k) / (radius + 1);
            s += cur[j] * ww; w += ww;
          }
          out[i] = s / w;
        }
        cur = out;
      }
      return cur;
    };

    this.lineRacing = smooth(raw, Math.round(26 / this.sampleSpacing), 2);

    // Defensive line: hug the inside of the circuit through the braking zones
    // so a following car cannot get down the inside.
    const def = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const half = this.width[i] * 0.5 - 1.8;
      const c = this.curvature[i];
      const inside = Math.sign(c) * half * 0.72;
      // Only defend where it matters — corner entry, not mid-corner.
      const t = clamp01(Math.abs(c) * 140);
      def[i] = lerp(this.lineRacing[i], inside, t * 0.8);
    }
    this.lineDefensive = smooth(def, Math.round(20 / this.sampleSpacing), 2);

    // Overtaking line: the opposite side to the racing line on approach, which
    // is longer but keeps the car alongside into the braking zone.
    const ovr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const half = this.width[i] * 0.5 - 1.8;
      ovr[i] = clamp(-this.lineRacing[i] * 0.85, -half, half);
    }
    this.lineOvertake = smooth(ovr, Math.round(24 / this.sampleSpacing), 2);

    // Wet line: off the rubbered-in dry line, where there is more grip in the
    // rain — usually a wider, later apex.
    const wet = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const half = this.width[i] * 0.5 - 2.0;
      const off = this.lineRacing[i];
      // Shift away from the dry line by about two metres, staying on track.
      wet[i] = clamp(off - Math.sign(off || 1) * 2.6, -half, half);
    }
    this.lineWet = smooth(wet, Math.round(24 / this.sampleSpacing), 2);
  }

  // -------------------------------------------------------------------------
  //  Sampling helpers
  // -------------------------------------------------------------------------

  _sampleAtDistance(d) {
    const n = this.sampleCount;
    const f = wrapRange(d / this.sampleSpacing, n);
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const t = f - Math.floor(f);
    return {
      x: lerp(this.sx[i0], this.sx[i1], t),
      y: lerp(this.sy[i0], this.sy[i1], t),
      z: lerp(this.sz[i0], this.sz[i1], t),
      tx: lerp(this.tx[i0], this.tx[i1], t),
      tz: lerp(this.tz[i0], this.tz[i1], t),
      lx: lerp(this.lx[i0], this.lx[i1], t),
      lz: lerp(this.lz[i0], this.lz[i1], t),
      width: lerp(this.width[i0], this.width[i1], t),
      banking: lerp(this.banking[i0], this.banking[i1], t),
      gradient: lerp(this.gradient[i0], this.gradient[i1], t),
      curvature: lerp(this.curvature[i0], this.curvature[i1], t),
      index: i0
    };
  }

  /** Position on the centreline at a distance, into `out`. */
  pointAtDistance(d, out = new Vec3()) {
    const s = this._sampleAtDistance(d);
    return out.set(s.x, s.y, s.z);
  }

  /** A point on the track at a distance and lateral offset. */
  pointAt(d, lateral, out = new Vec3()) {
    const s = this._sampleAtDistance(d);
    const bankRise = Math.tan(s.banking) * lateral;
    return out.set(s.x + s.lx * lateral, s.y + bankRise, s.z + s.lz * lateral);
  }

  /**
   * Heading of a racing line at a distance: the circuit's own heading plus the
   * angle contributed by the line moving across the track.
   */
  lineHeadingAt(d, line = 'racing', h = 6) {
    const a = this.lineOffsetAt(d - h, line);
    const b = this.lineOffsetAt(d + h, line);
    return this.headingAtDistance(d) + Math.atan2(b - a, 2 * h);
  }

  /** Unit vector pointing to the right of the direction of travel. */
  lateralDirAt(d, out = new Vec3()) {
    const s = this._sampleAtDistance(d);
    return out.set(s.lx, 0, s.lz);
  }

  headingAtDistance(d) {
    const s = this._sampleAtDistance(d);
    return Math.atan2(s.tx, s.tz);
  }

  widthAtDistance(d) {
    return this._sampleAtDistance(d).width;
  }

  curvatureAtDistance(d) {
    return this._sampleAtDistance(d).curvature;
  }

  /** Racing-line lateral offset at a distance, by line name. */
  lineOffsetAt(d, line = 'racing') {
    const arr = line === 'defensive' ? this.lineDefensive
              : line === 'overtake' ? this.lineOvertake
              : line === 'wet' ? this.lineWet
              : this.lineRacing;
    const n = this.sampleCount;
    const f = wrapRange(d / this.sampleSpacing, n);
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    return lerp(arr[i0], arr[i1], f - Math.floor(f));
  }

  /** Nearest centreline sample index to a world XZ position. */
  nearestIndex(x, z) {
    const b = this.bounds;
    const gx = Math.floor((x - b.minX) / GRID_CELL);
    const gz = Math.floor((z - b.minZ) / GRID_CELL);
    let seed = -1;
    if (gx >= 0 && gx < this.gridW && gz >= 0 && gz < this.gridH) {
      seed = this.gridIndex[gz * this.gridW + gx];
    }
    const n = this.sampleCount;
    if (seed < 0) {
      // Far outside the circuit: coarse scan, then refine.
      let best = -1, bestD = Infinity;
      for (let i = 0; i < n; i += 16) {
        const dx = x - this.sx[i], dz = z - this.sz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      seed = best;
    }
    // Local refinement around the seed.
    let best = seed, bestD = Infinity;
    const span = 14;
    for (let k = -span; k <= span; k++) {
      const i = (seed + k + n) % n;
      const dx = x - this.sx[i], dz = z - this.sz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Project a world position onto the circuit.
   * @returns {{distance:number, lateral:number, index:number, onTrack:boolean}}
   */
  project(x, z, out = {}) {
    const i = this.nearestIndex(x, z);
    const dx = x - this.sx[i];
    const dz = z - this.sz[i];
    // Signed distance along the tangent gives sub-sample precision.
    const along = dx * this.tx[i] + dz * this.tz[i];
    const lateral = dx * this.lx[i] + dz * this.lz[i];
    out.index = i;
    out.distance = wrapRange(this.dist[i] + along, this.length);
    out.lateral = lateral;
    out.halfWidth = this.width[i] * 0.5;
    out.onTrack = Math.abs(lateral) <= out.halfWidth;
    return out;
  }

  // -------------------------------------------------------------------------
  //  Hot path: ground sampling for the physics
  // -------------------------------------------------------------------------

  /**
   * Sample the road surface beneath a world XZ position.
   *
   * Fills `out` with the contact plane, surface type and local conditions. This
   * is the single most-called function in the simulation.
   */
  sampleGround(x, z, out, env) {
    const i = this.nearestIndex(x, z);
    const dx = x - this.sx[i];
    const dz = z - this.sz[i];
    const along = dx * this.tx[i] + dz * this.tz[i];
    const lateral = dx * this.lx[i] + dz * this.lz[i];
    const absLat = Math.abs(lateral);

    const half = this.width[i] * 0.5;
    const kerbEdge = half + this.circuit.KERB_WIDTH;
    const runoffEdge = kerbEdge + this.runoffWidth[i];

    // --- Surface classification ------------------------------------------
    let surface;
    if (absLat <= half) {
      surface = SurfaceType.ASPHALT;
    } else if (absLat <= kerbEdge) {
      surface = SurfaceType.KERB;
    } else if (absLat <= runoffEdge) {
      surface = this.runoffType[i];
    } else {
      surface = SurfaceType.GRASS;
    }

    // The pit lane overrides the surface where it runs alongside the circuit.
    const pitLat = this._pitLateralAt(i);
    if (pitLat !== null) {
      const d = Math.abs(lateral - pitLat);
      if (d <= this.pit.width * 0.5) surface = SurfaceType.PIT_LANE;
      else if (d <= this.pit.width * 0.5 + 1.0 && absLat > kerbEdge) {
        surface = SurfaceType.ASPHALT;
      }
    }

    // --- Height ------------------------------------------------------------
    // Longitudinal interpolation plus banking rise, then the surface's own
    // texture. Kerbs get their ribs here, which is what actually shakes the car.
    const baseY = this.sy[i] + this.gradient[i] * along;
    let y = baseY + Math.tan(this.banking[i]) * lateral;

    if (surface === SurfaceType.KERB) {
      // Kerbs sit slightly proud of the racing surface and are ribbed.
      const into = (absLat - half) / this.circuit.KERB_WIDTH;
      y += 0.035 + surfaceHeightOffset(surface, this.dist[i] + along, lateral);
      // The far edge drops away to the runoff.
      y -= smoothstep(0.75, 1.0, into) * 0.045;
    } else if (surface !== SurfaceType.ASPHALT && surface !== SurfaceType.PIT_LANE) {
      // Runoff and grass sit below the track and are uneven.
      y -= 0.055;
      y += surfaceHeightOffset(surface, this.dist[i] + along, lateral);
    } else {
      y += surfaceHeightOffset(surface, this.dist[i] + along, lateral);
    }

    // --- Contact normal ----------------------------------------------------
    // Built from the longitudinal gradient and the lateral banking so the car
    // is genuinely pushed toward the inside on a banked corner.
    const g = this.gradient[i];
    const bank = Math.tan(this.banking[i]);
    // n = normalize(cross(tangent3d, lateral3d))
    const tX = this.tx[i], tY = g, tZ = this.tz[i];
    const lX = this.lx[i], lY = bank, lZ = this.lz[i];
    let nx = tY * lZ - tZ * lY;
    let ny = tZ * lX - tX * lZ;
    let nz = tX * lY - tY * lX;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

    out.point.set(x, y, z);
    out.normal.set(nx, ny, nz);
    out.surfaceType = surface;
    out.distanceAlong = wrapRange(this.dist[i] + along, this.length);
    out.lateral = lateral;
    out.index = i;

    // --- Conditions --------------------------------------------------------
    // How close this contact patch is to the racing line. Both rubber and the
    // dry line are laid down by traffic, so both follow it.
    const lineOff = this.lineRacing[i];
    const offLine = Math.abs(lateral - lineOff);
    const onLine = 1 - smoothstep(1.6, 5.2, offLine);

    const dried = 1 - this.lineDry[i] * onLine;
    out.wetness = this.wetness[i] * dried;
    out.waterDepth = this.waterDepth[i] * dried;
    out.rubber = surface === SurfaceType.ASPHALT ? this.rubber[i] * onLine : 0;

    return out;
  }

  /** Lateral offset of the pit lane at a sample index, or null if not present. */
  _pitLateralAt(i) {
    if (!this._pitLatCache) {
      const n = this.sampleCount;
      const cache = new Float32Array(n).fill(NaN);
      const entryD = this.pit.entryDistance;
      const span = this.pit.span;
      for (let k = 0; k <= span; k += this.sampleSpacing) {
        const d = wrapRange(entryD + k, this.length);
        const idx = Math.floor(d / this.sampleSpacing) % n;
        const u = k / span;
        const blend = smoothstep(0, 0.16, u) * (1 - smoothstep(0.86, 1, u));
        cache[idx] = this.pit.offset * blend;
      }
      this._pitLatCache = cache;
    }
    const v = this._pitLatCache[i];
    return Number.isNaN(v) ? null : v;
  }

  // -------------------------------------------------------------------------
  //  Barriers
  // -------------------------------------------------------------------------

  /**
   * Test a sphere against the trackside barriers.
   * @returns {boolean} true on contact, with `out` filled in
   */
  queryBarrier(point, radius, out) {
    const i = this.nearestIndex(point.x, point.z);
    const dx = point.x - this.sx[i];
    const dz = point.z - this.sz[i];
    const lateral = dx * this.lx[i] + dz * this.lz[i];
    const side = lateral >= 0 ? 1 : -1;
    const limit = side > 0 ? this.barrierOffsetR[i] : this.barrierOffsetL[i];

    const overshoot = Math.abs(lateral) + radius - limit;
    if (overshoot <= 0) return false;

    // Normal points back toward the circuit.
    out.normal.set(-side * this.lx[i], 0, -side * this.lz[i]);
    out.penetration = overshoot;
    const contactLat = side * limit;
    out.point.set(
      this.sx[i] + this.lx[i] * contactLat,
      point.y,
      this.sz[i] + this.lz[i] * contactLat
    );
    out.type = this.barrierType[i];
    out.hit = true;
    return true;
  }

  // -------------------------------------------------------------------------
  //  Race queries
  // -------------------------------------------------------------------------

  sectorAtDistance(d) {
    const f = wrapRange(d, this.length) / this.length;
    for (const s of this.sectors) {
      if (f >= s.from && f < s.to) return s.index;
    }
    return this.sectors.length - 1;
  }

  /** Which DRS activation zone (if any) contains this distance. */
  drsZoneAt(d) {
    const f = wrapRange(d, this.length) / this.length;
    for (const z of this.drsZones) {
      if (z.startFraction < z.endFraction) {
        if (f >= z.startFraction && f <= z.endFraction) return z;
      } else if (f >= z.startFraction || f <= z.endFraction) {
        // Zone wraps the start/finish line.
        return z;
      }
    }
    return null;
  }

  /** Nearest named feature to a distance, for the HUD's corner readout. */
  featureAt(d) {
    const dd = wrapRange(d, this.length);
    let best = null, bestD = Infinity;
    for (const f of this.features) {
      const delta = Math.abs(circularDelta(f.midDistance, dd, this.length));
      if (delta < bestD) { bestD = delta; best = f; }
    }
    return best;
  }

  /** True if a world position is inside the pit lane corridor. */
  isInPitLane(x, z) {
    const i = this.nearestIndex(x, z);
    const pitLat = this._pitLateralAt(i);
    if (pitLat === null || Math.abs(pitLat) < 4) return false;
    const dx = x - this.sx[i];
    const dz = z - this.sz[i];
    const lateral = dx * this.lx[i] + dz * this.lz[i];
    return Math.abs(lateral - pitLat) <= this.pit.width * 0.5 + 1.5;
  }

  /**
   * Update the rubbering-in of the racing line. Grip builds where cars actually
   * drive and washes away in the rain.
   */
  evolveRubber(dt, carPositions, wetness) {
    const rate = dt * 0.0065;
    for (const p of carPositions) {
      const i = this.nearestIndex(p.x, p.z);
      const spread = 3;
      for (let k = -spread; k <= spread; k++) {
        const j = (i + k + this.sampleCount) % this.sampleCount;
        this.rubber[j] = Math.min(1, this.rubber[j] + rate);
      }
    }
    if (wetness > 0.05) {
      const wash = dt * wetness * 0.02;
      for (let i = 0; i < this.sampleCount; i++) {
        this.rubber[i] = Math.max(0.1, this.rubber[i] - wash);
      }
    }
  }

  /** Minimap outline, decimated for cheap drawing. */
  getOutline(step = 12) {
    const pts = [];
    for (let i = 0; i < this.sampleCount; i += step) {
      pts.push({ x: this.sx[i], z: this.sz[i] });
    }
    return pts;
  }
}

export function createTrack(circuit) {
  return new TrackModel(circuit);
}
