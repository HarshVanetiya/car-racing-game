import { clamp, clamp01, lerp, smoothstep, makeRng, randRange } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  WEATHER AND TRACK CONDITIONS
 * ============================================================================
 *
 * Rain is not a global grip multiplier. It is water on a surface, and it
 * reaches the tires through several separate routes:
 *
 *   - `wetness`      how damp the surface is; interacts with tread pattern, so
 *                    a slick and a full wet respond to it completely differently
 *   - `waterDepth`   standing water; causes aquaplaning above a critical speed
 *                    that depends on the tire's ability to clear it
 *   - cooling        rain pulls heat out of tires and brakes, so a slick that
 *                    was in its window falls out of it and gets worse still
 *   - rubber         rain washes away the rubbered-in racing line, so the dry
 *                    line loses the grip advantage it had built up
 *   - visibility     spray from the car ahead
 *
 * The track also evolves in the dry: the racing line rubbers in over a session
 * and gains grip, while everything off it stays green.
 */

export const WeatherState = {
  DRY: 'dry',
  LIGHT_RAIN: 'lightRain',
  HEAVY_RAIN: 'heavyRain'
};

export const WEATHER_PRESETS = {
  [WeatherState.DRY]: {
    key: WeatherState.DRY,
    name: 'Dry',
    icon: '☀',
    targetWetness: 0,
    rainRate: 0,
    cloudCover: 0.15,
    ambientTemp: 26,
    trackTemp: 38,
    visibility: 1.0
  },
  [WeatherState.LIGHT_RAIN]: {
    key: WeatherState.LIGHT_RAIN,
    name: 'Light Rain',
    icon: '🌦',
    targetWetness: 0.48,
    rainRate: 0.9,
    cloudCover: 0.75,
    ambientTemp: 19,
    trackTemp: 22,
    visibility: 0.72
  },
  [WeatherState.HEAVY_RAIN]: {
    key: WeatherState.HEAVY_RAIN,
    name: 'Heavy Rain',
    icon: '🌧',
    targetWetness: 0.95,
    rainRate: 2.6,
    cloudCover: 0.95,
    ambientTemp: 16,
    trackTemp: 17,
    visibility: 0.38
  }
};

export class Weather {
  /**
   * @param {TrackModel} track
   * @param {object} opts
   * @param {string} opts.initial            starting weather state
   * @param {boolean} opts.dynamic           allow the weather to change
   * @param {number} opts.changeChance       probability per minute of a change
   * @param {number} opts.seed
   */
  constructor(track, opts = {}) {
    this.track = track;
    this.rng = makeRng(opts.seed ?? 90210);
    this.dynamic = opts.dynamic ?? false;
    this.changeChancePerMinute = opts.changeChance ?? 0.22;

    this.state = opts.initial || WeatherState.DRY;
    const preset = WEATHER_PRESETS[this.state];

    // Global (whole-circuit) conditions. Per-sample values live on the track.
    this.wetness = preset.targetWetness;
    this.targetWetness = preset.targetWetness;
    this.rainRate = preset.rainRate;
    this.cloudCover = preset.cloudCover;
    this.ambientTemp = preset.ambientTemp;
    this.trackTemp = preset.trackTemp;
    this.visibility = preset.visibility;
    this.airDensity = 1.225;

    // Wind: affects apparent airspeed and therefore aero, and drives the
    // wind noise in the audio mix.
    this.windDirection = randRange(this.rng, 0, Math.PI * 2);
    this.windSpeed = randRange(this.rng, 0.5, 4.5);
    this.wind = { x: 0, y: 0, z: 0 };
    this._updateWindVector();

    this._changeTimer = 0;
    this._transition = null;
    this.events = [];

    // Seed the per-sample state on the track.
    this._initialiseTrack();
  }

  _initialiseTrack() {
    const t = this.track;
    for (let i = 0; i < t.sampleCount; i++) {
      t.wetness[i] = this.wetness;
      t.waterDepth[i] = this.wetness > 0.6 ? (this.wetness - 0.6) * 0.012 : 0;
      // A session starts with a partly rubbered line; a wet start washes it off.
      t.rubber[i] = this.wetness > 0.3 ? 0.06 : 0.18;
      t.lineDry[i] = 0;
    }
  }

  _updateWindVector() {
    this.wind.x = Math.sin(this.windDirection) * this.windSpeed;
    this.wind.y = 0;
    this.wind.z = Math.cos(this.windDirection) * this.windSpeed;
  }

  /** Force a weather change, with a transition rather than a jump. */
  setState(key, transitionSeconds = 45) {
    const preset = WEATHER_PRESETS[key];
    if (!preset) return;
    this.state = key;
    this._transition = {
      from: {
        wetness: this.targetWetness,
        rainRate: this.rainRate,
        cloudCover: this.cloudCover,
        ambient: this.ambientTemp,
        trackT: this.trackTemp,
        visibility: this.visibility
      },
      to: {
        wetness: preset.targetWetness,
        rainRate: preset.rainRate,
        cloudCover: preset.cloudCover,
        ambient: preset.ambientTemp,
        trackT: preset.trackTemp,
        visibility: preset.visibility
      },
      elapsed: 0,
      duration: Math.max(1, transitionSeconds)
    };
    this.events.push({ type: 'weatherChange', state: key, name: preset.name });
  }

