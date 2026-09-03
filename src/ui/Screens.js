import { CARS, defaultSetup, SETUP_PRESETS, applyPreset } from '../cars/carDefs.js';
import { COMPOUNDS, COMPOUND_ORDER, getCompound, TireCompound } from '../physics/Tire.js';
import { AI_SKILL_PRESETS } from '../ai/AIDriver.js';
import { WeatherState, WEATHER_PRESETS } from '../race/Weather.js';
import { SessionType } from '../race/RaceDirector.js';
import { formatLapTime, formatGap, formatSector, clamp } from '../math/MathUtils.js';
import { CIRCUIT_INFO } from '../track/circuitApex.js';

/**
 * ============================================================================
 *  SCREENS
 * ============================================================================
 *
 * Everything outside the race: main menu, mode select, car and setup, the
 * multiplayer lobby, results, and settings.
 *
 * A single manager owns the DOM and swaps screens. Screens communicate with the
 * game by emitting named actions, so the UI never reaches into the simulation.
 */
export class ScreenManager extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.el = document.createElement('div');
    this.el.id = 'screens';
    root.appendChild(this.el);

    this.current = null;
    this.state = {
      playerName: loadName(),
      carId: CARS[0].id,
      setup: defaultSetup(CARS[0]),
      settings: loadSettings(),
      lastResults: null
    };
    this.toasts = document.createElement('div');
    this.toasts.className = 'toast-stack';
    root.appendChild(this.toasts);
  }

  emit(action, detail = {}) {
    this.dispatchEvent(new CustomEvent(action, { detail }));
  }

  show(name, data) {
    this.current = name;
    this.el.className = '';
    const builder = this[`_${name}`];
    if (!builder) return;
    this.el.innerHTML = `<div class="screen"><div class="screen-inner">${builder.call(this, data)}</div></div>`;
    this.el.classList.remove('hidden');
    this._wire(name, data);
  }

  hide() {
    this.el.classList.add('hidden');
    this.el.innerHTML = '';
    this.current = null;
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  // =========================================================================
  //  Main menu
  // =========================================================================

  _menu() {
    return `
      <div class="brand">
        <h1>APEX CIRCUIT</h1>
        <div class="tagline">Formula Racing Simulator</div>
      </div>
      <div class="menu-buttons">
        <button class="primary big" data-act="quick">Quick Race
          <span class="sub">Straight onto the grid against the AI</span></button>
        <button class="big" data-act="weekend">Race Weekend
          <span class="sub">Practice, qualifying, then the race</span></button>
        <button class="big" data-act="multiplayer">Multiplayer
          <span class="sub">Race other drivers online</span></button>
        <button class="big" data-act="practice">Practice
          <span class="sub">Free running to learn the circuit</span></button>
        <button class="big" data-act="timetrial">Time Trial
          <span class="sub">Empty track, one perfect lap</span></button>
        <button class="ghost" data-act="settings">Settings</button>
        <button class="ghost" data-act="help">Controls &amp; Help</button>
      </div>
      <div style="margin-top:26px;text-align:center;color:var(--text-faint);font-size:12px">
        ${CIRCUIT_INFO.name} &middot; ${(CIRCUIT_INFO.lengthHint / 1000).toFixed(2)} km &middot;
        ${CIRCUIT_INFO.corners} corners &middot; ${CIRCUIT_INFO.direction}
      </div>`;
  }

  // =========================================================================
  //  Race setup (quick race / practice / time trial)
  // =========================================================================

  _raceSetup(data = {}) {
    const s = this.state.settings;
    const mode = data.mode || 'quick';
    const isRace = mode === 'quick' || mode === 'weekend';
    return `
      <h2 class="section">${
        mode === 'practice' ? 'Practice' :
        mode === 'timetrial' ? 'Time Trial' :
        mode === 'weekend' ? 'Race Weekend' : 'Quick Race'}</h2>
      <div class="grid cols-2" style="align-items:start">
        <div class="panel">
          <h2 class="section">Session</h2>
          ${isRace ? `
          <label class="field"><span>Race distance</span>
            <input type="range" id="laps" min="2" max="30" value="${s.laps}">
            <div style="font-size:12px;color:var(--text-dim);margin-top:5px">
              <span id="laps-val">${s.laps}</span> laps
              &middot; approx <span id="laps-time">${estimateRaceTime(s.laps)}</span>
            </div>
          </label>
          <label class="field"><span>AI opponents</span>
            <input type="range" id="ai" min="0" max="19" value="${s.aiCount}">
            <div style="font-size:12px;color:var(--text-dim);margin-top:5px"><span id="ai-val">${s.aiCount}</span> cars</div>
          </label>
          <label class="field"><span>AI skill</span>
            <select id="skill">${Object.entries(AI_SKILL_PRESETS).map(([k, v]) =>
              `<option value="${k}" ${s.aiSkill === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select>
          </label>` : ''}
          <label class="field"><span>Weather</span>
            <select id="weather">${Object.values(WEATHER_PRESETS).map((w) =>
              `<option value="${w.key}" ${s.weather === w.key ? 'selected' : ''}>${w.icon} ${w.name}</option>`).join('')}</select>
          </label>
          <label class="toggle" style="margin-bottom:10px">
            <input type="checkbox" id="dynamic-weather" ${s.dynamicWeather ? 'checked' : ''}>
            <span class="track"></span><span>Changeable weather</span></label>
          <label class="field"><span>Tire wear rate</span>
            <input type="range" id="wear" min="1" max="60" value="${Math.round(s.tireWearScale * 10)}">
            <div style="font-size:12px;color:var(--text-dim);margin-top:5px">
              <span id="wear-val">${s.tireWearScale.toFixed(1)}</span>&times; &mdash;
              higher values compress a full strategy into a short race</div>
          </label>
        </div>

        <div class="panel">
          <h2 class="section">Rules &amp; assists</h2>
          <div class="grid cols-2" style="gap:8px">
            <label class="toggle"><input type="checkbox" id="r-collisions" ${s.collisions ? 'checked' : ''}><span class="track"></span><span>Collisions</span></label>
            <label class="toggle"><input type="checkbox" id="r-damage" ${s.damage ? 'checked' : ''}><span class="track"></span><span>Damage</span></label>
            <label class="toggle"><input type="checkbox" id="r-limits" ${s.rules.trackLimits ? 'checked' : ''}><span class="track"></span><span>Track limits</span></label>
            <label class="toggle"><input type="checkbox" id="r-jump" ${s.rules.jumpStart ? 'checked' : ''}><span class="track"></span><span>Jump starts</span></label>
            <label class="toggle"><input type="checkbox" id="r-pitspeed" ${s.rules.pitSpeedLimit ? 'checked' : ''}><span class="track"></span><span>Pit speed limit</span></label>
            <label class="toggle"><input type="checkbox" id="r-drs" ${s.rules.drsEnabled ? 'checked' : ''}><span class="track"></span><span>DRS</span></label>
          </div>
          <div style="height:14px"></div>
          <h2 class="section">Driving assists</h2>
          <div class="setup-row"><span class="name">Traction control</span>
            <input type="range" id="a-tc" min="0" max="2" step="1" value="${assistLevel(s.assists.tractionControl)}">
            <span class="val" id="a-tc-v">${assistLabel(s.assists.tractionControl)}</span></div>
          <div class="setup-row"><span class="name">ABS</span>
            <input type="range" id="a-abs" min="0" max="2" step="1" value="${assistLevel(s.assists.abs)}">
            <span class="val" id="a-abs-v">${assistLabel(s.assists.abs)}</span></div>
          <div class="setup-row"><span class="name">Stability</span>
            <input type="range" id="a-stab" min="0" max="2" step="1" value="${assistLevel(s.assists.stabilityControl)}">
            <span class="val" id="a-stab-v">${assistLabel(s.assists.stabilityControl)}</span></div>
          <div class="setup-row"><span class="name">Steering aid</span>
            <input type="range" id="a-steer" min="0" max="2" step="1" value="${assistLevel(s.assists.steeringAssist)}">
            <span class="val" id="a-steer-v">${assistLabel(s.assists.steeringAssist)}</span></div>
          <div class="grid cols-2" style="gap:8px;margin-top:10px">
            <label class="toggle"><input type="checkbox" id="a-auto" ${s.assists.automaticGears ? 'checked' : ''}><span class="track"></span><span>Auto gears</span></label>
            <label class="toggle"><input type="checkbox" id="a-line" ${s.assists.racingLine ? 'checked' : ''}><span class="track"></span><span>Racing line</span></label>
            <label class="toggle"><input type="checkbox" id="a-limiter" ${s.assists.autoPitLimiter ? 'checked' : ''}><span class="track"></span><span>Auto pit limiter</span></label>
          </div>
          <p class="setup-hint">Assists change how the car is controlled, never
            what it is capable of. Turning them off gives you more of the car,
            not a different one.</p>
        </div>
      </div>
      <div class="row" style="margin-top:18px">
        <button data-act="back">Back</button>
        <div class="spacer"></div>
        <button data-act="cars">Choose car &amp; setup</button>
        <button class="primary" data-act="go">Start session</button>
      </div>`;
  }

  // =========================================================================
  //  Car selection and setup
  // =========================================================================

  _cars(data = {}) {
    const sel = this.state.carId;
    const setup = this.state.setup;
    return `
      <h2 class="section">Car</h2>
      <div class="car-grid">
        ${CARS.map((c) => `
          <div class="car-card ${c.id === sel ? 'selected' : ''}" data-car="${c.id}">
            <div class="stripe" style="background:${c.colour}"></div>
            <h3>${c.name}</h3>
            <div class="team">${c.team}</div>
            <p>${c.description}</p>
            ${Object.entries(c.traits).map(([k, v]) => `
              <div class="trait"><span class="name">${k}</span><span class="bars">
                ${[1, 2, 3, 4, 5].map((i) => `<span class="bar ${i <= v ? 'on' : ''}"></span>`).join('')}
              </span></div>`).join('')}
          </div>`).join('')}
      </div>

      <div style="height:20px"></div>
      <div class="grid cols-2" style="align-items:start">
        <div class="panel">
          <h2 class="section">Setup</h2>
          <label class="field"><span>Preset</span>
            <select id="preset">
              <option value="">Custom</option>
              ${Object.entries(SETUP_PRESETS).map(([k, p]) =>
                `<option value="${k}">${p.name}</option>`).join('')}
            </select>
          </label>
          <div id="preset-desc" class="setup-hint" style="margin-bottom:14px"></div>

          <div class="setup-group">
            <h2 class="section">Aerodynamics</h2>
            ${setupRow('frontWing', 'Front wing', 1, 11, setup.frontWing)}
            ${setupRow('rearWing', 'Rear wing', 1, 11, setup.rearWing)}
            <p class="setup-hint">More wing means more cornering grip and more
              drag. The difference between the two ends sets the aerodynamic
              balance, which is where the car turns from.</p>
          </div>

          <div class="setup-group">
            <h2 class="section">Suspension</h2>
            ${setupRow('springFront', 'Front springs', 1, 11, setup.springFront)}
            ${setupRow('springRear', 'Rear springs', 1, 11, setup.springRear)}
            ${setupRow('antiRollFront', 'Front anti-roll', 1, 11, setup.antiRollFront)}
            ${setupRow('antiRollRear', 'Rear anti-roll', 1, 11, setup.antiRollRear)}
            ${setupRow('rideHeightFront', 'Front ride height', 1, 11, setup.rideHeightFront)}
            ${setupRow('rideHeightRear', 'Rear ride height', 1, 11, setup.rideHeightRear)}
            <p class="setup-hint">Stiffening one end transfers more load across
              that axle, and because tire grip falls as load rises, that end
              loses grip. A stiffer front bar means more understeer.</p>
          </div>
        </div>

        <div class="panel">
          <div class="setup-group">
            <h2 class="section">Brakes &amp; differential</h2>
            ${setupRow('brakeBalance', 'Brake balance', 40, 75, Math.round(setup.brakeBalance * 100), '%F')}
            ${setupRow('diffPower', 'Diff on power', 0, 85, Math.round(setup.diffPower * 100), '%')}
            ${setupRow('diffCoast', 'Diff on coast', 0, 85, Math.round(setup.diffCoast * 100), '%')}
            <p class="setup-hint">Brake balance forward is stable but locks the
              fronts; rearward rotates the car and risks locking the rears. A
              tighter differential drives out of corners harder but makes the
              car run wide.</p>
          </div>

          <div class="setup-group">
            <h2 class="section">Tires &amp; fuel</h2>
            <label class="field"><span>Starting compound</span>
              <select id="compound">
                ${COMPOUND_ORDER.map((k) => {
                  const c = COMPOUNDS[k];
                  return `<option value="${k}" ${setup.compound === k ? 'selected' : ''}>${c.name}</option>`;
                }).join('')}
              </select>
            </label>
            <div id="compound-info" class="setup-hint"></div>
            ${setupRow('fuel', 'Fuel load (kg)', 5, 110, Math.round(setup.fuel))}
            <p class="setup-hint">Fuel is mass. A full tank is a seventh of the
              car's weight: it slows every corner and lengthens every braking
              zone, and the car gets faster as it burns off.</p>
          </div>
        </div>
      </div>

      <div class="row" style="margin-top:18px">
        <button data-act="back">Back</button>
        <button data-act="reset-setup">Reset setup</button>
        <div class="spacer"></div>
        <button class="primary" data-act="confirm">Confirm</button>
      </div>`;
  }

  // =========================================================================
  //  Multiplayer
  // =========================================================================

  _multiplayer(data = {}) {
    const lobbies = data.lobbies || [];
    return `
      <h2 class="section">Multiplayer</h2>
      <div class="grid cols-2" style="align-items:start">
        <div class="panel">
          <h2 class="section">Join a race</h2>
          <div class="lobby-list scroll" id="lobby-list">
            ${lobbies.length ? lobbies.map((l) => `
              <div class="lobby-row" data-lobby="${l.id}">
                <div><strong>${escapeHtml(l.name)}</strong>
                  <div class="meta">${l.sessionType} &middot; ${l.laps} laps &middot; ${l.weather}</div></div>
                <span class="meta">${l.players}/${l.maxPlayers}</span>
                <span class="meta">${l.state}</span>
                <button class="btn">Join</button>
              </div>`).join('')
              : '<div style="color:var(--text-faint);font-size:13px;padding:16px;text-align:center">No races running. Host one.</div>'}
          </div>
          <button class="wide" data-act="refresh" style="margin-top:10px">Refresh</button>
        </div>
        <div class="panel">
          <h2 class="section">Host a race</h2>
          <label class="field"><span>Your name</span>
            <input type="text" id="player-name" value="${escapeHtml(this.state.playerName)}" maxlength="18"></label>
          <label class="field"><span>Race name</span>
            <input type="text" id="lobby-name" value="${escapeHtml(this.state.playerName)}'s Race" maxlength="32"></label>
          <button class="primary wide" data-act="host">Create race</button>
          <p class="setup-hint">The server runs the race: it simulates the AI
            field and decides laps, positions and penalties. Your own car is
            simulated here so the controls stay immediate.</p>
        </div>
      </div>
      <div class="row" style="margin-top:18px">
        <button data-act="back">Back</button>
        <div class="spacer"></div>
        <div id="connection-status" style="font-size:12px;color:var(--text-faint)">Connecting…</div>
      </div>`;
  }

  _lobby(data = {}) {
    const l = data.lobby;
    if (!l) return '<div class="loading"><div class="spinner"></div>Joining…</div>';
    const isHost = l.hostId === data.clientId;
    const s = l.settings;
    return `
      <h2 class="section">${escapeHtml(s.name)}</h2>
      <div class="grid cols-2" style="align-items:start">
        <div class="panel">
          <h2 class="section">Drivers (${l.players.length}/${s.maxPlayers})</h2>
          <div class="player-list">
            ${l.players.map((p) => `
              <div class="player-row">
                <span class="dot ${p.ready ? 'ready' : ''}"></span>
                <span>${escapeHtml(p.name)}</span>
                ${p.isHost ? '<span class="tag">Host</span>' : ''}
                <div class="spacer"></div>
                <span class="tag">${escapeHtml(carName(p.carId))}</span>
              </div>`).join('')}
          </div>
          <div style="height:14px"></div>
          <div class="row">
            <label class="toggle"><input type="checkbox" id="ready" ${
              l.players.find((p) => p.id === data.clientId)?.ready ? 'checked' : ''
            }><span class="track"></span><span>Ready</span></label>
            <div class="spacer"></div>
            <button data-act="cars">Car &amp; setup</button>
          </div>
        </div>
        <div class="panel">
          <h2 class="section">Race settings ${isHost ? '' : '(host only)'}</h2>
          <label class="field"><span>Laps</span>
            <input type="range" id="l-laps" min="2" max="30" value="${s.laps}" ${isHost ? '' : 'disabled'}>
            <div style="font-size:12px;color:var(--text-dim);margin-top:5px"><span id="l-laps-val">${s.laps}</span> laps</div></label>
          <label class="field"><span>AI opponents</span>
            <input type="range" id="l-ai" min="0" max="19" value="${s.aiCount}" ${isHost ? '' : 'disabled'}>
            <div style="font-size:12px;color:var(--text-dim);margin-top:5px"><span id="l-ai-val">${s.aiCount}</span> cars</div></label>
          <label class="field"><span>Weather</span>
            <select id="l-weather" ${isHost ? '' : 'disabled'}>${Object.values(WEATHER_PRESETS).map((w) =>
              `<option value="${w.key}" ${s.weather === w.key ? 'selected' : ''}>${w.icon} ${w.name}</option>`).join('')}</select></label>
          <div class="grid cols-2" style="gap:8px">
            <label class="toggle"><input type="checkbox" id="l-collisions" ${s.collisions ? 'checked' : ''} ${isHost ? '' : 'disabled'}><span class="track"></span><span>Collisions</span></label>
            <label class="toggle"><input type="checkbox" id="l-damage" ${s.damage ? 'checked' : ''} ${isHost ? '' : 'disabled'}><span class="track"></span><span>Damage</span></label>
          </div>
        </div>
      </div>
      <div class="row" style="margin-top:18px">
        <button data-act="leave">Leave</button>
        <div class="spacer"></div>
        ${isHost ? '<button class="primary" data-act="start">Start race</button>'
                 : '<div style="font-size:13px;color:var(--text-faint)">Waiting for the host…</div>'}
      </div>`;
  }

  // =========================================================================
  //  Results
  // =========================================================================

  _results(data = {}) {
    const rows = data.classification || [];
    const top3 = rows.slice(0, 3);
    const selfId = data.selfId;
    const fastest = data.fastestLap;
    return `
      <h2 class="section">${data.sessionType === SessionType.QUALIFYING ? 'Qualifying result' :
                            data.sessionType === SessionType.PRACTICE ? 'Practice result' : 'Race result'}</h2>
      ${top3.length >= 3 ? `
      <div class="podium">
        <div class="step p2"><div class="block"><div><div class="pos">2</div></div></div>
          <div class="name">${escapeHtml(top3[1].name)}</div>
          <div class="time">${formatGap(top3[1].gapToWinner)}</div></div>
        <div class="step p1"><div class="block"><div><div class="pos">1</div></div></div>
          <div class="name">${escapeHtml(top3[0].name)}</div>
          <div class="time">${formatLapTime(top3[0].totalTime)}</div></div>
        <div class="step p3"><div class="block"><div><div class="pos">3</div></div></div>
          <div class="name">${escapeHtml(top3[2].name)}</div>
          <div class="time">${formatGap(top3[2].gapToWinner)}</div></div>
      </div>` : ''}

      <div class="panel scroll" style="max-height:46vh">
        <table class="results-table">
          <thead><tr>
            <th>Pos</th><th></th><th>Driver</th><th class="num">Laps</th>
            <th class="num">Time / Gap</th><th class="num">Best lap</th>
            <th class="num">Stops</th><th>Tyres</th><th class="num">Pen</th><th class="num">+/-</th>
          </tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr class="${r.id === selfId ? 'self' : ''}">
                <td>${r.classified ? r.position : '—'}</td>
                <td><span class="swatch" style="background:${r.colour}"></span></td>
                <td>${escapeHtml(r.name)}${r.fastestLap ? ' <span style="color:var(--purple)">FL</span>' : ''}</td>
                <td class="num">${r.laps}</td>
                <td class="num">${
                  r.status === 'dnf' ? 'DNF'
                  : r.position === 1 ? formatLapTime(r.totalTime)
                  : formatGap(r.gapToWinner)}</td>
                <td class="num">${formatLapTime(r.bestLap)}</td>
                <td class="num">${r.pitStops}</td>
                <td>${r.tireStrategy.map((t) => {
                  const c = getCompound(t.compound);
                  return `<span style="color:${c.colour};font-weight:700">${c.short}</span>`;
                }).join('›')}</td>
                <td class="num">${r.penaltySeconds ? `+${r.penaltySeconds}` : '—'}</td>
                <td class="num" style="color:${r.positionsGained > 0 ? 'var(--good)' : r.positionsGained < 0 ? 'var(--bad)' : 'var(--text-faint)'}">
                  ${r.positionsGained > 0 ? '+' : ''}${r.positionsGained || '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="row wrap" style="margin-top:14px;gap:22px;font-size:12.5px;color:var(--text-dim)">
        ${fastest ? `<div>Fastest lap: <strong style="color:var(--purple)">${formatLapTime(fastest)}</strong>
          ${data.fastestLapDriver ? `by ${escapeHtml(data.fastestLapDriver.name)}` : ''}</div>` : ''}
        ${data.theoreticalBest ? `<div>Theoretical best: <strong>${formatLapTime(data.theoreticalBest)}</strong></div>` : ''}
      </div>

      <div class="row" style="margin-top:18px">
        <button data-act="menu">Main menu</button>
        <div class="spacer"></div>
        ${data.multiplayer ? '<button data-act="lobby">Back to lobby</button>' : ''}
        <button class="primary" data-act="restart">Race again</button>
      </div>`;
  }

  // =========================================================================
  //  Settings and help
  // =========================================================================

  _settings() {
    const s = this.state.settings;
    return `
      <h2 class="section">Settings</h2>
      <div class="grid cols-2" style="align-items:start">
        <div class="panel">
          <h2 class="section">Audio</h2>
          ${volumeRow('master', 'Master', s.volumes.master)}
          ${volumeRow('engine', 'Engine', s.volumes.engine)}
          ${volumeRow('tires', 'Tires', s.volumes.tires)}
          ${volumeRow('wind', 'Wind', s.volumes.wind)}
          ${volumeRow('effects', 'Effects', s.volumes.effects)}
          ${volumeRow('ui', 'Interface', s.volumes.ui)}
        </div>
        <div class="panel">
          <h2 class="section">Graphics</h2>
          <label class="field"><span>Quality</span>
            <select id="quality">
              <option value="low" ${s.quality === 'low' ? 'selected' : ''}>Low</option>
              <option value="medium" ${s.quality === 'medium' ? 'selected' : ''}>Medium</option>
              <option value="high" ${s.quality === 'high' ? 'selected' : ''}>High</option>
            </select></label>
          <h2 class="section" style="margin-top:16px">Camera</h2>
          <div class="setup-row"><span class="name">Movement</span>
            <input type="range" id="cam-shake" min="0" max="150" value="${Math.round(s.camera.shake * 100)}">
            <span class="val" id="cam-shake-v">${Math.round(s.camera.shake * 100)}%</span></div>
          <div class="setup-row"><span class="name">Speed FOV</span>
            <input type="range" id="cam-fov" min="0" max="150" value="${Math.round(s.camera.fov * 100)}">
            <span class="val" id="cam-fov-v">${Math.round(s.camera.fov * 100)}%</span></div>
          <p class="setup-hint">The camera responds to acceleration, braking and
            kerbs. Turn the movement down if it becomes uncomfortable — nothing
            about the car changes.</p>
          <h2 class="section" style="margin-top:16px">Player</h2>
          <label class="field"><span>Name</span>
            <input type="text" id="set-name" value="${escapeHtml(this.state.playerName)}" maxlength="18"></label>
        </div>
      </div>
      <div class="row" style="margin-top:18px">
        <button data-act="back">Back</button>
      </div>`;
  }

  _help() {
    return `
      <h2 class="section">Controls</h2>
      <div class="grid cols-2" style="align-items:start">
        <div class="panel">
          <h2 class="section">Driving</h2>
          <div class="help-grid">
            <span class="k"><kbd>W</kbd> / <kbd>↑</kbd></span><span class="d">Throttle</span>
            <span class="k"><kbd>S</kbd> / <kbd>↓</kbd></span><span class="d">Brake</span>
            <span class="k"><kbd>A</kbd> <kbd>D</kbd></span><span class="d">Steer</span>
            <span class="k"><kbd>E</kbd> / <kbd>Q</kbd></span><span class="d">Shift up / down</span>
            <span class="k"><kbd>Space</kbd></span><span class="d">DRS</span>
            <span class="k"><kbd>X</kbd></span><span class="d">Handbrake</span>
            <span class="k"><kbd>L</kbd></span><span class="d">Pit limiter</span>
            <span class="k"><kbd>P</kbd></span><span class="d">Request pit stop</span>
            <span class="k"><kbd>R</kbd></span><span class="d">Recover to the circuit</span>
          </div>
          <h2 class="section" style="margin-top:16px">View</h2>
          <div class="help-grid">
            <span class="k"><kbd>C</kbd></span><span class="d">Change camera</span>
            <span class="k"><kbd>B</kbd></span><span class="d">Look behind</span>
            <span class="k"><kbd>H</kbd></span><span class="d">Toggle HUD</span>
            <span class="k"><kbd>T</kbd></span><span class="d">Toggle timing tower</span>
            <span class="k"><kbd>Esc</kbd></span><span class="d">Pause</span>
          </div>
          <p class="setup-hint">A gamepad is used automatically when one is
            connected: triggers for throttle and brake, left stick to steer,
            shoulder buttons to shift.</p>
        </div>
        <div class="panel">
          <h2 class="section">Driving the car</h2>
          <p class="setup-hint" style="font-size:12.5px;line-height:1.7">
            <strong style="color:var(--text)">Grip comes from speed.</strong> The
            car makes over twice its own weight in downforce at 300 km/h, so a
            fast corner has far more grip than a slow one. Trust it in Ascari
            Sweep; do not trust it at the hairpin.<br><br>
            <strong style="color:var(--text)">Brake in a straight line.</strong>
            The tires have one grip budget. Spend it all on braking and there is
            none left to turn with — you will go straight on. Release the brakes
            as you turn in.<br><br>
            <strong style="color:var(--text)">Squeeze the throttle.</strong> In
            first and second gear the engine can far exceed what the rear tires
            can take. Full throttle out of the hairpin will spin the wheels and
            cost you the exit.<br><br>
            <strong style="color:var(--text)">Look after the tires.</strong>
            Sliding wears them and overheats them, and a tire outside its
            temperature window has noticeably less grip. Smooth is fast.<br><br>
            <strong style="color:var(--text)">Use the tow.</strong> Sitting
            behind another car down the straight cuts your drag substantially —
            but in the corners their wake costs you front grip, so following
            closely through Sector 2 hurts.
          </p>
        </div>
      </div>
      <div class="row" style="margin-top:18px"><button data-act="back">Back</button></div>`;
  }

  _pause(data = {}) {
    return `
      <h2 class="section">Paused</h2>
      <div class="menu-buttons">
        <button class="primary big" data-act="resume">Resume</button>
        <button data-act="restart">Restart session</button>
        <button data-act="settings">Settings</button>
        <button data-act="help">Controls</button>
        <button data-act="quit">Quit to menu</button>
      </div>`;
  }

  _loading(data = {}) {
    return `<div class="loading"><div class="spinner"></div>
      <div>${escapeHtml(data.text || 'Loading…')}</div></div>`;
  }

  // =========================================================================
  //  Wiring
  // =========================================================================

  _wire(name, data) {
    const el = this.el;
    const q = (s) => el.querySelector(s);
    const qa = (s) => [...el.querySelectorAll(s)];

    // Generic action buttons.
    qa('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        this.emit('action', { screen: name, action: b.dataset.act, data });
      });
    });

    if (name === 'raceSetup') {
      const s = this.state.settings;
      bindRange(q('#laps'), q('#laps-val'), (v) => {
        s.laps = v; q('#laps-time').textContent = estimateRaceTime(v); saveSettings(s);
      });
      bindRange(q('#ai'), q('#ai-val'), (v) => { s.aiCount = v; saveSettings(s); });
      bindRange(q('#wear'), q('#wear-val'), (v) => {
        s.tireWearScale = v / 10; saveSettings(s);
        q('#wear-val').textContent = s.tireWearScale.toFixed(1);
      });
      bindSelect(q('#skill'), (v) => { s.aiSkill = v; saveSettings(s); });
      bindSelect(q('#weather'), (v) => { s.weather = v; saveSettings(s); });
      bindCheck(q('#dynamic-weather'), (v) => { s.dynamicWeather = v; saveSettings(s); });
      bindCheck(q('#r-collisions'), (v) => { s.collisions = v; saveSettings(s); });
      bindCheck(q('#r-damage'), (v) => { s.damage = v; saveSettings(s); });
      bindCheck(q('#r-limits'), (v) => { s.rules.trackLimits = v; saveSettings(s); });
      bindCheck(q('#r-jump'), (v) => { s.rules.jumpStart = v; saveSettings(s); });
      bindCheck(q('#r-pitspeed'), (v) => { s.rules.pitSpeedLimit = v; saveSettings(s); });
      bindCheck(q('#r-drs'), (v) => { s.rules.drsEnabled = v; saveSettings(s); });
      for (const [id, key] of [['a-tc', 'tractionControl'], ['a-abs', 'abs'],
                               ['a-stab', 'stabilityControl'], ['a-steer', 'steeringAssist']]) {
        const input = q(`#${id}`);
        const label = q(`#${id}-v`);
        input.addEventListener('input', () => {
          const level = Number(input.value);
          s.assists[key] = level === 0 ? 0 : level === 1 ? 0.5 : 1;
          label.textContent = assistLabel(s.assists[key]);
          saveSettings(s);
        });
      }
      bindCheck(q('#a-auto'), (v) => { s.assists.automaticGears = v; saveSettings(s); });
      bindCheck(q('#a-line'), (v) => { s.assists.racingLine = v; saveSettings(s); });
      bindCheck(q('#a-limiter'), (v) => { s.assists.autoPitLimiter = v; saveSettings(s); });
    }

    if (name === 'cars') {
      qa('.car-card').forEach((card) => {
        card.addEventListener('click', () => {
          this.state.carId = card.dataset.car;
          qa('.car-card').forEach((c) => c.classList.toggle('selected', c === card));
          this.emit('carChanged', { carId: this.state.carId });
        });
      });
      const preset = q('#preset');
      const desc = q('#preset-desc');
      preset.addEventListener('change', () => {
        const key = preset.value;
        if (!key) { desc.textContent = ''; return; }
        const car = CARS.find((c) => c.id === this.state.carId) || CARS[0];
        this.state.setup = applyPreset(car, key);
        desc.textContent = SETUP_PRESETS[key].description;
        this.show('cars', data);   // re-render with the new values
        this.el.querySelector('#preset').value = key;
        this.el.querySelector('#preset-desc').textContent = SETUP_PRESETS[key].description;
      });
      qa('[data-setup]').forEach((input) => {
        const key = input.dataset.setup;
        const label = el.querySelector(`[data-setup-val="${key}"]`);
        input.addEventListener('input', () => {
          let v = Number(input.value);
          if (key === 'brakeBalance' || key === 'diffPower' || key === 'diffCoast') v /= 100;
          this.state.setup[key] = v;
          label.textContent = input.dataset.suffix
            ? `${input.value}${input.dataset.suffix}` : input.value;
          preset.value = '';
        });
      });
      const compound = q('#compound');
      const info = q('#compound-info');
      const describeCompound = () => {
        const c = COMPOUNDS[compound.value];
        info.innerHTML = `Peak grip <strong>${c.peakGrip.toFixed(2)}</strong> ·
          window <strong>${c.tempWindowLow}–${c.tempWindowHigh}°C</strong> ·
          wear rate <strong>${c.wearRate.toFixed(2)}×</strong>`;
      };
      compound.addEventListener('change', () => {
        this.state.setup.compound = compound.value;
        describeCompound();
      });
      describeCompound();
    }

    if (name === 'multiplayer') {
      qa('.lobby-row').forEach((row) => {
        row.addEventListener('click', () => {
          this.emit('action', { screen: name, action: 'join', data: { lobbyId: row.dataset.lobby } });
        });
      });
      const nameInput = q('#player-name');
      if (nameInput) {
        nameInput.addEventListener('change', () => {
          this.state.playerName = nameInput.value.trim() || 'Driver';
          saveName(this.state.playerName);
        });
      }
    }

    if (name === 'lobby') {
      const ready = q('#ready');
      if (ready) ready.addEventListener('change', () => {
        this.emit('action', { screen: name, action: 'ready', data: { ready: ready.checked } });
      });
      const emitSettings = () => {
        this.emit('action', {
          screen: name, action: 'settings', data: {
            settings: {
              laps: Number(q('#l-laps').value),
              aiCount: Number(q('#l-ai').value),
              weather: q('#l-weather').value,
              collisions: q('#l-collisions').checked,
              damage: q('#l-damage').checked
            }
          }
        });
      };
      bindRange(q('#l-laps'), q('#l-laps-val'), emitSettings);
      bindRange(q('#l-ai'), q('#l-ai-val'), emitSettings);
      ['#l-weather', '#l-collisions', '#l-damage'].forEach((sel) => {
        const e2 = q(sel);
        if (e2 && !e2.disabled) e2.addEventListener('change', emitSettings);
      });
    }

    if (name === 'settings') {
      const s = this.state.settings;
      for (const key of Object.keys(s.volumes)) {
        const input = q(`#vol-${key}`);
        const label = q(`#vol-${key}-v`);
        if (!input) continue;
        input.addEventListener('input', () => {
          s.volumes[key] = Number(input.value) / 100;
          label.textContent = `${input.value}%`;
          saveSettings(s);
          this.emit('volumeChanged', { channel: key, value: s.volumes[key] });
        });
      }
      bindSelect(q('#quality'), (v) => {
        s.quality = v; saveSettings(s); this.emit('qualityChanged', { quality: v });
      });
      const shake = q('#cam-shake');
      shake.addEventListener('input', () => {
        s.camera.shake = Number(shake.value) / 100;
        q('#cam-shake-v').textContent = `${shake.value}%`;
        saveSettings(s); this.emit('cameraChanged', { camera: s.camera });
      });
      const fov = q('#cam-fov');
      fov.addEventListener('input', () => {
        s.camera.fov = Number(fov.value) / 100;
        q('#cam-fov-v').textContent = `${fov.value}%`;
        saveSettings(s); this.emit('cameraChanged', { camera: s.camera });
      });
      const nameInput = q('#set-name');
      nameInput.addEventListener('change', () => {
        this.state.playerName = nameInput.value.trim() || 'Driver';
        saveName(this.state.playerName);
      });
    }
  }
}

