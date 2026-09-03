import { formatLapTime, formatGap, formatSector, clamp, clamp01, lerp } from '../math/MathUtils.js';
import { getCompound } from '../physics/Tire.js';
import { RacePhase, DriverStatus } from '../race/RaceDirector.js';

/**
 * ============================================================================
 *  HUD
 * ============================================================================
 *
 * Everything the driver needs while the car is moving, arranged so the values
 * they read constantly (speed, gear, position, gap) are large and in fixed
 * places, and the values they consult on a straight (tire temperatures, fuel,
 * damage) are smaller and out of the way.
 *
 * DOM rather than canvas: text stays crisp at any resolution, and the layout
 * work is done by the browser rather than by us every frame. Only the values
 * that change are written, and only when they actually change.
 */
export class HUD {
  constructor(root) {
    this.root = root;
    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.el.className = 'hidden';
    root.appendChild(this.el);

    this._build();
    this._cache = {};
    this._messages = [];
    this.visible = true;
    this.showTower = true;
  }

  _build() {
    this.el.innerHTML = `
      <div id="hud-race" class="hud-panel">
        <div id="hud-position"><span class="pos">--</span><span class="of">/ --</span></div>
        <div id="hud-lap">LAP -- / --</div>
      </div>

      <div id="hud-timing" class="hud-panel">
        <div class="time-row"><span class="label">Current</span><span class="val current" id="t-current">--:--.---</span></div>
        <div class="time-row"><span class="label">Last</span><span class="val" id="t-last">--:--.---</span></div>
        <div class="time-row"><span class="label">Best</span><span class="val" id="t-best">--:--.---</span></div>
        <div id="hud-sectors">
          <div class="sector" data-s="0"></div><div class="sector" data-s="1"></div><div class="sector" data-s="2"></div>
        </div>
      </div>

      <div id="hud-gaps" class="hud-panel">
        <div class="gap-row"><span class="who" id="ahead-name">Ahead</span><span class="g" id="gap-ahead">--.---</span></div>
        <div class="gap-row"><span class="who" id="behind-name">Behind</span><span class="g" id="gap-behind">--.---</span></div>
      </div>

      <div id="hud-primary" class="hud-panel">
        <div id="hud-speed"><div class="value" id="speed-val">0</div><div class="unit">KM/H</div></div>
        <div id="hud-gear">N</div>
        <div id="hud-rpm-block">
          <div id="hud-shift-lights"></div>
          <div id="hud-rpm-bar"><div id="hud-rpm-fill"></div></div>
          <div id="hud-rpm-text">0 RPM</div>
        </div>
      </div>

      <div id="hud-car" class="hud-panel">
        <div id="hud-compound"><span class="badge">M</span><span id="compound-name">MEDIUM</span></div>
        <div id="hud-tires">
          <div class="tire" data-w="0"><div class="lbl">FL</div><div class="temp">--</div><div class="wear-bar"></div></div>
          <div class="tire" data-w="1"><div class="lbl">FR</div><div class="temp">--</div><div class="wear-bar"></div></div>
          <div class="tire" data-w="2"><div class="lbl">RL</div><div class="temp">--</div><div class="wear-bar"></div></div>
          <div class="tire" data-w="3"><div class="lbl">RR</div><div class="temp">--</div><div class="wear-bar"></div></div>
        </div>
        <div class="meter" id="m-fuel"><div class="head"><span>Fuel</span><span class="v">--</span></div><div class="bar"><div class="fill"></div></div></div>
        <div class="meter" id="m-damage"><div class="head"><span>Damage</span><span class="v">--</span></div><div class="bar"><div class="fill"></div></div></div>
        <div class="meter" id="m-ers"><div class="head"><span>Brake temp</span><span class="v">--</span></div><div class="bar"><div class="fill"></div></div></div>
      </div>

      <div id="hud-drs" class="hud-panel hidden">DRS</div>
      <div id="hud-messages"></div>
      <div id="hud-lights" class="hidden"></div>
      <div id="hud-bigtext" class="hud-panel hidden"></div>

      <div id="timing-tower" class="hud-panel"></div>
      <div id="hud-minimap" class="hud-panel"><canvas id="minimap-canvas" width="344" height="344"></canvas></div>
      <div id="hud-net" class="hud-panel hidden"></div>
    `;

    const $ = (id) => this.el.querySelector(id);
    this.dom = {
      position: $('#hud-position .pos'),
      positionOf: $('#hud-position .of'),
      lap: $('#hud-lap'),
      tCurrent: $('#t-current'),
      tLast: $('#t-last'),
      tBest: $('#t-best'),
      sectors: [...this.el.querySelectorAll('#hud-sectors .sector')],
      gapAhead: $('#gap-ahead'),
      gapBehind: $('#gap-behind'),
      aheadName: $('#ahead-name'),
      behindName: $('#behind-name'),
      speed: $('#speed-val'),
      gear: $('#hud-gear'),
      rpmFill: $('#hud-rpm-fill'),
      rpmText: $('#hud-rpm-text'),
      shiftLights: $('#hud-shift-lights'),
      compound: $('#hud-compound .badge'),
      compoundName: $('#compound-name'),
      tires: [...this.el.querySelectorAll('.tire')],
      fuel: $('#m-fuel'),
      damage: $('#m-damage'),
      brakes: $('#m-ers'),
      drs: $('#hud-drs'),
      messages: $('#hud-messages'),
      lights: $('#hud-lights'),
      bigtext: $('#hud-bigtext'),
      tower: $('#timing-tower'),
      minimap: $('#minimap-canvas'),
      net: $('#hud-net')
    };

    // Shift lights: fifteen lamps across the rev range.
    for (let i = 0; i < 15; i++) {
      const lamp = document.createElement('div');
      lamp.className = 'lamp';
      this.dom.shiftLights.appendChild(lamp);
    }
    this.shiftLamps = [...this.dom.shiftLights.children];

    // Starting lights.
    for (let i = 0; i < 5; i++) {
      const l = document.createElement('div');
      l.className = 'light';
      this.dom.lights.appendChild(l);
    }
    this.startLights = [...this.dom.lights.children];

    this.minimapCtx = this.dom.minimap.getContext('2d');
  }

  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }
  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden-hud', !this.visible);
  }
  toggleTower() {
    this.showTower = !this.showTower;
    this.dom.tower.classList.toggle('hidden', !this.showTower);
  }

  /** Write only what changed — the DOM is slow if you rewrite it every frame. */
  _set(key, el, value, prop = 'textContent') {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    el[prop] = value;
  }

  _setClass(key, el, className, on) {
    const k = key + ':' + className;
    if (this._cache[k] === on) return;
    this._cache[k] = on;
    el.classList.toggle(className, on);
  }

  /**
   * @param {object} data {
   *   vehicle, entry, director, standings, weather, track, net, assists
   * }
   */
  update(dt, data) {
    if (!data || !data.vehicle) return;
    const v = data.vehicle;
    const e = data.entry;
    const d = data.director;

    // --- Speed, gear, rpm ---------------------------------------------------
    this._set('speed', this.dom.speed, Math.round(v.speedKmh));
    const gear = v.transmission.gear;
    this._set('gear', this.dom.gear, gear === 0 ? 'R' : gear);

    const revFrac = clamp01(v.rpm / v.engine.limiterRpm);
    this._set('rpmw', this.dom.rpmFill, `${(revFrac * 100).toFixed(1)}%`, 'style.width');
    this.dom.rpmFill.style.width = `${(revFrac * 100).toFixed(1)}%`;
    this._set('rpmt', this.dom.rpmText, `${Math.round(v.rpm)} RPM`);

    // Shift lights, with the top three flashing on the limiter.
    const lit = Math.floor(clamp01((v.rpm - v.engine.idleRpm * 1.6) /
                (v.engine.limiterRpm - v.engine.idleRpm * 1.6)) * 15);
    const limiter = v.engine.limiterActive;
    for (let i = 0; i < 15; i++) {
      const on = i < lit;
      let colour = 'rgba(255,255,255,0.10)';
      if (on) {
        if (limiter && i >= 12) colour = ((performance.now() / 60) | 0) % 2 ? '#4a90ff' : '#0a0a0a';
        else if (i < 6) colour = '#3fbf52';
        else if (i < 11) colour = '#f2c53d';
        else colour = '#e8323c';
      }
      if (this.shiftLamps[i]._c !== colour) {
        this.shiftLamps[i].style.background = colour;
        this.shiftLamps[i]._c = colour;
      }
    }

    // --- Race position ------------------------------------------------------
    if (e && d) {
      this._set('pos', this.dom.position, e.position);
      this._set('posof', this.dom.positionOf, `/ ${d.entries.size}`);
      const lapNum = Math.min(e.lap + 1, d.totalLaps);
      this._set('lap', this.dom.lap,
        d.sessionType === 'race' ? `LAP ${lapNum} / ${d.totalLaps}` : `LAP ${e.lap + 1}`);

      // --- Timing ----------------------------------------------------------
      const t = e.timing;
      this._set('tc', this.dom.tCurrent, formatLapTime(t.currentLapTime(d.raceTime)));
      this._set('tl', this.dom.tLast, formatLapTime(t.lastLap));
      this._set('tb', this.dom.tBest, formatLapTime(t.bestLap));

      for (let i = 0; i < 3; i++) {
        const st = t.lastSectors[i];
        const pb = t.bestSectors[i];
        const sb = d.records.bestSectors[i];
        let cls = '';
        if (st != null) {
          if (sb != null && st <= sb + 0.0005) cls = 'sb';
          else if (pb != null && st <= pb + 0.0005) cls = 'pb';
          else cls = 'slower';
        }
        const el = this.dom.sectors[i];
        if (el._cls !== cls) {
          el.className = `sector ${cls}`;
          el._cls = cls;
        }
      }

      // --- Gaps -------------------------------------------------------------
      const list = d.order.map((id) => d.entries.get(id));
      const idx = list.indexOf(e);
      const ahead = idx > 0 ? list[idx - 1] : null;
      const behind = idx < list.length - 1 ? list[idx + 1] : null;
      this._set('an', this.dom.aheadName, ahead ? ahead.shortName : '—');
      this._set('bn', this.dom.behindName, behind ? behind.shortName : '—');
      this._set('ga', this.dom.gapAhead, ahead ? formatGap(e.intervalAhead) : '--.---');
      this._set('gb', this.dom.gapBehind, behind ? formatGap(e.gapBehind) : '--.---');
    }

    // --- Tires --------------------------------------------------------------
    const compound = getCompound(v.compound);
    this._set('cb', this.dom.compound, compound.short);
    this.dom.compound.style.background = compound.colour;
    this._set('cn', this.dom.compoundName, compound.name.toUpperCase());

    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const tire = w.tire;
      const el = this.dom.tires[i];
      const temp = Math.round(tire.surfaceTemp);
      const tempEl = el.querySelector('.temp');
      if (tempEl._v !== temp) { tempEl.textContent = `${temp}°`; tempEl._v = temp; }

      const thermal = tire.thermalState;
      const cls = thermal < -0.15 ? 'cold' : thermal > 0.15 ? 'hot' : 'optimal';
      if (el._cls !== cls) { el.className = `tire ${cls}`; el._cls = cls; }

      const cond = clamp01(1 - tire.wear);
      const bar = el.querySelector('.wear-bar');
      const pct = `${(cond * 100).toFixed(0)}%`;
      if (bar._w !== pct) {
        bar.style.width = pct;
        bar.style.background = cond > 0.5 ? 'var(--good)' : cond > 0.25 ? 'var(--warn)' : 'var(--bad)';
        bar._w = pct;
      }
    }

    // --- Meters -------------------------------------------------------------
    this._meter('fuel', this.dom.fuel, v.fuel / v.car.fuelCapacity,
      `${v.fuel.toFixed(1)} kg`, true);
    this._meter('damage', this.dom.damage, v.damage.overall,
      `${Math.round(v.damage.overall * 100)}%`, true);
    const maxBrake = Math.max(...v.brakes.temps);
    this._meter('brakes', this.dom.brakes, clamp01((maxBrake - 100) / 700),
      `${Math.round(maxBrake)}°C`, false);

    // --- DRS ----------------------------------------------------------------
    const drsAvail = e ? e.drsAvailable : false;
    this._setClass('drsv', this.dom.drs, 'hidden', !drsAvail);
    this._setClass('drsa', this.dom.drs, 'active', v.drsActive);

    // --- Start lights -------------------------------------------------------
    if (d) {
      const showLights = d.phase === RacePhase.COUNTDOWN;
      this._setClass('lights', this.dom.lights, 'hidden', !showLights);
      if (showLights) {
        for (let i = 0; i < 5; i++) {
          this._setClass(`l${i}`, this.startLights[i], 'on', i < d.countdownLights);
        }
      }
    }

    // --- Timing tower -------------------------------------------------------
    if (this.showTower && data.standings) this._updateTower(data.standings, e?.id);

    // --- Minimap ------------------------------------------------------------
    if (data.track) this._drawMinimap(data.track, data.cars || [], e?.id);

    // --- Network ------------------------------------------------------------
    if (data.net) {
      const q = data.net;
      this._setClass('netv', this.dom.net, 'hidden', !q.connected && !q.degraded);
      this._set('nett', this.dom.net,
        q.lost ? 'CONNECTION LOST' : `${q.latency} ms`);
      this._setClass('netd', this.dom.net, 'degraded', q.degraded && !q.lost);
      this._setClass('netl', this.dom.net, 'lost', q.lost);
    }
  }

  _meter(key, el, fraction, text, goodIsHigh) {
    const f = clamp01(fraction);
    const fill = el.querySelector('.fill');
    const val = el.querySelector('.v');
    const pct = `${(f * 100).toFixed(0)}%`;
    if (fill._w !== pct) {
      fill.style.width = pct;
      const healthy = goodIsHigh ? f : 1 - f;
      fill.style.background = healthy > 0.5 ? 'var(--good)'
                            : healthy > 0.22 ? 'var(--warn)' : 'var(--bad)';
      fill._w = pct;
    }
    if (val._t !== text) { val.textContent = text; val._t = text; }
  }

  _updateTower(standings, selfId) {
    // Rebuild only when the order or the row count changes.
    const sig = standings.map((s) => `${s.id}:${s.position}:${s.status}`).join('|');
    if (this._towerSig !== sig) {
      this._towerSig = sig;
      this.dom.tower.innerHTML = standings.map((s) => {
        const compound = getCompound(s.compound);
        const gap = s.position === 1 ? 'LEADER'
                  : s.lapsDown > 0 ? `+${s.lapsDown}L`
                  : formatGap(s.interval);
        const flags = [];
        if (s.inPit) flags.push('PIT');
        if (s.penaltySeconds > 0) flags.push(`+${s.penaltySeconds}`);
        if (s.status === DriverStatus.DNF) flags.push('DNF');
        if (s.fastestLap) flags.push('FL');
        return `<div class="tower-row ${s.id === selfId ? 'self' : ''} ${s.inPit ? 'pit' : ''}" data-id="${s.id}">
          <span class="p">${s.position}</span>
          <span class="c" style="background:${s.colour}"></span>
          <span class="n">${escapeHtml(s.shortName || s.name)}</span>
          <span class="t" style="background:${compound.colour}">${compound.short}</span>
          <span class="g">${flags.length ? `<span class="flag">${flags.join(' ')}</span> ` : ''}${gap}</span>
        </div>`;
      }).join('');
    } else {
      // Just refresh the gaps, which change every frame.
      const rows = this.dom.tower.children;
      for (let i = 0; i < rows.length && i < standings.length; i++) {
        const s = standings[i];
        const g = rows[i].querySelector('.g');
        const gap = s.position === 1 ? 'LEADER'
                  : s.lapsDown > 0 ? `+${s.lapsDown}L`
                  : formatGap(s.interval);
        const flags = [];
        if (s.inPit) flags.push('PIT');
        if (s.penaltySeconds > 0) flags.push(`+${s.penaltySeconds}`);
        if (s.fastestLap) flags.push('FL');
        const html = `${flags.length ? `<span class="flag">${flags.join(' ')}</span> ` : ''}${gap}`;
        if (g._h !== html) { g.innerHTML = html; g._h = html; }
      }
    }
  }

  /** Track outline with every car on it. */
  _drawMinimap(track, cars, selfId) {
    const ctx = this.minimapCtx;
    const size = this.dom.minimap.width;
    if (!this._minimapPath) {
      // Precompute the outline in normalised coordinates.
      const outline = track.getOutline(8);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of outline) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      const span = Math.max(maxX - minX, maxZ - minZ) * 1.08;
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      this._minimapTransform = { cx, cz, span };
      this._minimapPath = outline;
    }

    const { cx, cz, span } = this._minimapTransform;
    const toPx = (x, z) => [
      (x - cx) / span * size + size / 2,
      (z - cz) / span * size + size / 2
    ];

    ctx.clearRect(0, 0, size, size);

    ctx.beginPath();
    const path = this._minimapPath;
    for (let i = 0; i < path.length; i++) {
      const [px, py] = toPx(path[i].x, path[i].z);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 9;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Start/finish marker.
    const [sx, sy] = toPx(track.sx[0], track.sz[0]);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(sx - 5, sy - 5, 10, 10);

    for (const car of cars) {
      const [px, py] = toPx(car.x, car.z);
      const self = car.id === selfId;
      ctx.beginPath();
      ctx.arc(px, py, self ? 9 : 6, 0, Math.PI * 2);
      ctx.fillStyle = car.colour || '#888';
      ctx.fill();
      if (self) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
    }
  }

  // -------------------------------------------------------------------------
  //  Messages
  // -------------------------------------------------------------------------

  /** A transient banner: penalties, warnings, fastest laps. */
  message(text, kind = 'info', duration = 3.2) {
    const el = document.createElement('div');
    el.className = `hud-message ${kind}`;
    el.textContent = text;
    this.dom.messages.appendChild(el);
    const entry = { el, remaining: duration };
    this._messages.push(entry);
    // Never let messages stack up beyond what fits on screen.
    while (this._messages.length > 4) {
      const old = this._messages.shift();
      old.el.remove();
    }
  }

  /** Large centred text: GO, FINAL LAP, and so on. */
  bigText(text, duration = 1.6) {
    this.dom.bigtext.textContent = text;
    this.dom.bigtext.classList.remove('hidden');
    this._bigTextTimer = duration;
  }

  tickMessages(dt) {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const m = this._messages[i];
      m.remaining -= dt;
      if (m.remaining <= 0) {
        m.el.remove();
        this._messages.splice(i, 1);
      }
    }
    if (this._bigTextTimer > 0) {
      this._bigTextTimer -= dt;
      if (this._bigTextTimer <= 0) this.dom.bigtext.classList.add('hidden');
    }
  }

  reset() {
    this._cache = {};
    this._towerSig = null;
    this._minimapPath = null;
    for (const m of this._messages) m.el.remove();
    this._messages.length = 0;
    this.dom.bigtext.classList.add('hidden');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
