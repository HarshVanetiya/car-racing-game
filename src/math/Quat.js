import { Vec3 } from './Vec3.js';

/**
 * Unit quaternion (x, y, z, w) used for chassis orientation. Kept separate from
 * three.js so the headless server integrates the very same rotation maths.
 */
export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x; this.y = y; this.z = z; this.w = w;
  }

  set(x, y, z, w) {
    this.x = x; this.y = y; this.z = z; this.w = w;
    return this;
  }

  copy(q) {
    this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w;
    return this;
  }

  clone() {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  identity() {
    return this.set(0, 0, 0, 1);
  }

  setFromAxisAngle(axis, angle) {
    const half = angle * 0.5;
    const s = Math.sin(half);
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(half);
    return this;
  }

  /** Yaw about +Y — the common case for placing cars on a grid. */
  setFromYaw(yaw) {
    const half = yaw * 0.5;
    this.x = 0; this.y = Math.sin(half); this.z = 0; this.w = Math.cos(half);
    return this;
  }

  /** Intrinsic yaw (Y) then pitch (X) then roll (Z). */
  setFromEuler(pitch, yaw, roll) {
    const cy = Math.cos(yaw * 0.5), sy = Math.sin(yaw * 0.5);
    const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
    const cr = Math.cos(roll * 0.5), sr = Math.sin(roll * 0.5);
    this.w = cy * cp * cr + sy * sp * sr;
    this.x = cy * sp * cr + sy * cp * sr;
    this.y = sy * cp * cr - cy * sp * sr;
    this.z = cy * cp * sr - sy * sp * cr;
    return this.normalize();
  }

  /** this = a * b (apply b first, then a). */
  multiplyQuaternions(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w;
    const bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  multiply(q) {
    return this.multiplyQuaternions(this, q);
  }

  premultiply(q) {
    return this.multiplyQuaternions(q, this);
  }

  conjugate() {
    this.x = -this.x; this.y = -this.y; this.z = -this.z;
    return this;
  }

  normalize() {
    let l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    if (l < 1e-12) return this.identity();
    l = 1 / l;
    this.x *= l; this.y *= l; this.z *= l; this.w *= l;
    return this;
  }

  /**
   * Integrate by an angular velocity for dt seconds:
   *   q' = normalize(q + 0.5 * omega_quat * q * dt)
   */
  integrate(omega, dt) {
    const qx = this.x, qy = this.y, qz = this.z, qw = this.w;
    const hx = omega.x * dt * 0.5;
    const hy = omega.y * dt * 0.5;
    const hz = omega.z * dt * 0.5;
    this.x += hx * qw + hy * qz - hz * qy;
    this.y += hy * qw + hz * qx - hx * qz;
    this.z += hz * qw + hx * qy - hy * qx;
    this.w += -(hx * qx + hy * qy + hz * qz);
    return this.normalize();
  }

  /** Rotate `v` by this quaternion, writing into `out`. */
  rotateVector(v, out = new Vec3()) {
    const { x, y, z, w } = this;
    const vx = v.x, vy = v.y, vz = v.z;
    // t = 2 * (q_vec x v)
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    out.x = vx + w * tx + (y * tz - z * ty);
    out.y = vy + w * ty + (z * tx - x * tz);
    out.z = vz + w * tz + (x * ty - y * tx);
    return out;
  }

  /** Rotate `v` by the inverse of this quaternion (world -> local). */
  rotateVectorInverse(v, out = new Vec3()) {
    const x = -this.x, y = -this.y, z = -this.z, w = this.w;
    const vx = v.x, vy = v.y, vz = v.z;
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    out.x = vx + w * tx + (y * tz - z * ty);
    out.y = vy + w * ty + (z * tx - x * tz);
    out.z = vz + w * tz + (x * ty - y * tx);
    return out;
  }

  /** Heading around +Y extracted from the local forward axis. */
  getYaw() {
    const { x, y, z, w } = this;
    // forward = q * (0,0,1)
    const fx = 2 * (x * z + w * y);
    const fz = 1 - 2 * (x * x + y * y);
    return Math.atan2(fx, fz);
  }

  getPitch() {
    const { x, y, z, w } = this;
    const fy = 2 * (y * z - w * x);
    return Math.asin(Math.max(-1, Math.min(1, -fy)));
  }

  getRoll() {
    const { x, y, z, w } = this;
    // local right axis
    const rx = 1 - 2 * (y * y + z * z);
    const ry = 2 * (x * y + w * z);
    return Math.atan2(ry, Math.sqrt(Math.max(1e-12, rx * rx)));
  }

  slerp(q, t) {
    let cos = this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
    let qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    if (cos < 0) { cos = -cos; qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
    if (cos > 0.9995) {
      this.x += (qx - this.x) * t;
      this.y += (qy - this.y) * t;
      this.z += (qz - this.z) * t;
      this.w += (qw - this.w) * t;
      return this.normalize();
    }
    const theta = Math.acos(cos);
    const sinTheta = Math.sin(theta);
    const a = Math.sin((1 - t) * theta) / sinTheta;
    const b = Math.sin(t * theta) / sinTheta;
    this.x = this.x * a + qx * b;
    this.y = this.y * a + qy * b;
    this.z = this.z * a + qz * b;
    this.w = this.w * a + qw * b;
    return this.normalize();
  }

  /** Build an orientation from a forward direction and an up reference. */
  setFromForwardUp(forward, up) {
    const f = new Vec3().copy(forward).normalize();
    const r = new Vec3().crossVectors(up, f);
    if (r.lengthSq() < 1e-10) r.set(1, 0, 0);
    r.normalize();
    const u = new Vec3().crossVectors(f, r).normalize();
    // Column-major basis -> quaternion
    const m00 = r.x, m01 = u.x, m02 = f.x;
    const m10 = r.y, m11 = u.y, m12 = f.y;
    const m20 = r.z, m21 = u.z, m22 = f.z;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s;
      this.x = (m21 - m12) * s;
      this.y = (m02 - m20) * s;
      this.z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
      this.w = (m21 - m12) / s;
      this.x = 0.25 * s;
      this.y = (m01 + m10) / s;
      this.z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
      this.w = (m02 - m20) / s;
      this.x = (m01 + m10) / s;
      this.y = 0.25 * s;
      this.z = (m12 + m21) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
      this.w = (m10 - m01) / s;
      this.x = (m02 + m20) / s;
      this.y = (m12 + m21) / s;
      this.z = 0.25 * s;
    }
    return this.normalize();
  }

  toArray(out = [], offset = 0) {
    out[offset] = this.x; out[offset + 1] = this.y;
    out[offset + 2] = this.z; out[offset + 3] = this.w;
    return out;
  }

  fromArray(arr, offset = 0) {
    this.x = arr[offset]; this.y = arr[offset + 1];
    this.z = arr[offset + 2]; this.w = arr[offset + 3];
    return this;
  }
}
