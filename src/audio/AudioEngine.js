import { clamp, clamp01, lerp } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  AUDIO ENGINE
 * ============================================================================
 *
 * Every sound in the game is synthesised at runtime with the Web Audio API.
 * There are no audio files: the engine note is built from a harmonic stack
 * whose fundamental follows crank speed, tire noise is filtered noise whose
 * band and gain follow actual slip, and wind is noise shaped by airspeed.
 *
 * That choice is not just about download size. Because the sound is generated
 * from the same numbers the physics produces, it tracks them exactly — the
 * engine note rises continuously with rpm instead of crossfading between
 * samples, and a tire that is 5% past its limit sounds different from one that
 * is 50% past it.
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
    this.started = false;

    this.volumes = {
      master: 0.75,
      engine: 0.85,
      tires: 0.9,
      wind: 0.6,
      effects: 0.9,
      ui: 0.8
    };

    this.sources = new Map();   // carId -> CarSound
    this._listener = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 } };
  }

  /**
   * Must be called from a user gesture — browsers will not start an
   * AudioContext otherwise.
   */
  async start() {
    if (this.started) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return true;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      await this.ctx.resume();

      this.master = this.ctx.createGain();
      this.master.gain.value = this.volumes.master;

      // A gentle limiter so a big pile-up cannot clip the output.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 8;
      this.limiter.attack.value = 0.004;
      this.limiter.release.value = 0.18;

      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);

      // Buses, so the player can mix the game.
      this.buses = {};
      for (const name of ['engine', 'tires', 'wind', 'effects', 'ui']) {
        const g = this.ctx.createGain();
        g.gain.value = this.volumes[name];
        g.connect(this.master);
        this.buses[name] = g;
      }

      this._noiseBuffer = this._makeNoiseBuffer(2.0);
      this._startAmbience();

      this.started = true;
      this.enabled = true;
      return true;
    } catch (err) {
      console.warn('[audio] unavailable:', err.message);
      return false;
    }
  }

  /** White noise, reused by every noise-based voice. */
  _makeNoiseBuffer(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Slightly pink: less harsh than pure white, closer to real surface noise.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
    return buf;
  }

  _noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.loop = true;
    return src;
  }

  /** Trackside ambience: a low bed of crowd and air, always present. */
  _startAmbience() {
    const noise = this._noiseSource();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.6;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.035;
    noise.connect(filter).connect(gain).connect(this.buses.effects);
    noise.start();
    this._ambience = { noise, filter, gain };
  }

  setVolume(name, value) {
    this.volumes[name] = clamp01(value);
    if (!this.started) return;
    if (name === 'master') this.master.gain.value = this.volumes.master;
    else if (this.buses[name]) this.buses[name].gain.value = this.volumes[name];
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.started) this.master.gain.value = on ? this.volumes.master : 0;
  }

  /** Register a car so it gets an engine and tire voice. */
  addCar(id, opts = {}) {
    if (!this.started || this.sources.has(id)) return this.sources.get(id);
    const sound = new CarSound(this, id, opts);
    this.sources.set(id, sound);
    return sound;
  }

  removeCar(id) {
    const s = this.sources.get(id);
    if (s) { s.dispose(); this.sources.delete(id); }
  }

  clearCars() {
    for (const id of [...this.sources.keys()]) this.removeCar(id);
  }

  /** Where the camera is, for distance attenuation and panning. */
  setListener(position, forward) {
    this._listener.position = position;
    this._listener.forward = forward;
  }

  update(dt) {
    if (!this.started || !this.enabled) return;
    for (const s of this.sources.values()) s.update(dt, this._listener);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
}

/**
 * ----------------------------------------------------------------------------
 *  One car's voice
 * ----------------------------------------------------------------------------
 *
 * Engine: an additive stack of sawtooth oscillators at multiples of the firing
 * frequency, plus filtered noise for induction and exhaust. Load opens a
 * low-pass filter and brings in the harsher upper harmonics, so the same rpm
 * sounds different on and off the throttle — which is exactly how a real engine
 * behaves and what makes engine braking audible.
 */
