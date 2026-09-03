import { clamp, clamp01, lerp } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  EVENT AUDIO
 * ============================================================================
 *
 * Collisions, UI cues and race-control announcements, all synthesised.
 *
 * Collision sounds are built from the impact energy and what was hit, so a
 * light rub sounds like a rub and a barrier shunt sounds like a shunt — the
 * player can tell how bad it was without looking at the damage readout.
 */
export class GameSounds {
  constructor(audioEngine) {
    this.audio = audioEngine;
  }

  get ctx() { return this.audio.ctx; }
  get ready() { return this.audio.started && this.audio.enabled; }

  _bus(name = 'effects') {
    return this.audio.buses[name];
  }

  // -------------------------------------------------------------------------
  //  Collisions
  // -------------------------------------------------------------------------

  /**
   * @param {number} energy joules absorbed
   * @param {string} kind 'car' | 'barrier' | 'wheel' | 'kerb'
   * @param {number} pan -1..1
   */
  impact(energy, kind = 'car', pan = 0) {
    if (!this.ready || energy < 300) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const severity = clamp01(energy / 90000);

    const out = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    out.connect(panner).connect(this._bus('effects'));

    // --- The hit itself: a filtered noise burst ----------------------------
    const noise = this.audio._noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // Carbon fibre cracks high; a tyre wall thuds low.
    const centre = kind === 'barrier' ? lerp(180, 90, severity)
                 : kind === 'wheel' ? lerp(320, 160, severity)
                 : lerp(700, 240, severity);
    bp.frequency.setValueAtTime(centre * 2.2, now);
    bp.frequency.exponentialRampToValueAtTime(centre, now + 0.08);
    bp.Q.value = 1.4;

    const g = ctx.createGain();
    const peak = lerp(0.06, 0.55, severity);
    g.gain.setValueAtTime(peak, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + lerp(0.09, 0.45, severity));

    noise.connect(bp).connect(g).connect(out);
    noise.start(now);
    noise.stop(now + 0.6);

    // --- Structural thud ----------------------------------------------------
    if (severity > 0.12) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(lerp(150, 62, severity), now);
      osc.frequency.exponentialRampToValueAtTime(lerp(70, 34, severity), now + 0.16);
      const og = ctx.createGain();
      og.gain.setValueAtTime(severity * 0.42, now);
      og.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.connect(og).connect(out);
      osc.start(now);
      osc.stop(now + 0.3);
    }

