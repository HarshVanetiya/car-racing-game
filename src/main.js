import * as THREE from 'three';
import { Loop } from './core/Loop.js';
import { Input } from './core/Input.js';
import { Renderer } from './render/Renderer.js';
import { CameraMode, CAMERA_LABELS } from './render/CameraRig.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { GameSounds } from './audio/GameSounds.js';
import { HUD } from './ui/HUD.js';
import { ScreenManager, saveSettings } from './ui/Screens.js';
import { TrackModel } from './track/TrackModel.js';
import { RaceSession } from './race/RaceSession.js';
import { RacePhase, SessionType, DriverStatus } from './race/RaceDirector.js';
import { SpeedProfile } from './ai/SpeedProfile.js';
import { CARS, getCar, defaultSetup } from './cars/carDefs.js';
import { ClientNet } from './net/ClientNet.js';
import { MsgType } from './net/protocol.js';
import { TireCompound, getCompound } from './physics/Tire.js';
import { WeatherState } from './race/Weather.js';
import { clamp, clamp01, formatLapTime, makeRng } from './math/MathUtils.js';
import { Vec3 } from './math/Vec3.js';

/**
 * ============================================================================
 *  APEX CIRCUIT
 * ============================================================================
 *
 * Wires the simulation, renderer, audio and interface together and owns the
 * flow between menu, race and results.
 *
 * The important structural point: in every mode — single player and
 * multiplayer alike — the local car is stepped by the same RaceSession the
 * server runs. Multiplayer does not swap in a different physics path; it only
 * changes who is authoritative for the race state.
 */

const AI_NAMES = [
  'Rossi', 'Vance', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Kowalski',
  'Ferreira', 'Duval', 'Nakamura', 'Hartmann', 'Silva', 'Bergman', 'Aziz',
  'Novak', 'Kaminski', 'Ravel', 'Costa', 'Halvorsen'
];