// ---------------------------------------------------------------- helpers

function setupRow(key, label, min, max, value, suffix = '') {
  return `<div class="setup-row">
    <span class="name">${label}</span>
    <input type="range" data-setup="${key}" min="${min}" max="${max}" value="${value}" data-suffix="${suffix}">
    <span class="val" data-setup-val="${key}">${value}${suffix}</span>
  </div>`;
}

function volumeRow(key, label, value) {
  return `<div class="setup-row">
    <span class="name">${label}</span>
    <input type="range" id="vol-${key}" min="0" max="100" value="${Math.round(value * 100)}">
    <span class="val" id="vol-${key}-v">${Math.round(value * 100)}%</span>
  </div>`;
}

function bindRange(input, label, cb) {
  if (!input) return;
  input.addEventListener('input', () => {
    if (label) label.textContent = input.value;
    if (cb) cb(Number(input.value));
  });
}
function bindSelect(el, cb) { if (el) el.addEventListener('change', () => cb(el.value)); }
function bindCheck(el, cb) { if (el) el.addEventListener('change', () => cb(el.checked)); }

function assistLevel(v) { return v === 0 ? 0 : v <= 0.5 ? 1 : 2; }
function assistLabel(v) { return v === 0 ? 'Off' : v <= 0.5 ? 'Medium' : 'Full'; }

