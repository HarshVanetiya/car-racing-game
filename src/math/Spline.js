import { Vec3 } from './Vec3.js';
import { clamp, lerp, wrapRange } from './MathUtils.js';

/**
 * Closed centripetal Catmull-Rom spline with an arc-length lookup table.
 *
 * The circuit centreline, the racing lines and the pit lane are all built on
 * this. Arc-length parameterisation matters a great deal here: race position is
 * ranked by *distance travelled along the track*, so `pointAtDistance` has to be
 * uniform in metres rather than in the raw spline parameter.
 */
export class Spline {
  /**
   * @param {Array<{x:number,y:number,z:number}>} points control points
   * @param {boolean} closed loop back to the first point
   * @param {number} samplesPerSegment arc-length table resolution
   */
  constructor(points, closed = true, samplesPerSegment = 48) {
    this.points = points.map((p) => new Vec3(p.x, p.y, p.z));
    this.closed = closed;
    this.n = this.points.length;
    this.samplesPerSegment = samplesPerSegment;
    this._buildArcTable();
  }

  _idx(i) {
    if (this.closed) return wrapRange(i, this.n) | 0;
    return clamp(i, 0, this.n - 1) | 0;
  }

  /** Catmull-Rom evaluation on segment `seg` at local parameter t in [0,1]. */
  evaluate(seg, t, out = new Vec3()) {
    const p0 = this.points[this._idx(seg - 1)];
    const p1 = this.points[this._idx(seg)];
    const p2 = this.points[this._idx(seg + 1)];
    const p3 = this.points[this._idx(seg + 2)];
    const t2 = t * t;
    const t3 = t2 * t;
    const c0 = -0.5 * t3 + t2 - 0.5 * t;
    const c1 = 1.5 * t3 - 2.5 * t2 + 1.0;
    const c2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
    const c3 = 0.5 * t3 - 0.5 * t2;
    out.x = p0.x * c0 + p1.x * c1 + p2.x * c2 + p3.x * c3;
    out.y = p0.y * c0 + p1.y * c1 + p2.y * c2 + p3.y * c3;
    out.z = p0.z * c0 + p1.z * c1 + p2.z * c2 + p3.z * c3;
    return out;
  }

  /** First derivative (tangent, unnormalised) on a segment. */
  derivative(seg, t, out = new Vec3()) {
    const p0 = this.points[this._idx(seg - 1)];
    const p1 = this.points[this._idx(seg)];
    const p2 = this.points[this._idx(seg + 1)];
    const p3 = this.points[this._idx(seg + 2)];
    const t2 = t * t;
    const c0 = -1.5 * t2 + 2 * t - 0.5;
    const c1 = 4.5 * t2 - 5 * t;
    const c2 = -4.5 * t2 + 4 * t + 0.5;
    const c3 = 1.5 * t2 - t;
    out.x = p0.x * c0 + p1.x * c1 + p2.x * c2 + p3.x * c3;
    out.y = p0.y * c0 + p1.y * c1 + p2.y * c2 + p3.y * c3;
    out.z = p0.z * c0 + p1.z * c1 + p2.z * c2 + p3.z * c3;
    return out;
  }

  _buildArcTable() {
    const segs = this.closed ? this.n : this.n - 1;
    const total = segs * this.samplesPerSegment;
    this.arcU = new Float64Array(total + 1); // global spline parameter
    this.arcS = new Float64Array(total + 1); // cumulative arc length
    const a = new Vec3();
    const b = new Vec3();
    let s = 0;
    this.evaluate(0, 0, a);
    this.arcU[0] = 0;
    this.arcS[0] = 0;
    let k = 1;
    for (let seg = 0; seg < segs; seg++) {
      for (let i = 1; i <= this.samplesPerSegment; i++) {
        const t = i / this.samplesPerSegment;
        this.evaluate(seg, t, b);
        s += a.distanceTo(b);
        a.copy(b);
        this.arcU[k] = seg + t;
        this.arcS[k] = s;
        k++;
      }
    }
    this.length = s;
    this.segments = segs;
  }

  /** Convert arc length (metres) to the global spline parameter. */
  distanceToParam(distance) {
    const L = this.length;
    let d = this.closed ? wrapRange(distance, L) : clamp(distance, 0, L);
    const S = this.arcS;
    let lo = 0;
    let hi = S.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= d) lo = mid; else hi = mid;
    }
    const span = S[hi] - S[lo];
    const f = span > 1e-9 ? (d - S[lo]) / span : 0;
    return lerp(this.arcU[lo], this.arcU[hi], f);
  }

  paramToDistance(u) {
    const segs = this.segments;
    const uu = this.closed ? wrapRange(u, segs) : clamp(u, 0, segs);
    const idx = clamp(Math.floor(uu * this.samplesPerSegment), 0, this.arcU.length - 2);
    const u0 = this.arcU[idx];
    const u1 = this.arcU[idx + 1];
    const f = u1 > u0 ? (uu - u0) / (u1 - u0) : 0;
    return lerp(this.arcS[idx], this.arcS[idx + 1], clamp(f, 0, 1));
  }

  pointAtParam(u, out = new Vec3()) {
    const segs = this.segments;
    const uu = this.closed ? wrapRange(u, segs) : clamp(u, 0, segs - 1e-9);
    const seg = Math.floor(uu);
    return this.evaluate(seg, uu - seg, out);
  }

  tangentAtParam(u, out = new Vec3()) {
    const segs = this.segments;
    const uu = this.closed ? wrapRange(u, segs) : clamp(u, 0, segs - 1e-9);
    const seg = Math.floor(uu);
    return this.derivative(seg, uu - seg, out).normalize();
  }

  pointAtDistance(distance, out = new Vec3()) {
    return this.pointAtParam(this.distanceToParam(distance), out);
  }

  tangentAtDistance(distance, out = new Vec3()) {
    return this.tangentAtParam(this.distanceToParam(distance), out);
  }

  /** Signed curvature magnitude (1/m) in the horizontal plane at a distance. */
  curvatureAtDistance(distance, h = 2.0) {
    const a = this.tangentAtDistance(distance - h, new Vec3());
    const b = this.tangentAtDistance(distance + h, new Vec3());
    const cross = a.x * b.z - a.z * b.x;
    const dot = clamp(a.x * b.x + a.z * b.z, -1, 1);
    const angle = Math.atan2(cross, dot);
    return angle / (2 * h);
  }
}