class CarSound {
  constructor(engineRef, id, opts) {
    this.audio = engineRef;
    this.ctx = engineRef.ctx;
    this.id = id;
    this.isPlayer = !!opts.isPlayer;

    const ctx = this.ctx;

    // --- Output chain: panner + distance gain ------------------------------
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.out.connect(this.panner);

    // --- Engine ------------------------------------------------------------
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    // Load-dependent tone shaping.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 1400;
    this.engineFilter.Q.value = 0.9;

    // A little waveshaping gives the note the hard edge a race engine has.
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeDriveCurve(0.42);
    this.shaper.oversample = '2x';

    this.oscillators = [];
    // Harmonics of the firing frequency. The 0.5 entry is the half-order
    // component a V6 produces, and it is a large part of the character.
    const harmonics = [
      { mult: 0.5, gain: 0.30, type: 'sine' },
      { mult: 1.0, gain: 1.00, type: 'sawtooth' },
      { mult: 1.5, gain: 0.34, type: 'sine' },
      { mult: 2.0, gain: 0.52, type: 'sawtooth' },
      { mult: 3.0, gain: 0.30, type: 'square' },
      { mult: 4.0, gain: 0.18, type: 'sawtooth' },
      { mult: 6.0, gain: 0.10, type: 'sine' }
    ];
    for (const h of harmonics) {
      const osc = ctx.createOscillator();
      osc.type = h.type;
      osc.frequency.value = 100 * h.mult;
      const g = ctx.createGain();
      g.gain.value = h.gain;
      osc.connect(g).connect(this.shaper);
      osc.start();
      this.oscillators.push({ osc, gain: g, mult: h.mult, base: h.gain });
    }
    this.shaper.connect(this.engineFilter).connect(this.engineGain);
    this.engineGain.connect(this.out);

    // Induction / exhaust roar: noise that rises with rpm and throttle.
    this.inductionSrc = engineRef._noiseSource();
    this.inductionFilter = ctx.createBiquadFilter();
    this.inductionFilter.type = 'bandpass';
    this.inductionFilter.frequency.value = 900;
    this.inductionFilter.Q.value = 1.1;
    this.inductionGain = ctx.createGain();
    this.inductionGain.gain.value = 0;
    this.inductionSrc.connect(this.inductionFilter).connect(this.inductionGain);
    this.inductionGain.connect(this.out);
    this.inductionSrc.start();

    // --- Tires --------------------------------------------------------------
    // Squeal: a resonant band whose centre frequency rises with slip.
    this.squealSrc = engineRef._noiseSource();
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1300;
    this.squealFilter.Q.value = 9;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealSrc.connect(this.squealFilter).connect(this.squealGain);
    this.squealGain.connect(this.out);
    this.squealSrc.start();

    // Surface roll noise: broadband, shaped by the surface under the car.
    this.rollSrc = engineRef._noiseSource();
    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'lowpass';
    this.rollFilter.frequency.value = 800;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    this.rollSrc.connect(this.rollFilter).connect(this.rollGain);
    this.rollGain.connect(this.out);
    this.rollSrc.start();

    // --- Wind ---------------------------------------------------------------
    this.windSrc = engineRef._noiseSource();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 600;
    this.windFilter.Q.value = 0.5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter).connect(this.windGain);
    this.windSrc.start();

    // Route to the right buses.
    this.panner.connect(engineRef.buses.engine);
    this.windGain.connect(engineRef.buses.wind);