  /**
   * @param {number} dt seconds
   * @param {Array} cars positions used for track evolution
   */
  update(dt, cars = []) {
    this.events.length = 0;

    // --- Weather transitions ------------------------------------------------
    if (this._transition) {
      const tr = this._transition;
      tr.elapsed += dt;
      const u = smoothstep(0, 1, clamp01(tr.elapsed / tr.duration));
      this.targetWetness = lerp(tr.from.wetness, tr.to.wetness, u);
      this.rainRate = lerp(tr.from.rainRate, tr.to.rainRate, u);
      this.cloudCover = lerp(tr.from.cloudCover, tr.to.cloudCover, u);
      this.ambientTemp = lerp(tr.from.ambient, tr.to.ambient, u);
      this.trackTemp = lerp(tr.from.trackT, tr.to.trackT, u);
      this.visibility = lerp(tr.from.visibility, tr.to.visibility, u);
      if (tr.elapsed >= tr.duration) this._transition = null;
    }

    // --- Spontaneous change -------------------------------------------------
    if (this.dynamic && !this._transition) {
      this._changeTimer += dt;
      if (this._changeTimer > 20) {
        this._changeTimer = 0;
        const chance = this.changeChancePerMinute * (20 / 60);
        if (this.rng() < chance) this._rollWeatherChange();
      }
    }

    // --- Wind drifts slowly -------------------------------------------------
    this.windDirection += (this.rng() - 0.5) * dt * 0.05;
    this.windSpeed = clamp(
      this.windSpeed + (this.rng() - 0.5) * dt * 0.6,
      0.2, 4 + this.rainRate * 5
    );
    this._updateWindVector();

    // Colder, damper air is denser, which very slightly increases both
    // downforce and drag.
    this.airDensity = 1.225 * (1 + (26 - this.ambientTemp) * 0.0034);

    // --- Track surface ------------------------------------------------------
    this._updateSurface(dt, cars);
  }

  _rollWeatherChange() {
    const r = this.rng();
    let next;
    if (this.state === WeatherState.DRY) {
      next = r < 0.75 ? WeatherState.LIGHT_RAIN : WeatherState.HEAVY_RAIN;
    } else if (this.state === WeatherState.LIGHT_RAIN) {
      next = r < 0.5 ? WeatherState.DRY : WeatherState.HEAVY_RAIN;
    } else {
      next = r < 0.8 ? WeatherState.LIGHT_RAIN : WeatherState.DRY;
    }
    // Rain arrives faster than a track dries out.
    const duration = next === WeatherState.DRY ? 90 : 40;
    this.setState(next, duration);
  }

  /**
   * Evolve the surface, per centreline sample.
   *
   * Wetness rises with rainfall and falls as cars drive the water off the
   * racing line — which is why a drying track has a dry line long before the
   * rest of the circuit is usable.
   */
  _updateSurface(dt, cars) {
    // Cars sweep water and lay rubber every frame; this is the local effect
    // that creates a dry line, so it must not be batched with the sweep below.
    this._applyCarDrying(dt, cars);

    // The whole-circuit sweep is comparatively expensive and nothing it
    // computes moves quickly, so it runs at 8 Hz rather than every frame.
    this._surfaceAccum = (this._surfaceAccum || 0) + dt;
    if (this._surfaceAccum < 0.125) return;
    const step = this._surfaceAccum;
    this._surfaceAccum = 0;

    const t = this.track;
    const n = t.sampleCount;

    const wetStep = this.rainRate * step * 0.09;
    // Evaporation is DELIBERATELY slow. A track does not dry uniformly: the
    // racing line clears in a couple of laps because cars push the water off
    // it, while everything else stays wet for far longer. If ambient drying
    // were fast enough to matter on its own it would erase that difference,
    // and with it the whole reason a drying track is interesting to race on.
    // Evaporation is DELIBERATELY slow. A track does not dry uniformly: the
    // racing line clears in a couple of laps because cars push the water off
    // it, while everything else stays wet far longer. Fast ambient drying
    // would erase that difference, and with it the whole reason a drying
    // track is interesting to race on.
    const dryStep = step * 0.00035 *
                    (1 + Math.max(0, this.trackTemp - 20) * 0.05) *
                    (1 - clamp01(this.rainRate));

    for (let i = 0; i < n; i++) {
      let w = t.wetness[i];
      // Move toward the target from whichever side we are on. Clamping with a
      // min() while it is still raining would drag the surface dry the instant
      // the forecast changed, long before any water had actually gone.
      if (w < this.targetWetness) w = Math.min(this.targetWetness, w + wetStep);
      else if (w > this.targetWetness) w = Math.max(this.targetWetness, w - dryStep);
      t.wetness[i] = w;

      // Rain closes the dry line far faster than traffic opens it.
      if (this.rainRate > 0.05) {
        t.lineDry[i] = Math.max(0, t.lineDry[i] - step * 0.10 * this.rainRate);
      }

      // Standing water forms only once the surface is saturated, and it pools
      // where the track is flat rather than where it drains — which is where
      // aquaplaning actually happens.
      const gradient = Math.abs(t.gradient[i]);
      const drainage = clamp01(0.35 + gradient * 6);
      const target = Math.max(0, (w - 0.62) / 0.38) * 0.0052 * (1.4 - drainage);
      t.waterDepth[i] = lerp(t.waterDepth[i], target, clamp01(step * 0.4));
    }
  }

