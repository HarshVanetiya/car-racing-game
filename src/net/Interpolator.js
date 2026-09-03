import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { clamp, clamp01, lerp } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  REMOTE CAR INTERPOLATION
 * ============================================================================
 *
 * Snapshots arrive 20 times a second; the game draws 60+ times a second. Drawn
 * naively, remote cars would jump between the positions they were reported at.
 *
 * This renders every remote car slightly IN THE PAST — by one snapshot interval
 * plus a jitter margin — and interpolates between the two snapshots that
 * bracket that moment. Deliberately lagging the render time is what buys a
 * smooth result: there is always a snapshot on each side to interpolate
 * between, instead of having to guess forward.
 *
 * When snapshots stop arriving, it extrapolates from the last known velocity
 * for a short while — enough to ride out a dropped packet without the car
 * freezing — then eases to a halt rather than flying off across the circuit.
 */

/** How far behind real time to render remote cars, in seconds. */
const BASE_DELAY = 0.10;
/** Never extrapolate beyond this; past it, ease to a stop. */
const MAX_EXTRAPOLATION = 0.45;
/** Snapshots kept per car. */
const BUFFER_SIZE = 24;

export class RemoteCarState {
  constructor(id) {
    this.id = id;
    this.buffer = [];        // { time, p, q, v, w, extras }
    this.position = new Vec3();
    this.orientation = new Quat();
    this.velocity = new Vec3();
    this.angularVelocity = new Vec3();

    // Cosmetic state, interpolated or held.
    this.steerAngle = 0;
    this.gear = 1;
    this.rpm = 0;
    this.throttle = 0;
    this.brake = 0;
    this.drs = false;
    this.wheelSpin = [0, 0, 0, 0];
    this.wheelCompression = [0, 0, 0, 0];
    this.wheelSlip = [0, 0, 0, 0];
    this.surfaces = [0, 0, 0, 0];
    this.speed = 0;

    this.initialised = false;
    this.stale = 0;
    this._tmpQ = new Quat();
  }

  /** Push a snapshot. `time` is the server timestamp in seconds. */
  push(time, s) {
    if (!s) return;
    const entry = {
      time,
      p: [s.p[0], s.p[1], s.p[2]],
      q: [s.q[0], s.q[1], s.q[2], s.q[3]],
      v: s.v ? [s.v[0], s.v[1], s.v[2]] : [0, 0, 0],
      w: s.w ? [s.w[0], s.w[1], s.w[2]] : [0, 0, 0],
      st: s.st ?? 0,
      g: s.g ?? 1,
      r: s.r ?? 0,
      th: s.th ?? 0,
      br: s.br ?? 0,
      drs: !!s.drs,
      ws: s.ws || [0, 0, 0, 0],
      wc: s.wc || [0, 0, 0, 0],
      sl: s.sl || [0, 0, 0, 0],
      sf: s.sf || [0, 0, 0, 0]
    };

    // Out-of-order snapshots are dropped rather than reordered: by the time a
    // late one arrives its moment has already been rendered.
    const last = this.buffer[this.buffer.length - 1];
    if (last && time <= last.time) return;

    this.buffer.push(entry);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();

    if (!this.initialised) {
      this.position.set(entry.p[0], entry.p[1], entry.p[2]);
      this.orientation.set(entry.q[0], entry.q[1], entry.q[2], entry.q[3]);
      this.initialised = true;
    }
    this.stale = 0;
  }