    this._lastGear = 1;
    this._kerbCooldown = 0;
  }

  /**
   * @param {object} state {
   *   rpm, maxRpm, throttle, brake, gear, load, speed, position,
   *   tireSlip: [4], lockup, wheelspin, surfaceType, wetness, kerbLoad,
   *   airborne, distanceToListener
   * }
   */
  setState(state) {
    this.state = state;
  }

  update(dt, listener) {
    const s = this.state;
    if (!s) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const smooth = 0.045;   // parameter ramp, keeps everything click-free

    // --- Spatialisation -----------------------------------------------------
    const dx = s.position.x - listener.position.x;
    const dy = (s.position.y || 0) - (listener.position.y || 0);
    const dz = s.position.z - listener.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Inverse-square-ish falloff with a floor, so distant cars stay audible
    // enough to race against but never dominate.
    const near = this.isPlayer ? 1.0 : clamp01(28 / Math.max(6, dist));
    const distanceGain = this.isPlayer ? 1.0 : near * near;

    // Pan by which side of the listener the car is on.
    if (!this.isPlayer && dist > 0.5) {
      const fx = listener.forward.x, fz = listener.forward.z;
      // Right vector = up x forward.
      const rx = fz, rz = -fx;
      const pan = clamp((dx * rx + dz * rz) / Math.max(8, dist), -1, 1);
      this.panner.pan.setTargetAtTime(pan, now, 0.08);
    } else {
      this.panner.pan.setTargetAtTime(0, now, 0.08);
    }

    this.out.gain.setTargetAtTime(distanceGain, now, 0.06);

    // --- Engine -------------------------------------------------------------
    // Firing frequency: a V6 at N rpm fires 3 times per revolution.
    const rpm = clamp(s.rpm || 0, 500, 20000);
    const f0 = (rpm / 60) * 3;

    // Doppler: a real cue for whether a car is coming or going, and cheap.
    let doppler = 1;
    if (!this.isPlayer && dist > 1) {
      const vr = ((s.velocity?.x || 0) * dx + (s.velocity?.z || 0) * dz) / dist;
      doppler = clamp(343 / (343 + vr), 0.82, 1.22);
    }

    for (const h of this.oscillators) {
      h.osc.frequency.setTargetAtTime(
        clamp(f0 * h.mult * doppler, 20, 18000), now, smooth
      );
    }

    const throttle = clamp01(s.throttle || 0);
    const load = clamp01(s.load ?? throttle);
    const revFrac = clamp01((rpm - 4000) / 11000);

    // On the throttle the note is bright and harsh; off it, it softens and the
    // upper harmonics fall away. This is what makes engine braking audible.
    this.engineFilter.frequency.setTargetAtTime(
      lerp(700, 5200, load * 0.75 + revFrac * 0.35), now, smooth
    );
    for (const h of this.oscillators) {
      const emphasis = h.mult >= 3 ? lerp(0.25, 1.0, load) : 1.0;
      h.gain.gain.setTargetAtTime(h.base * emphasis, now, smooth);
    }

    // Overall engine level: mostly rpm, lifted by throttle.
    const engineLevel = (0.10 + revFrac * 0.55) * (0.45 + load * 0.55);
    this.engineGain.gain.setTargetAtTime(
      s.ignitionCut ? engineLevel * 0.25 : engineLevel, now, 0.03
    );

    // Induction roar
    this.inductionFilter.frequency.setTargetAtTime(
      clamp(600 + revFrac * 2600, 200, 8000), now, smooth
    );
    this.inductionGain.gain.setTargetAtTime(
      (0.05 + revFrac * 0.22) * (0.3 + throttle * 0.7), now, smooth
    );

    // --- Gear shift ---------------------------------------------------------
    if (s.gear !== this._lastGear) {
      const up = s.gear > this._lastGear;
      this._lastGear = s.gear;
      this._shiftBlip(up, revFrac);
    }

    // --- Tires --------------------------------------------------------------
    // Squeal follows the tire's own combined slip, so it only sounds when the
    // tire is genuinely past its limit — not merely because the car is turning.
    const slip = s.maxSlip || 0;
    const slipOver = clamp01((slip - 0.95) / 1.6);
    const speedGate = clamp01((s.speed - 4) / 14);
    const wetDamp = 1 - clamp01(s.wetness || 0) * 0.55;

    // The pitch of a squealing tire rises as it is worked harder.
    this.squealFilter.frequency.setTargetAtTime(
      lerp(760, 2100, slipOver) * lerp(0.85, 1.15, clamp01(s.speed / 80)), now, 0.05
    );
    this.squealFilter.Q.setTargetAtTime(lerp(11, 5, slipOver), now, 0.08);
    this.squealGain.gain.setTargetAtTime(
      slipOver * slipOver * 0.30 * speedGate * wetDamp * (this.isPlayer ? 1 : 0.8),
      now, 0.05
    );

    // Roll and surface noise.
    const surfaceRough = s.surfaceRoughness ?? 0;
    this.rollFilter.frequency.setTargetAtTime(
      lerp(320, 1500, clamp01(s.speed / 80)) * lerp(1, 2.2, surfaceRough), now, smooth
    );
    const wetHiss = clamp01(s.wetness || 0) * clamp01(s.speed / 50) * 0.10;
    this.rollGain.gain.setTargetAtTime(
      (0.03 + clamp01(s.speed / 90) * 0.10) * (1 + surfaceRough * 2.2) + wetHiss,
      now, smooth
    );

    // --- Wind ---------------------------------------------------------------
    // Only the driver hears wind; it is the airflow over their own helmet.
    if (this.isPlayer) {
      const spd = clamp01(s.speed / 95);
      this.windFilter.frequency.setTargetAtTime(lerp(320, 1500, spd), now, smooth);
      this.windGain.gain.setTargetAtTime(spd * spd * 0.30, now, smooth);
    }

    // --- Kerbs --------------------------------------------------------------
    this._kerbCooldown -= dt;
    if ((s.kerbLoad || 0) > 0.25 && this._kerbCooldown <= 0) {
      this._kerbCooldown = 0.055;
      this._kerbHit(clamp01(s.kerbLoad));
    }
  }

  /** A short percussive blip on a gear change. */
  _shiftBlip(up, revFrac) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(up ? 1500 : 950, now);
    osc.frequency.exponentialRampToValueAtTime(up ? 520 : 1500, now + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.10 * (0.5 + revFrac), now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc.connect(g).connect(this.out);
    osc.start(now);
    osc.stop(now + 0.09);
  }

  /** A rib of kerb passing under a wheel. */
  _kerbHit(intensity) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = this.audio._noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 120 + Math.random() * 90;
    f.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16 * intensity, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    src.connect(f).connect(g).connect(this.out);
    src.start(now);
    src.stop(now + 0.12);
  }

  dispose() {
    try {
      for (const h of this.oscillators) h.osc.stop();
      this.inductionSrc.stop();
      this.squealSrc.stop();
      this.rollSrc.stop();
      this.windSrc.stop();
    } catch { /* already stopped */ }
    this.out.disconnect();
    this.panner.disconnect();
    this.windGain.disconnect();
  }
}

/** Soft-clip curve giving the engine note its hard edge. */
function makeDriveCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount * 60;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}
