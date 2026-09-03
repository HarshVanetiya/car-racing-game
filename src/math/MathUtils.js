/**
 * Small numeric helpers shared by the physics core, the race director and the
 * renderer. Everything here is dependency free so the Node server can import
 * the exact same code the browser runs (requirement: identical physics for
 * player, AI and remote cars).
 */

export const EPSILON = 1e-9;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function invLerp(a, b, v) {
  if (Math.abs(b - a) < EPSILON) return 0;
  return (v - a) / (b - a);
}

export function remap(v, inMin, inMax, outMin, outMax) {
  return lerp(outMin, outMax, clamp01(invLerp(inMin, inMax, v)));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

export function sign(v) {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/** Frame-rate independent exponential smoothing. `rate` is 1/seconds. */
export function damp(current, target, rate, dt) {
  return lerp(target, current, Math.exp(-rate * dt));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap an angle into [-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** Shortest signed difference between two angles. */
export function angleDelta(from, to) {
  return wrapAngle(to - from);
}

/** Wrap a value into [0, range). Used for lap-distance arithmetic. */
export function wrapRange(v, range) {
  let r = v % range;
  if (r < 0) r += range;
  return r;
}

/** Signed shortest difference on a circular track of length `range`. */
export function circularDelta(from, to, range) {
  let d = (to - from) % range;
  if (d > range * 0.5) d -= range;
  if (d < -range * 0.5) d += range;
  return d;
}

/**
 * Deterministic 32-bit PRNG (mulberry32). Used for AI mistake rolls, weather
 * evolution and grid jitter so that a seeded race can be reproduced on both
 * the server and any connected client.
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randRange(rng, lo, hi) {
  return lo + (hi - lo) * rng();
}

/** Gaussian sample via Box-Muller, clamped to +/-3 sigma. */
export function randGaussian(rng, mean = 0, sigma = 1) {
  const u = Math.max(rng(), 1e-7);
  const v = rng();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + sigma * clamp(n, -3, 3);
}

/** Format seconds as m:ss.mmm — the canonical lap-time presentation. */
export function formatLapTime(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}

/** Format a gap as +s.mmm, or +N L for lapped cars. */
export function formatGap(seconds, laps = 0) {
  if (laps > 0) return `+${laps}L`;
  if (seconds == null || !isFinite(seconds)) return '--.---';
  if (seconds <= 0) return '--.---';
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `+${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
  }
  return `+${seconds.toFixed(3)}`;
}

export function formatSector(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return '--.---';
  return seconds.toFixed(3);
}