    // --- Debris scatter for a big one --------------------------------------
    if (severity > 0.45) {
      for (let i = 0; i < 5; i++) {
        const t = now + 0.05 + Math.random() * 0.28;
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = 900 + Math.random() * 2600;
        const og = ctx.createGain();
        og.gain.setValueAtTime(0.05 * severity, t);
        og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        o.connect(og).connect(out);
        o.start(t);
        o.stop(t + 0.11);
      }
    }
  }

  /** A tire scraping along a barrier. */
  scrape(intensity, pan = 0) {
    if (!this.ready || intensity < 0.05) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const noise = this.audio._noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.10 * intensity, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    noise.connect(f).connect(g).connect(p).connect(this._bus('effects'));
    noise.start(now);
    noise.stop(now + 0.25);
  }

  // -------------------------------------------------------------------------
  //  UI and race control
  // -------------------------------------------------------------------------

  /** A pure tone. The building block for every UI cue. */
  tone(freq, duration, opts = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + (opts.delay || 0);
    const osc = ctx.createOscillator();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, now);
    if (opts.sweepTo) {
      osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, now + duration);
    }
    const g = ctx.createGain();
    const vol = opts.volume ?? 0.14;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(g).connect(this._bus(opts.bus || 'ui'));
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  uiClick() { this.tone(880, 0.05, { type: 'square', volume: 0.07 }); }
  uiSelect() { this.tone(1180, 0.07, { type: 'square', volume: 0.09 }); }
  uiBack() { this.tone(520, 0.08, { type: 'square', volume: 0.07 }); }
  uiError() {
    this.tone(220, 0.12, { type: 'sawtooth', volume: 0.10 });
    this.tone(180, 0.16, { type: 'sawtooth', volume: 0.08, delay: 0.06 });
  }

  /** One of the five starting lights coming on. */
  startLight(index) {
    this.tone(440 + index * 55, 0.16, { type: 'sine', volume: 0.16, bus: 'ui' });
  }

  /** Lights out: the moment the race begins. */
  lightsOut() {
    this.tone(880, 0.35, { type: 'sine', volume: 0.20, sweepTo: 1760, bus: 'ui' });
    this.tone(587, 0.4, { type: 'triangle', volume: 0.14, delay: 0.02, bus: 'ui' });
  }

  lapComplete(personalBest = false) {
    if (personalBest) {
      this.tone(784, 0.10, { volume: 0.13 });
      this.tone(988, 0.10, { volume: 0.13, delay: 0.09 });
      this.tone(1319, 0.20, { volume: 0.15, delay: 0.18 });
    } else {
      this.tone(660, 0.09, { volume: 0.10 });
    }
  }

  fastestLap() {
    this.tone(880, 0.09, { volume: 0.14 });
    this.tone(1109, 0.09, { volume: 0.14, delay: 0.08 });
    this.tone(1319, 0.09, { volume: 0.14, delay: 0.16 });
    this.tone(1760, 0.28, { volume: 0.16, delay: 0.24 });
  }

  finalLap() {
    this.tone(1046, 0.14, { volume: 0.16 });
    this.tone(1046, 0.14, { volume: 0.16, delay: 0.20 });
    this.tone(1318, 0.30, { volume: 0.18, delay: 0.40 });
  }

  positionGained() { this.tone(700, 0.07, { volume: 0.11 }); this.tone(1050, 0.12, { volume: 0.11, delay: 0.06 }); }
  positionLost() { this.tone(600, 0.07, { volume: 0.10 }); this.tone(400, 0.14, { volume: 0.10, delay: 0.06 }); }

  penalty() {
    this.tone(300, 0.22, { type: 'sawtooth', volume: 0.14 });
    this.tone(240, 0.30, { type: 'sawtooth', volume: 0.12, delay: 0.18 });
  }

  warning() { this.tone(520, 0.12, { type: 'triangle', volume: 0.12 }); }

  drsAvailable() { this.tone(1400, 0.06, { volume: 0.10 }); this.tone(1800, 0.09, { volume: 0.10, delay: 0.05 }); }

  pitEntry() { this.tone(520, 0.10, { volume: 0.11 }); this.tone(392, 0.16, { volume: 0.11, delay: 0.08 }); }
  pitExit() { this.tone(392, 0.10, { volume: 0.11 }); this.tone(587, 0.16, { volume: 0.12, delay: 0.08 }); }

  /** The pit crew's air gun during a stop. */
  wheelGun(duration = 0.6) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const start = ctx.currentTime;
    const bursts = Math.floor(duration / 0.055);
    for (let i = 0; i < bursts; i++) {
      const t = start + i * 0.055;
      const noise = this.audio._noiseSource();
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 2400 + Math.random() * 900;
      f.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.09, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
      noise.connect(f).connect(g).connect(this._bus('effects'));
      noise.start(t);
      noise.stop(t + 0.05);
    }
  }

  chequeredFlag() {
    const notes = [523, 659, 784, 1046];
    notes.forEach((n, i) => this.tone(n, 0.18, { volume: 0.15, delay: i * 0.10 }));
  }

  raceFinished(position) {
    if (position === 1) {
      const fanfare = [523, 659, 784, 1046, 1318];
      fanfare.forEach((n, i) => this.tone(n, 0.3, { volume: 0.17, delay: i * 0.13 }));
    } else if (position <= 3) {
      [523, 784, 1046].forEach((n, i) => this.tone(n, 0.26, { volume: 0.15, delay: i * 0.14 }));
    } else {
      [523, 659].forEach((n, i) => this.tone(n, 0.24, { volume: 0.12, delay: i * 0.15 }));
    }
  }

  countdownBeep(final = false) {
    this.tone(final ? 1200 : 800, final ? 0.3 : 0.12, { volume: 0.16 });
  }

  /** Crowd swell — used at the start and on the podium. */
  crowdCheer(intensity = 1, duration = 3) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const noise = this.audio._noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 700;
    f.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.10 * intensity, now + 0.5);
    g.gain.setValueAtTime(0.10 * intensity, now + duration * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    noise.connect(f).connect(g).connect(this._bus('effects'));
    noise.start(now);
    noise.stop(now + duration + 0.1);
  }
}