  /**
   * Cars sweep water off the line they drive and lay rubber down on it.
   * Both effects are local, which is what creates a dry line.
   */
  _applyCarDrying(dt, cars) {
    if (!cars || cars.length === 0) return;
    const t = this.track;
    const n = t.sampleCount;
    const spread = 3;

    for (const car of cars) {
      const pos = car.position || car;
      if (!pos || pos.x == null) continue;
      const speed = car.speed ?? 0;
      if (speed < 5) continue;
      const i = t.nearestIndex(pos.x, pos.z);

      for (let k = -spread; k <= spread; k++) {
        const j = (i + k + n) % n;
        const falloff = 1 - Math.abs(k) / (spread + 1);
        if (this.rainRate < 0.05) {
          // Tires push the film of water aside, opening a dry line while the
          // rest of the circuit is still soaked. This is a separate channel
          // from the baseline wetness precisely so the two can differ.
          t.lineDry[j] = Math.min(
            1, t.lineDry[j] + dt * 0.055 * falloff * clamp01(speed / 40)
          );
          // Rubber builds up over a session, not over a corner.
          t.rubber[j] = Math.min(1, t.rubber[j] + dt * 0.0016 * falloff);
        } else {
          // In the rain the line still clears a little, but it is losing the
          // battle, and the rubber is being washed away everywhere.
          t.lineDry[j] = Math.min(
            0.35, t.lineDry[j] + dt * 0.006 * falloff / Math.max(1, this.rainRate)
          );
          t.rubber[j] = Math.max(0.04, t.rubber[j] - dt * 0.012 * this.rainRate * falloff);
        }
      }
    }
  }

  /** Average wetness across the circuit — for the HUD and strategy calls. */
  get averageWetness() {
    const t = this.track;
    // Reported for the racing line, because that is the surface the tire
    // choice actually has to work on.
    let sum = 0, count = 0;
    for (let i = 0; i < t.sampleCount; i += 16) {
      sum += t.wetness[i] * (1 - t.lineDry[i]);
      count++;
    }
    return count ? sum / count : 0;
  }

  get averageWaterDepth() {
    const t = this.track;
    let sum = 0, count = 0;
    for (let i = 0; i < t.sampleCount; i += 16) {
      sum += t.waterDepth[i] * (1 - t.lineDry[i]);
      count++;
    }
    return count ? sum / count : 0;
  }

  /** Which tire this weather calls for — used by the pit strategy and the UI. */
  recommendedCompound() {
    const w = this.averageWetness;
    if (w > 0.62 || this.averageWaterDepth > 0.004) return 'wet';
    if (w > 0.22) return 'intermediate';
    if (w > 0.08) return 'intermediate';
    return 'medium';
  }

  /** Environment block handed to the physics each step. */
  environment() {
    return {
      wetness: this.averageWetness,
      waterDepth: this.averageWaterDepth,
      trackRubber: 0,
      airDensity: this.airDensity,
      wind: this.wind,
      ambientTemp: this.ambientTemp,
      trackTemp: this.trackTemp,
      visibility: this.visibility,
      rainRate: this.rainRate,
      cloudCover: this.cloudCover,
      tireWearScale: 1
    };
  }

  serialize() {
    return {
      s: this.state,
      w: Math.round(this.averageWetness * 1000) / 1000,
      r: Math.round(this.rainRate * 100) / 100,
      c: Math.round(this.cloudCover * 100) / 100,
      at: Math.round(this.ambientTemp * 10) / 10,
      tt: Math.round(this.trackTemp * 10) / 10,
      v: Math.round(this.visibility * 100) / 100,
      wd: Math.round(this.windDirection * 100) / 100,
      ws: Math.round(this.windSpeed * 100) / 100
    };
  }

  deserialize(d) {
    if (!d) return;
    this.state = d.s ?? this.state;
    this.rainRate = d.r ?? this.rainRate;
    this.cloudCover = d.c ?? this.cloudCover;
    this.ambientTemp = d.at ?? this.ambientTemp;
    this.trackTemp = d.tt ?? this.trackTemp;
    this.visibility = d.v ?? this.visibility;
    this.windDirection = d.wd ?? this.windDirection;
    this.windSpeed = d.ws ?? this.windSpeed;
    this._updateWindVector();
    if (d.w != null) {
      this.targetWetness = d.w;
      // Remote clients only track the average; enough for visuals and audio.
      const t = this.track;
      for (let i = 0; i < t.sampleCount; i++) t.wetness[i] = d.w;
    }
  }
}
