import { Vec3 } from './Vec3.js';

/**
 * Row-major 3x3 matrix. Used for the chassis inertia tensor and its world-space
 * transform, which is what turns tire forces at the contact patches into a
 * physically correct yaw/pitch/roll response.
 */
export class Mat3 {
  constructor() {
    // m[row * 3 + col]
    this.m = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }

  identity() {
    const m = this.m;
    m[0] = 1; m[1] = 0; m[2] = 0;
    m[3] = 0; m[4] = 1; m[5] = 0;
    m[6] = 0; m[7] = 0; m[8] = 1;
    return this;
  }

  setDiagonal(x, y, z) {
    const m = this.m;
    m[0] = x; m[1] = 0; m[2] = 0;
    m[3] = 0; m[4] = y; m[5] = 0;
    m[6] = 0; m[7] = 0; m[8] = z;
    return this;
  }

  copy(o) {
    this.m.set(o.m);
    return this;
  }

  /** Build the rotation matrix of a unit quaternion. */
  setFromQuat(q) {
    const { x, y, z, w } = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const m = this.m;
    m[0] = 1 - (yy + zz); m[1] = xy - wz;       m[2] = xz + wy;
    m[3] = xy + wz;       m[4] = 1 - (xx + zz); m[5] = yz - wx;
    m[6] = xz - wy;       m[7] = yz + wx;       m[8] = 1 - (xx + yy);
    return this;
  }

  /** this = a * b */
  multiplyMatrices(a, b) {
    const A = a.m, B = b.m, m = this.m;
    const a0 = A[0], a1 = A[1], a2 = A[2];
    const a3 = A[3], a4 = A[4], a5 = A[5];
    const a6 = A[6], a7 = A[7], a8 = A[8];
    const b0 = B[0], b1 = B[1], b2 = B[2];
    const b3 = B[3], b4 = B[4], b5 = B[5];
    const b6 = B[6], b7 = B[7], b8 = B[8];
    m[0] = a0 * b0 + a1 * b3 + a2 * b6;
    m[1] = a0 * b1 + a1 * b4 + a2 * b7;
    m[2] = a0 * b2 + a1 * b5 + a2 * b8;
    m[3] = a3 * b0 + a4 * b3 + a5 * b6;
    m[4] = a3 * b1 + a4 * b4 + a5 * b7;
    m[5] = a3 * b2 + a4 * b5 + a5 * b8;
    m[6] = a6 * b0 + a7 * b3 + a8 * b6;
    m[7] = a6 * b1 + a7 * b4 + a8 * b7;
    m[8] = a6 * b2 + a7 * b5 + a8 * b8;
    return this;
  }

  transpose() {
    const m = this.m;
    let t;
    t = m[1]; m[1] = m[3]; m[3] = t;
    t = m[2]; m[2] = m[6]; m[6] = t;
    t = m[5]; m[5] = m[7]; m[7] = t;
    return this;
  }

  transposeInto(out) {
    const m = this.m, o = out.m;
    o[0] = m[0]; o[1] = m[3]; o[2] = m[6];
    o[3] = m[1]; o[4] = m[4]; o[5] = m[7];
    o[6] = m[2]; o[7] = m[5]; o[8] = m[8];
    return out;
  }

  transformVector(v, out = new Vec3()) {
    const m = this.m;
    const x = v.x, y = v.y, z = v.z;
    out.x = m[0] * x + m[1] * y + m[2] * z;
    out.y = m[3] * x + m[4] * y + m[5] * z;
    out.z = m[6] * x + m[7] * y + m[8] * z;
    return out;
  }

  /**
   * World-space inverse inertia: R * Ibody^-1 * R^T.
   * `invBodyDiag` is the diagonal of the body-frame inverse inertia tensor.
   */
  setWorldInverseInertia(rot, invBodyDiag) {
    const r = rot.m, m = this.m;
    const ix = invBodyDiag.x, iy = invBodyDiag.y, iz = invBodyDiag.z;
    // t = R * diag(I^-1)
    const t0 = r[0] * ix, t1 = r[1] * iy, t2 = r[2] * iz;
    const t3 = r[3] * ix, t4 = r[4] * iy, t5 = r[5] * iz;
    const t6 = r[6] * ix, t7 = r[7] * iy, t8 = r[8] * iz;
    // m = t * R^T
    m[0] = t0 * r[0] + t1 * r[1] + t2 * r[2];
    m[1] = t0 * r[3] + t1 * r[4] + t2 * r[5];
    m[2] = t0 * r[6] + t1 * r[7] + t2 * r[8];
    m[3] = t3 * r[0] + t4 * r[1] + t5 * r[2];
    m[4] = t3 * r[3] + t4 * r[4] + t5 * r[5];
    m[5] = t3 * r[6] + t4 * r[7] + t5 * r[8];
    m[6] = t6 * r[0] + t7 * r[1] + t8 * r[2];
    m[7] = t6 * r[3] + t7 * r[4] + t8 * r[5];
    m[8] = t6 * r[6] + t7 * r[7] + t8 * r[8];
    return this;
  }
}