class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.uiRoot = document.getElementById('ui-root');

    this.track = new TrackModel();
    this.renderer = new Renderer(this.canvas, { quality: 'high' });
    this.renderer.buildTrack(this.track);

    this.input = new Input(window);
    this.audio = new AudioEngine();
    this.sounds = new GameSounds(this.audio);
    this.hud = new HUD(this.uiRoot);
    this.screens = new ScreenManager(this.uiRoot);

    this.session = null;
    this.playerId = 'player';
    this.mode = null;
    this.paused = false;
    this.net = null;
    this.multiplayer = false;
    this.spectating = false;
    this.spectateTarget = null;

    this._seenEvents = new Set();
    this._lastPosition = 0;
    this._finalLapAnnounced = false;
    this._minimapCars = [];

    this.applySettings();
    this._wireScreens();
    this._wireVisibility();

    this.loop = new Loop((dt) => this.frame(dt));
    this.loop.start();

    this.screens.show('menu');
  }

  // -------------------------------------------------------------------------
  //  Settings
  // -------------------------------------------------------------------------

  applySettings() {
    const s = this.screens?.state?.settings;
    if (!s) return;
    this.renderer.setQuality(s.quality);
    for (const [k, v] of Object.entries(s.volumes)) this.audio.setVolume(k, v);
    if (this.renderer.cameraRig) {
      this.renderer.cameraRig.settings.shakeIntensity = s.camera.shake;
      this.renderer.cameraRig.settings.fovSpeedEffect = s.camera.fov;
    }
  }

  _wireVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.audio.suspend();
        if (this.session && !this.multiplayer) this.paused = true;
      } else {
        this.audio.resume();
      }
    });
  }

  // -------------------------------------------------------------------------
  //  Screen flow
  // -------------------------------------------------------------------------

  _wireScreens() {
    this.screens.addEventListener('action', (ev) => {
      const { screen, action, data } = ev.detail;
      // Any interaction is a user gesture — the moment audio may be started.
      this.audio.start().then(() => this.applySettings());
      this.sounds.uiClick();
      this._handleAction(screen, action, data);
    });
    this.screens.addEventListener('volumeChanged', (ev) => {
      this.audio.setVolume(ev.detail.channel, ev.detail.value);
    });
    this.screens.addEventListener('qualityChanged', (ev) => {
      this.renderer.setQuality(ev.detail.quality);
    });
    this.screens.addEventListener('cameraChanged', (ev) => {
      if (this.renderer.cameraRig) {
        this.renderer.cameraRig.settings.shakeIntensity = ev.detail.camera.shake;
        this.renderer.cameraRig.settings.fovSpeedEffect = ev.detail.camera.fov;
      }
    });
  }

  _handleAction(screen, action, data) {
    switch (`${screen}:${action}`) {
      case 'menu:quick': this._pendingMode = 'quick'; this.screens.show('raceSetup', { mode: 'quick' }); break;
      case 'menu:weekend': this._pendingMode = 'weekend'; this.screens.show('raceSetup', { mode: 'weekend' }); break;
      case 'menu:practice': this._pendingMode = 'practice'; this.screens.show('raceSetup', { mode: 'practice' }); break;
      case 'menu:timetrial': this._pendingMode = 'timetrial'; this.screens.show('raceSetup', { mode: 'timetrial' }); break;
      case 'menu:multiplayer': this._openMultiplayer(); break;
      case 'menu:settings': this._returnTo = 'menu'; this.screens.show('settings'); break;
      case 'menu:help': this._returnTo = 'menu'; this.screens.show('help'); break;

      case 'raceSetup:back': this.screens.show('menu'); break;
      case 'raceSetup:cars': this._returnTo = 'raceSetup'; this.screens.show('cars'); break;
      case 'raceSetup:go': this.startSinglePlayer(this._pendingMode); break;

      case 'cars:back':
      case 'cars:confirm':
        if (this.multiplayer && this.net) {
          this.net.setCar(this.screens.state.carId, this.screens.state.setup);
          this.screens.show('lobby', { lobby: this.net.lobby, clientId: this.net.clientId });
        } else {
          this.screens.show(this._returnTo || 'raceSetup', { mode: this._pendingMode });
        }
        break;
      case 'cars:reset-setup': {
        const car = getCar(this.screens.state.carId);
        this.screens.state.setup = defaultSetup(car);
        this.screens.show('cars');
        break;
      }

      case 'multiplayer:back': this._closeMultiplayer(); this.screens.show('menu'); break;
      case 'multiplayer:refresh': if (this.net) this.net._send(MsgType.HELLO, { name: this.screens.state.playerName }); break;
      case 'multiplayer:host': this._hostLobby(); break;
      case 'multiplayer:join': if (this.net) this.net.joinLobby(data.lobbyId); break;

      case 'lobby:leave':
        if (this.net) this.net.leaveLobby();
        this.screens.show('multiplayer', { lobbies: this.net?.lobbies || [] });
        break;
      case 'lobby:ready': if (this.net) this.net.setReady(data.ready); break;
      case 'lobby:settings': if (this.net) this.net.setSettings(data.settings); break;
      case 'lobby:start': if (this.net) this.net.startRace(); break;
      case 'lobby:cars': this._returnTo = 'lobby'; this.screens.show('cars'); break;

      case 'settings:back': this.screens.show(this._returnTo || 'menu'); break;
      case 'help:back': this.screens.show(this._returnTo || 'menu'); break;

      case 'pause:resume': this.resume(); break;
      case 'pause:restart': this.screens.hide(); this.paused = false; this.startSinglePlayer(this.mode); break;
      case 'pause:settings': this._returnTo = 'pause'; this.screens.show('settings'); break;
      case 'pause:help': this._returnTo = 'pause'; this.screens.show('help'); break;
      case 'pause:quit': this.quitToMenu(); break;

      case 'results:menu': this.quitToMenu(); break;
      case 'results:restart':
        if (this.multiplayer && this.net) this.net.returnToLobby();
        else { this.screens.hide(); this.startSinglePlayer(this.mode); }
        break;
      case 'results:lobby':
        if (this.net) {
          this.net.returnToLobby();
          this.screens.show('lobby', { lobby: this.net.lobby, clientId: this.net.clientId });
        }
        break;
      default: break;
    }
  }

  // -------------------------------------------------------------------------
  //  Single player
  // -------------------------------------------------------------------------

  startSinglePlayer(mode) {
    this.mode = mode || 'quick';
    this.multiplayer = false;
    this.spectating = false;
    this._closeMultiplayer();

    const s = this.screens.state.settings;
    const sessionType =
      this.mode === 'practice' ? SessionType.PRACTICE :
      this.mode === 'timetrial' ? SessionType.TIME_TRIAL :
      this.mode === 'weekend' ? SessionType.RACE : SessionType.RACE;

    this.screens.show('loading', { text: 'Preparing the circuit…' });

    // Build on the next frame so the loading screen paints first.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._buildSession(sessionType, s);
      this.screens.hide();
      this.hud.show();
      this.hud.reset();
      this._seenEvents.clear();
      this._finalLapAnnounced = false;
      this.paused = false;
    }));
  }

  _buildSession(sessionType, s) {
    this._disposeSession();

    const soloModes = sessionType === SessionType.PRACTICE ||
                      sessionType === SessionType.TIME_TRIAL;

    this.session = new RaceSession({
      track: this.track,
      sessionType,
      totalLaps: s.laps,
      weather: s.weather,
      dynamicWeather: s.dynamicWeather,
      collisions: s.collisions,
      damage: s.damage,
      tireWearScale: s.tireWearScale,
      rules: s.rules,
      seed: (Math.random() * 0xffffffff) >>> 0
    });

    // The player.
    const playerEntry = this.session.addDriver({
      id: this.playerId,
      name: this.screens.state.playerName,
      shortName: this.screens.state.playerName.slice(0, 3),
      carId: this.screens.state.carId,
      setup: this.screens.state.setup,
      isPlayer: true,
      assists: s.assists,
      gridPosition: 1
    });
    this.playerEntry = playerEntry;
    this.playerVehicle = playerEntry.vehicle;

    // AI field.
    const aiCount = soloModes ? 0 : s.aiCount;
    for (let i = 0; i < aiCount; i++) {
      const car = CARS[i % CARS.length];
      this.session.addDriver({
        id: `ai-${i}`,
        name: AI_NAMES[i % AI_NAMES.length],
        shortName: AI_NAMES[i % AI_NAMES.length].slice(0, 3),
        carId: car.id,
        isAI: true,
        skill: s.aiSkill,
        colour: car.colour,
        gridPosition: i + 2
      });
    }

    // Visual + audio representation for every car.
    this.renderer.clearCars();
    this.audio.clearCars();
    for (const entry of this.session.director.drivers) {
      this.renderer.addCar(entry.id, entry.vehicle.car, {
        colour: entry.colour, name: entry.name, number: entry.number
      });
      this.audio.addCar(entry.id, { isPlayer: entry.id === this.playerId });
    }

    // Racing-line assist, built from the player's own car performance.
    if (s.assists.racingLine) {
      const v = this.playerVehicle;
      const profile = new SpeedProfile(this.track, {
        mass: v.car.dryMass + v.fuel,
        clA: v.aero.effectiveClA(),
        cdA: v.aero.effectiveCdA(),
        grip: v.wheels[0].tire.compound.peakGrip,
        powerKw: v.engine.peakPowerKw,
        cogHeight: v.car.cogHeight,
        trackWidth: (v.car.trackFront + v.car.trackRear) * 0.5,
        confidence: 0.92
      });
      this.renderer.buildRacingLineGuide(profile);
      this.renderer.setRacingLineVisible(true);
    } else {
      this.renderer.setRacingLineVisible(false);
    }

    this.renderer.skids.clear();
    this.renderer.particles.clear();

    if (sessionType === SessionType.RACE) this.session.startRace(2.0);
    else this.session.startSession();

    this.applySettings();
  }

  // -------------------------------------------------------------------------
  //  Multiplayer
  // -------------------------------------------------------------------------

  _openMultiplayer() {
    this.multiplayer = true;
    if (!this.net) {
      this.net = new ClientNet();
      this._wireNet();
    }
    this.net.connect(this.screens.state.playerName);
    this.screens.show('multiplayer', { lobbies: this.net.lobbies });
  }

  _closeMultiplayer() {
    if (this.net) { this.net.disconnect(); this.net = null; }
    this.multiplayer = false;
  }

  _hostLobby() {
    if (!this.net) return;
    const nameInput = document.getElementById('lobby-name');
    const s = this.screens.state.settings;
    this.net.createLobby({
      name: nameInput?.value || `${this.screens.state.playerName}'s Race`,
      laps: s.laps,
      aiCount: s.aiCount,
      aiSkill: s.aiSkill,
      weather: s.weather,
      dynamicWeather: s.dynamicWeather,
      collisions: s.collisions,
      damage: s.damage,
      tireWearScale: s.tireWearScale,
      assists: s.assists,
      rules: s.rules
    });
  }

  _wireNet() {
    const net = this.net;
    net.addEventListener('connected', () => {
      const el = document.getElementById('connection-status');
      if (el) el.textContent = 'Connected';
      net.setCar(this.screens.state.carId, this.screens.state.setup);
    });
    net.addEventListener('disconnected', () => {
      const el = document.getElementById('connection-status');
      if (el) el.textContent = 'Disconnected — retrying…';
    });
    net.addEventListener('lobbyList', (ev) => {
      if (this.screens.current === 'multiplayer') {
        this.screens.show('multiplayer', { lobbies: ev.detail.lobbies });
      }
    });
    net.addEventListener('lobbyState', (ev) => {
      if (this.screens.current === 'multiplayer' || this.screens.current === 'lobby') {
        this.screens.show('lobby', { lobby: ev.detail, clientId: net.clientId });
      }
    });
    net.addEventListener('raceInit', (ev) => this._startNetworkRace(ev.detail));
    net.addEventListener('raceEvents', (ev) => {
      for (const e of ev.detail.events) this._handleRaceEvent(e, true);
    });
    net.addEventListener('ownRaceState', (ev) => {
      // The server's verdict on OUR race state. Position, lap and penalties
      // come from here; the car's physical state never does.
      const c = ev.detail;
      if (!this.playerEntry) return;
      this.playerEntry.position = c.pos;
      this.playerEntry.lap = c.lap;
      this.playerEntry.penaltySeconds = c.pen;
      this.playerEntry.pitStops = c.pit;
      this.playerEntry.drsAvailable = !!c.drs;
      if (this.playerVehicle) this.playerVehicle.drsAvailable = !!c.drs;
    });
    net.addEventListener('results', (ev) => this._showResults(ev.detail));
    net.addEventListener('error', (ev) => this.screens.toast(ev.detail.message, 'error'));
    net.addEventListener('chat', (ev) => {
      this.screens.toast(`${ev.detail.from}: ${ev.detail.text}`);
    });
  }

  _startNetworkRace(init) {
    this.screens.show('loading', { text: 'Joining the grid…' });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._disposeSession();
      const s = init.settings;
      this.playerId = this.net.clientId;

      // A local session containing ONLY our own car. The server owns everyone
      // else; we simulate ourselves so the controls are immediate.
      this.session = new RaceSession({
        track: this.track,
        sessionType: s.sessionType,
        totalLaps: s.laps,
        weather: s.weather,
        collisions: false,     // remote cars are interpolated, not simulated
        damage: s.damage,
        tireWearScale: s.tireWearScale,
        rules: s.rules,
        seed: init.seed
      });

      const me = init.drivers.find((d) => d.id === this.playerId);
      const entry = this.session.addDriver({
        id: this.playerId,
        name: me?.name || this.screens.state.playerName,
        carId: me?.carId || this.screens.state.carId,
        setup: this.screens.state.setup,
        isPlayer: true,
        assists: this.screens.state.settings.assists,
        gridPosition: me?.gridPosition ?? 1
      });
      this.playerEntry = entry;
      this.playerVehicle = entry.vehicle;
      this.session.startSession();

      // Place ourselves on the right grid slot.
      const slot = this.track.gridSlots[Math.max(0, (me?.gridPosition ?? 1) - 1)];
      entry.vehicle.placeAt(slot.position, slot.heading);
      entry.vehicle.body.position.y += 0.05;

      // Visuals and audio for the whole field.
      this.renderer.clearCars();
      this.audio.clearCars();
      for (const d of init.drivers) {
        this.renderer.addCar(d.id, getCar(d.carId), {
          colour: d.colour, name: d.name, number: d.number
        });
        this.audio.addCar(d.id, { isPlayer: d.id === this.playerId });
      }
      this.netDrivers = new Map(init.drivers.map((d) => [d.id, d]));

      this.renderer.skids.clear();
      this.renderer.particles.clear();
      this.screens.hide();
      this.hud.show();
      this.hud.reset();
      this._seenEvents.clear();
      this.paused = false;
      this.multiplayer = true;
    }));
  }

  // -------------------------------------------------------------------------
  //  Frame
  // -------------------------------------------------------------------------

  frame(dt) {
    const controls = this.input.update(dt);

    if (!this.session) {
      // Menu backdrop: slowly orbit the circuit so the menu is not static.
      this._menuCamera(dt);
      this.renderer.render(dt);
      return;
    }

    if (controls.pause && !this.paused) this.pause();
    else if (controls.pause && this.paused) this.resume();

    if (!this.paused) {
      this._applyPlayerControls(controls, dt);
      this.session.update(dt);
      if (this.multiplayer && this.net) {
        this.net.update(dt, this.playerVehicle);
        this.net.interpolate(dt);
      }
      this._processEvents();
    }

    this._updateCamera(dt, controls);
    this._updateVisuals(dt);
    this._updateAudio(dt);
    this._updateHud(dt);
    this.renderer.render(dt);
  }

  _applyPlayerControls(c, dt) {
    const v = this.playerVehicle;
    if (!v || this.spectating) return;
    const entry = this.playerEntry;
    const finished = entry && entry.status === DriverStatus.FINISHED;

    v.controls.throttle = finished ? 0 : c.throttle;
    v.controls.brake = finished ? Math.max(c.brake, 0.2) : c.brake;
    v.controls.steer = c.steer;
    v.controls.handbrake = c.handbrake;
    v.controls.drs = c.drs;
    if (c.shiftUp) v.controls.shiftUp = true;
    if (c.shiftDown) v.controls.shiftDown = true;
    if (c.pitLimiter) v.controls.pitLimiter = !v.controls.pitLimiter;

    if (c.hud) this.hud.toggle();
    if (c.timingTower) this.hud.toggleTower();
    if (c.camera) {
      const mode = this.renderer.cameraRig.cycle(1);
      this.hud.message(CAMERA_LABELS[mode], 'info', 1.2);
    }
    if (c.pitRequest) this._togglePitRequest();
    if (c.resetCar) this._requestRecovery();
  }

  _togglePitRequest() {
    const entry = this.playerEntry;
    if (!entry) return;
    if (entry.pitRequest) {
      entry.pitRequest = null;
      if (this.multiplayer && this.net) this.net.requestPit(null, false);
      this.hud.message('Pit stop cancelled', 'info');
    } else {
      // Choose a sensible compound for the conditions and what is left to run.
      const wet = this.session.weather.averageWetness;
      const lapsLeft = this.session.director.totalLaps - entry.lap;
      const compound = wet > 0.55 ? TireCompound.WET
                     : wet > 0.2 ? TireCompound.INTERMEDIATE
                     : lapsLeft > 22 ? TireCompound.HARD
                     : lapsLeft > 12 ? TireCompound.MEDIUM
                     : TireCompound.SOFT;
      const repair = this.playerVehicle.damage.overall < 0.8;
      entry.pitRequest = { compound, repair };
      if (this.multiplayer && this.net) this.net.requestPit(compound, repair);
      this.hud.message(
        `Box this lap — ${getCompound(compound).name}${repair ? ' + repairs' : ''}`, 'info', 4
      );
      this.sounds.pitEntry();
    }
  }

  _requestRecovery() {
    const entry = this.playerEntry;
    const v = this.playerVehicle;
    if (!entry || !v) return;
    // Only when genuinely stuck, and it costs time — a recovery must never be
    // a shortcut.
    if (v.speed > 6) {
      this.hud.message('Recovery only when stopped', 'warn', 2);
      return;
    }
    entry.stuckTimer = 99;   // the director will place the car on its next pass
    this.hud.message('Recovering to the circuit', 'warn', 2.5);
  }

  // -------------------------------------------------------------------------
  //  Camera, visuals, audio
  // -------------------------------------------------------------------------

  _menuCamera(dt) {
    this._menuAngle = (this._menuAngle || 0) + dt * 0.045;
    const d = (this._menuAngle * 900) % this.track.length;
    const p = this.track.pointAt(d, 0, new Vec3());
    const cam = this.renderer.camera;
    cam.position.set(p.x - 42, p.y + 26, p.z - 42);
    cam.lookAt(p.x, p.y + 1.2, p.z);
    cam.fov = 52;
    cam.updateProjectionMatrix();
    this.renderer.focusShadows(cam.position);
  }

  _updateCamera(dt, controls) {
    const rig = this.renderer.cameraRig;
    if (!rig) return;

    let subject = this.playerVehicle;
    if (this.spectating && this.spectateTarget) {
      const remote = this.net?.remoteCars.get(this.spectateTarget);
      if (remote) {
        rig.update(dt, {
          position: new THREE.Vector3(remote.position.x, remote.position.y, remote.position.z),
          quaternion: new THREE.Quaternion(remote.orientation.x, remote.orientation.y,
                                           remote.orientation.z, remote.orientation.w),
          speed: remote.speed, lateralG: 0, longitudinalG: 0,
          distance: 0, steerAngle: remote.steerAngle
        });
        return;
      }
    }
    if (!subject) return;

    const b = subject.body;
    const q = new THREE.Quaternion(b.orientation.x, b.orientation.y, b.orientation.z, b.orientation.w);
    // Looking behind flips the chase camera without changing mode.
    if (controls.lookBack && rig.mode === CameraMode.CHASE) {
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    }
    rig.update(dt, {
      position: new THREE.Vector3(b.position.x, b.position.y, b.position.z),
      quaternion: q,
      velocity: new THREE.Vector3(b.velocity.x, b.velocity.y, b.velocity.z),
      speed: subject.speed,
      lateralG: subject.telemetry.lateralG,
      longitudinalG: subject.telemetry.longitudinalG,
      verticalG: subject.telemetry.verticalG,
      kerbLoad: subject.telemetry.kerbLoad,
      steerAngle: subject.steerAngle,
      distance: this.playerEntry?.distance ?? 0
    });
    this.renderer.focusShadows(b.position);
  }

  _updateVisuals(dt) {
    const w = this.session.weather;
    this.renderer.setConditions(w.averageWetness, w.averageWaterDepth);
    this.renderer.updateWeather(dt, {
      cloudCover: w.cloudCover, rainRate: w.rainRate,
      wetness: w.averageWetness, wind: w.wind
    });

    // Start lights on the gantry.
    const d = this.session.director;
    if (this.renderer.trackBuilder) {
      this.renderer.trackBuilder.setStartLights(
        d.phase === RacePhase.COUNTDOWN ? d.countdownLights : 0,
        d.phase !== RacePhase.COUNTDOWN
      );
    }

    this._minimapCars.length = 0;

    // Local cars.
    for (const entry of this.session.director.drivers) {
      this.renderer.updateCar(dt, entry.id, entry.vehicle, true);
      this.renderer.updateCarEffects(dt, entry.id, entry.vehicle, this.track);
      this._minimapCars.push({
        id: entry.id, x: entry.vehicle.position.x, z: entry.vehicle.position.z,
        colour: entry.colour
      });
    }

    // Remote cars in multiplayer.
    if (this.multiplayer && this.net) {
      for (const [id, remote] of this.net.remoteCars) {
        this.renderer.updateCar(dt, id, remote, false);
        if (remote.initialised) {
          this._minimapCars.push({
            id, x: remote.position.x, z: remote.position.z,
            colour: this.netDrivers?.get(id)?.colour || '#888'
          });
        }
      }
    }
  }

  _updateAudio(dt) {
    if (!this.audio.started) return;
    const cam = this.renderer.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this.audio.setListener(
      { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      { x: fwd.x, y: fwd.y, z: fwd.z }
    );

    const wetness = this.session.weather.averageWetness;

    for (const entry of this.session.director.drivers) {
      const v = entry.vehicle;
      const sound = this.audio.sources.get(entry.id);
      if (!sound) continue;
      let maxSlip = 0, kerb = 0, rough = 0;
      for (const w of v.wheels) {
        maxSlip = Math.max(maxSlip, w.tire.combinedSlip);
        kerb = Math.max(kerb, w.kerbImpact);
        rough = Math.max(rough, w.surfaceHarshness * 40);
      }
      sound.setState({
        rpm: v.rpm, throttle: v.engine.throttle, brake: v.controls.brake,
        gear: v.transmission.gear, load: v.engine.throttle,
        speed: v.speed, position: v.position, velocity: v.body.velocity,
        maxSlip, kerbLoad: kerb, surfaceRoughness: clamp01(rough),
        wetness, ignitionCut: v.engine.limiterActive
      });
    }

    if (this.multiplayer && this.net) {
      for (const [id, r] of this.net.remoteCars) {
        const sound = this.audio.sources.get(id);
        if (!sound || !r.initialised) continue;
        let maxSlip = 0;
        for (const s of r.wheelSlip) maxSlip = Math.max(maxSlip, s);
        sound.setState({
          rpm: r.rpm, throttle: r.throttle, brake: r.brake, gear: r.gear,
          load: r.throttle, speed: r.speed,
          position: r.position, velocity: r.velocity,
          maxSlip, kerbLoad: 0, surfaceRoughness: 0, wetness
        });
      }
    }

    this.audio.update(dt);
  }

  _updateHud(dt) {
    this.hud.tickMessages(dt);
    this.hud.update(dt, {
      vehicle: this.playerVehicle,
      entry: this.playerEntry,
      director: this.session.director,
      standings: this.multiplayer && this.net ? this.net.standings : this.session.standings,
      track: this.track,
      cars: this._minimapCars,
      net: this.multiplayer && this.net ? this.net.quality : null
    });
  }

  // -------------------------------------------------------------------------
  //  Events
  // -------------------------------------------------------------------------

  _processEvents() {
    for (const ev of this.session.frameEvents) this._handleRaceEvent(ev, false);

    // Collision audio and camera shake, from the physics.
    for (const impact of this.session.impacts) {
      const involvesPlayer = impact.a === this.playerId || impact.b === this.playerId ||
                             impact.barrier;
      this.sounds.impact(impact.energy, impact.barrier ? 'barrier' :
        impact.wheelPair ? 'wheel' : 'car', 0);
      if (involvesPlayer && this.renderer.cameraRig) {
        this.renderer.cameraRig.addImpact(impact.energy);
      }
      if (impact.energy > 12000) {
        this.renderer.particles.emitDebris(
          impact.point.x, impact.point.y, impact.point.z,
          clamp01(impact.energy / 60000)
        );
      }
    }

    // Position changes are worth announcing.
    const pos = this.playerEntry?.position ?? 0;
    if (this._lastPosition && pos !== this._lastPosition) {
      if (pos < this._lastPosition) {
        this.sounds.positionGained();
        this.hud.message(`P${pos}`, 'good', 2);
      } else {
        this.sounds.positionLost();
        this.hud.message(`P${pos}`, 'warn', 2);
      }
    }
    this._lastPosition = pos;

    // Final lap.
    const d = this.session.director;
    if (!this._finalLapAnnounced && d.sessionType === SessionType.RACE &&
        this.playerEntry && this.playerEntry.lap === d.totalLaps - 1) {
      this._finalLapAnnounced = true;
      this.sounds.finalLap();
      this.hud.bigText('FINAL LAP', 2.2);
    }
  }

  _handleRaceEvent(ev, fromNetwork) {
    const isMe = ev.driver === this.playerId || ev.driver === undefined;
    switch (ev.type) {
      case 'light':
        this.sounds.startLight(ev.count);
        break;
      case 'lightsOut':
        this.sounds.lightsOut();
        this.hud.bigText('GO', 1.4);
        this.sounds.crowdCheer(0.8, 3);
        break;
      case 'lapComplete':
        if (isMe) {
          this.sounds.lapComplete(ev.personalBest);
          if (ev.personalBest) this.hud.message(`Personal best ${formatLapTime(ev.lapTime)}`, 'good');
        }
        if (ev.fastestLap) {
          this.sounds.fastestLap();
          this.hud.message(`Fastest lap — ${ev.name} ${formatLapTime(ev.lapTime)}`, 'info', 4);
        }
        break;
      case 'penalty':
        if (isMe) {
          this.sounds.penalty();
          this.hud.message(`${ev.penalty.reason} +${ev.penalty.seconds}s`, 'bad', 4);
        }
        break;
      case 'trackLimits':
        if (isMe) {
          this.sounds.warning();
          this.hud.message(`Track limits — warning ${ev.warnings}`, 'warn', 3);
        }
        break;
      case 'jumpStart':
        if (isMe) this.hud.message('Jump start', 'bad', 4);
        break;
      case 'pitStopStart':
        if (isMe) this.sounds.wheelGun(Math.min(ev.duration, 3));
        break;
      case 'pitStopEnd':
        if (isMe) {
          this.sounds.pitExit();
          this.hud.message(`${getCompound(ev.compound).name} fitted`, 'good', 3);
        }
        break;
      case 'checkered':
        this.sounds.chequeredFlag();
        this.hud.bigText('CHEQUERED FLAG', 2.5);
        break;
      case 'finish':
        if (ev.driver === this.playerId) {
          this.sounds.raceFinished(ev.position);
          this.hud.bigText(`P${ev.position}`, 3);
          this.spectating = true;
          this.renderer.cameraRig?.setMode(CameraMode.TV);
        }
        break;
      case 'weatherChange':
        this.hud.message(`Weather: ${ev.name}`, 'info', 4);
        break;
      case 'puncture':
        if (isMe) this.hud.message('Puncture', 'bad', 4);
        break;
      case 'damage':
        if (isMe && ev.energy > 8000) this.hud.message('Damage', 'bad', 2.5);
        break;
      case 'recovery':
        if (ev.driver === this.playerId) this.hud.message('Recovered', 'warn', 2);
        break;
      case 'retirement':
        this.hud.message(`${ev.name} retires`, 'warn', 3);
        break;
      case 'sessionFinished':
        if (!this.multiplayer) this._showResults({ classification: ev.classification });
        break;
      default: break;
    }
  }

  _showResults(data) {
    const d = this.session?.director;
    this.hud.hide();
    this.screens.show('results', {
      classification: data.classification || d?.classification() || [],
      selfId: this.playerId,
      sessionType: d?.sessionType,
      fastestLap: data.fastestLap ?? d?.records.fastestLap,
      fastestLapDriver: data.fastestLapDriver ?? d?.records.fastestLapDriver,
      theoreticalBest: data.theoreticalBest ?? d?.records.theoreticalBest,
      multiplayer: this.multiplayer
    });
  }

  // -------------------------------------------------------------------------
  //  Lifecycle
  // -------------------------------------------------------------------------

  pause() {
    if (this.multiplayer) return;   // a live race cannot be paused
    this.paused = true;
    this.screens.show('pause');
    this.audio.suspend();
  }

  resume() {
    this.paused = false;
    this.screens.hide();
    this.audio.resume();
    this.input.reset();
  }

  quitToMenu() {
    this._disposeSession();
    this._closeMultiplayer();
    this.hud.hide();
    this.paused = false;
    this.screens.show('menu');
  }

  _disposeSession() {
    this.session = null;
    this.playerVehicle = null;
    this.playerEntry = null;
    this.spectating = false;
    this._lastPosition = 0;
    this.renderer.clearCars();
    this.audio.clearCars();
  }
}

// ---------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  try {
    window.__apex = new Game();
  } catch (err) {
    console.error(err);
    document.body.innerHTML =
      `<div style="padding:40px;font-family:system-ui;color:#eee;background:#08090c;height:100%">
        <h1 style="color:#e8323c">Apex Circuit could not start</h1>
        <p style="margin-top:12px;color:#9aa3b0">${String(err.message || err)}</p>
        <p style="margin-top:12px;color:#626b78">This game needs WebGL 2.</p>
      </div>`;
  }
});