  /**
   * Advance to `renderTime` (server clock, already offset by the estimated
   * clock delta). Returns true if a valid pose was produced.
   */
  update(renderTime, dt) {
    if (this.buffer.length === 0) return this.initialised;

    const target = renderTime - BASE_DELAY;
    const buf = this.buffer;

    // Find the pair bracketing the target time.
    let a = null, b = null;
    for (let i = buf.length - 1; i > 0; i--) {
      if (buf[i - 1].time <= target && buf[i].time >= target) {
        a = buf[i - 1]; b = buf[i];
        break;
      }
    }

    if (a && b) {
      // --- Interpolation: the normal case ---------------------------------
      const span = b.time - a.time;
      const t = span > 1e-6 ? clamp01((target - a.time) / span) : 0;
      this.position.set(
        lerp(a.p[0], b.p[0], t), lerp(a.p[1], b.p[1], t), lerp(a.p[2], b.p[2], t)
      );
      this._tmpQ.set(a.q[0], a.q[1], a.q[2], a.q[3]);
      this.orientation.copy(this._tmpQ);
      this._tmpQ.set(b.q[0], b.q[1], b.q[2], b.q[3]);
      this.orientation.slerp(this._tmpQ, t);
      this.velocity.set(
        lerp(a.v[0], b.v[0], t), lerp(a.v[1], b.v[1], t), lerp(a.v[2], b.v[2], t)
      );
      this._blendExtras(a, b, t);
      this.stale = 0;
    } else {
      const newest = buf[buf.length - 1];
      if (target < buf[0].time) {
        // Behind the buffer entirely (just joined, or a long stall): sit on
        // the oldest snapshot rather than guessing.
        this._applyExact(buf[0]);
        return true;
      }
      // --- Extrapolation: we have run past the newest snapshot -------------
      const ahead = target - newest.time;
      this.stale = ahead;
      const factor = clamp(ahead, 0, MAX_EXTRAPOLATION);
      // Damp the projection as it gets less trustworthy, so a car that has
      // stopped sending drifts to a halt instead of sailing off the circuit.
      const confidence = 1 - clamp01(ahead / MAX_EXTRAPOLATION) * 0.75;
      this.position.set(
        newest.p[0] + newest.v[0] * factor * confidence,
        newest.p[1] + newest.v[1] * factor * confidence,
        newest.p[2] + newest.v[2] * factor * confidence
      );
      this.orientation.set(newest.q[0], newest.q[1], newest.q[2], newest.q[3]);
      if (Math.abs(newest.w[1]) > 1e-4) {
        // Carry the yaw rate forward so a car mid-corner keeps turning.
        const yaw = newest.w[1] * factor * confidence;
        this._tmpQ.setFromYaw(yaw);
        this.orientation.premultiply(this._tmpQ).normalize();
      }
      this.velocity.set(
        newest.v[0] * confidence, newest.v[1] * confidence, newest.v[2] * confidence
      );
      this._applyExtras(newest);
    }

    this.speed = this.velocity.length();
    return true;
  }

  _blendExtras(a, b, t) {
    this.steerAngle = lerp(a.st, b.st, t);
    this.rpm = lerp(a.r, b.r, t);
    this.throttle = lerp(a.th, b.th, t);
    this.brake = lerp(a.br, b.br, t);
    // Discrete values take the newer snapshot's value rather than a nonsense
    // average — you cannot be in gear 4.5.
    this.gear = b.g;
    this.drs = b.drs;
    for (let i = 0; i < 4; i++) {
      this.wheelSpin[i] = lerp(a.ws[i], b.ws[i], t);
      this.wheelCompression[i] = lerp(a.wc[i], b.wc[i], t);
      this.wheelSlip[i] = lerp(a.sl[i], b.sl[i], t);
      this.surfaces[i] = b.sf[i];
    }
  }

  _applyExtras(s) {
    this.steerAngle = s.st;
    this.rpm = s.r;
    this.throttle = s.th;
    this.brake = s.br;
    this.gear = s.g;
    this.drs = s.drs;
    for (let i = 0; i < 4; i++) {
      this.wheelSpin[i] = s.ws[i];
      this.wheelCompression[i] = s.wc[i];
      this.wheelSlip[i] = s.sl[i];
      this.surfaces[i] = s.sf[i];
    }
  }

  _applyExact(s) {
    this.position.set(s.p[0], s.p[1], s.p[2]);
    this.orientation.set(s.q[0], s.q[1], s.q[2], s.q[3]);
    this.velocity.set(s.v[0], s.v[1], s.v[2]);
    this._applyExtras(s);
    this.speed = this.velocity.length();
  }

  /** True when this car's data is too old to be trusted for gameplay. */
  get isStale() {
    return this.stale > MAX_EXTRAPOLATION;
  }
}

/**
 * Estimates the offset between the local clock and the server's, so snapshot
 * timestamps can be placed on a common timeline.
 *
 * Uses the minimum observed offset rather than an average: the minimum comes
 * from the fastest round trip seen, which is the least distorted by queueing.
 */
export class ClockSync {
  constructor() {
    this.offset = 0;
    this.rtt = 0;
    this.samples = [];
    this.synced = false;
  }

  /** Called on a pong. All times in milliseconds. */
  addSample(clientSent, serverTime, clientReceived) {
    const rtt = clientReceived - clientSent;
    if (rtt < 0 || rtt > 3000) return;
    // Assume the server timestamp was taken halfway through the round trip.
    const offset = serverTime - (clientSent + rtt / 2);
    this.samples.push({ offset, rtt });
    if (this.samples.length > 20) this.samples.shift();

    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.rtt = best.rtt;
    this.synced = true;
  }

  /** Local time expressed on the server's clock, in seconds. */
  now() {
    return (Date.now() + this.offset) / 1000;
  }
}