function carName(id) {
  const c = CARS.find((x) => x.id === id);
  return c ? c.name : id;
}

/** Rough race duration for the lap slider, from the circuit's reference lap. */
function estimateRaceTime(laps) {
  const seconds = laps * CIRCUIT_INFO.lapRecordHint * 1.06 + 25;
  const m = Math.floor(seconds / 60);
  return `${m} min`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ------------------------------------------------------------- persistence

const SETTINGS_KEY = 'apex-circuit-settings';
const NAME_KEY = 'apex-circuit-name';

export function defaultUiSettings() {
  return {
    laps: 6,
    aiCount: 7,
    aiSkill: 'pro',
    weather: WeatherState.DRY,
    dynamicWeather: false,
    collisions: true,
    damage: true,
    tireWearScale: 3.0,
    quality: 'high',
    volumes: { master: 0.75, engine: 0.85, tires: 0.9, wind: 0.6, effects: 0.9, ui: 0.8 },
    camera: { shake: 1.0, fov: 1.0 },
    assists: {
      tractionControl: 0.5,
      abs: 0.5,
      stabilityControl: 0,
      steeringAssist: 0,
      automaticGears: true,
      autoPitLimiter: true,
      racingLine: true
    },
    rules: {
      trackLimits: true, jumpStart: true, pitSpeedLimit: true,
      drsEnabled: true, mandatoryPitStop: false
    }
  };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultUiSettings();
    const parsed = JSON.parse(raw);
    const base = defaultUiSettings();
    return {
      ...base, ...parsed,
      volumes: { ...base.volumes, ...(parsed.volumes || {}) },
      camera: { ...base.camera, ...(parsed.camera || {}) },
      assists: { ...base.assists, ...(parsed.assists || {}) },
      rules: { ...base.rules, ...(parsed.rules || {}) }
    };
  } catch {
    return defaultUiSettings();
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

function loadName() {
  try { return localStorage.getItem(NAME_KEY) || 'Driver'; } catch { return 'Driver'; }
}
function saveName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ }
}
