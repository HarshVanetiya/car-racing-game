/**
 * Mutable 3-component vector. Deliberately allocation-conscious: the physics
 * step runs at 240 Hz for up to 20 cars, so hot paths use the in-place `*Self`
 * style methods and a small scratch pool rather than returning new objects.
 *
 * World convention used everywhere in this project:
 *   +X = right, +Y = up, +Z = forward
 */
export class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x, y, z) {
    this.x = x; this.y = y; this.z = z;
    return this;
  }

  copy(v) {
    this.x = v.x; this.y = v.y; this.z = v.z;
    return this;
  }

  clone() {
    return new Vec3(this.x, this.y, this.z);
  }

  setZero() {
    this.x = 0; this.y = 0; this.z = 0;
    return this;
  }

  add(v) {
    this.x += v.x; this.y += v.y; this.z += v.z;
    return this;
  }

  addScaled(v, s) {
    this.x += v.x * s; this.y += v.y * s; this.z += v.z * s;
    return this;
  }

  sub(v) {
    this.x -= v.x; this.y -= v.y; this.z -= v.z;
    return this;
  }

  scale(s) {
    this.x *= s; this.y *= s; this.z *= s;
    return this;
  }

  negate() {
    this.x = -this.x; this.y = -this.y; this.z = -this.z;
    return this;
  }

  /** this = a + b */
  addVectors(a, b) {
    this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z;
    return this;
  }

  /** this = a - b */
  subVectors(a, b) {
    this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z;
    return this;
  }

  /** this = a x b */
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  cross(v) {
    return this.crossVectors(this, v);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length() {
    return Math.sqrt(this.lengthSq());
  }

  /** Horizontal (XZ) magnitude — used for ground speed. */
  lengthXZ() {
    return Math.sqrt(this.x * this.x + this.z * this.z);
  }

  distanceTo(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  distanceToSq(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  normalize() {
    const l = this.length();
    if (l > 1e-12) {
      const inv = 1 / l;
      this.x *= inv; this.y *= inv; this.z *= inv;
    }
    return this;
  }

  lerp(v, t) {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }

  /** Component-wise multiply — used for scaling by an inertia diagonal. */
  multiply(v) {
    this.x *= v.x; this.y *= v.y; this.z *= v.z;
    return this;
  }

  isFinite() {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }

  toArray(out = [], offset = 0) {
    out[offset] = this.x; out[offset + 1] = this.y; out[offset + 2] = this.z;
    return out;
  }

  fromArray(arr, offset = 0) {
    this.x = arr[offset]; this.y = arr[offset + 1]; this.z = arr[offset + 2];
    return this;
  }

  static dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }
}

/**
 * Scratch vector pool. Physics routines grab a scratch vector, use it within
 * the current call and never hold a reference across a frame boundary.
 */
const POOL_SIZE = 64;
const pool = [];
for (let i = 0; i < POOL_SIZE; i++) pool.push(new Vec3());
let poolCursor = 0;

export function tmpVec() {
  const v = pool[poolCursor];
  poolCursor = (poolCursor + 1) % POOL_SIZE;
  return v.set(0, 0, 0);
}

export const VEC3_ZERO = Object.freeze(new Vec3(0, 0, 0));
export const VEC3_UP = Object.freeze(new Vec3(0, 1, 0));
export const VEC3_FORWARD = Object.freeze(new Vec3(0, 0, 1));
export const VEC3_RIGHT = Object.freeze(new Vec3(1, 0, 0));
