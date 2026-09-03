import { Vec3 } from '../src/math/Vec3.js';
import { Quat } from '../src/math/Quat.js';
import { RaceSession, PHYSICS_DT } from '../src/race/RaceSession.js';
import { RacePhase, SessionType, DriverStatus } from '../src/race/RaceDirector.js';
import { CARS } from '../src/cars/carDefs.js';
import { MsgType, SNAPSHOT_RATE, validateCarState } from '../src/net/protocol.js';
import { makeRng } from '../src/math/MathUtils.js';

const AI_NAMES = [
  'Rossi', 'Vance', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Kowalski',
  'Ferreira', 'Duval', 'Nakamura', 'Hartmann', 'Silva', 'Bergman', 'Aziz',
  'Novak', 'Kaminski', 'Ravel', 'Costa', 'Halvorsen'
];

/**
 * ============================================================================
 *  RACE ROOM — the authoritative session
 * ============================================================================
 *
 * Runs a RaceSession at a fixed rate and broadcasts snapshots.
 *
 * The division of labour is deliberate:
 *   - AI cars are simulated HERE, with the full physics. There is no separate
 *     cheaper model for them.
 *   - Player cars are simulated on their own clients for input responsiveness.
 *     The server holds a vehicle for each so the AI has something to race
 *     against and so collisions and wakes resolve, and drives it from the
 *     client's reported state.
 *   - The race director runs here and only here. Lap counts, positions,
 *     penalties and the finishing order are the server's alone.
 */
export class RaceRoom {
  constructor(lobby, members, io) {
    this.lobby = lobby;
    this.io = io;
    this.settings = lobby.settings;
    this.players = new Map();  // clientId -> { client, entryId }
    this.running = false;
    this.seed = (Date.now() ^ 0x9e3779b9) >>> 0;

    const s = this.settings;
    this.session = new RaceSession({
      sessionType: s.sessionType,
      totalLaps: s.laps,
      weather: s.weather,
      dynamicWeather: s.dynamicWeather,
      collisions: s.collisions,
      damage: s.damage,
      tireWearScale: s.tireWearScale,
      rules: s.rules,
      seed: this.seed
    });

    this._buildGrid(members);

    this._accum = 0;
    this._snapshotAccum = 0;
    this._lastTime = 0;
    this._scratchVec = new Vec3();
    this._scratchQuat = new Quat();
  }

  /**
   * Build the grid. Human players are placed first, then the AI field fills in
   * behind them up to the requested count.
   */
  _buildGrid(members) {
    const rng = makeRng(this.seed);
    let grid = 1;

    for (const client of members) {
      const entry = this.session.addDriver({
        id: client.id,
        name: client.name,
        shortName: client.name.slice(0, 3),
        carId: client.carId,
        setup: client.setup,
        isPlayer: false,
        isRemote: true,     // driven by a client, not by the server's AI
        assists: this.settings.assists,
        gridPosition: grid++
      });
      this.players.set(client.id, { client, entryId: entry.id });
    }

    const aiCount = Math.min(
      this.settings.aiCount,
      Math.max(0, 20 - members.length)
    );
    for (let i = 0; i < aiCount; i++) {
      const name = AI_NAMES[i % AI_NAMES.length];
      this.session.addDriver({
        id: `ai-${i}`,
        name,
        shortName: name.slice(0, 3),
        carId: CARS[i % CARS.length].id,
        isAI: true,
        skill: this.settings.aiSkill,
        gridPosition: grid++,
        colour: CARS[i % CARS.length].colour
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Tell every client what they are about to race in.
    this.io.broadcast(MsgType.RACE_INIT, {
      seed: this.seed,
      settings: this.settings,
      trackId: this.settings.trackId,
      drivers: this.session.director.drivers.map((e) => ({
        id: e.id, name: e.name, shortName: e.shortName, number: e.number,
        team: e.team, colour: e.colour, carId: e.vehicle.car.id,
        isAI: e.isAI, gridPosition: e.gridPosition
      }))
    });

    if (this.settings.sessionType === SessionType.RACE) {
      // A short hold so clients can finish loading before the lights start.
      setTimeout(() => { if (this.running) this.session.startRace(2.0); }, 2500);
    } else {
      this.session.startSession();
    }

    this._lastTime = Date.now();
    // 60 Hz server loop; the session subdivides to its own 240 Hz physics step.
    this._interval = setInterval(() => this._tick(), 1000 / 60);
  }

  stop() {
    this.running = false;
    clearInterval(this._interval);
  }

  removePlayer(clientId) {
    const p = this.players.get(clientId);
    if (!p) return;
    const entry = this.session.getEntry(p.entryId);
    if (entry) {
      // Leave the car on track but parked and out of the way, rather than
      // deleting it mid-race and disturbing everyone's positions.
      entry.status = DriverStatus.RETIRED;
      if (entry.vehicle) {
        entry.vehicle.retired = true;
        entry.vehicle.controls.throttle = 0;
        entry.vehicle.controls.brake = 1;
      }
    }
    this.players.delete(clientId);
    this.io.broadcast(MsgType.RACE_EVENT, {
      events: [{ type: 'disconnected', driver: clientId }]
    });
  }

  _tick() {
    if (!this.running) return;
    const now = Date.now();
    const frameTime = Math.min((now - this._lastTime) / 1000, 0.25);
    this._lastTime = now;

    this.session.update(frameTime);

    // Broadcast events as they happen — these are the things clients cannot
    // work out for themselves.
    if (this.session.frameEvents.length) {
      const events = this.session.frameEvents.filter((e) => NETWORK_EVENTS.has(e.type));
      if (events.length) this.io.broadcast(MsgType.RACE_EVENT, { events });
    }

    this._snapshotAccum += frameTime;
    if (this._snapshotAccum >= 1 / SNAPSHOT_RATE) {
      this._snapshotAccum = 0;
      this._sendSnapshot();
    }

    if (this.session.phase === RacePhase.FINISHED && !this._finished) {
      this._finished = true;
      this.io.broadcast(MsgType.RESULTS, {
        classification: this.session.classification,
        fastestLap: this.session.director.records.fastestLap,
        fastestLapDriver: this.session.director.records.fastestLapDriver,
        theoreticalBest: this.session.director.records.theoreticalBest
      });
      this.io.onFinished();
      // Keep the room alive briefly so late joiners see the results.
      setTimeout(() => this.stop(), 60000);
    }
  }

  _sendSnapshot() {
    const snap = this.session.serialize();
    snap.st = Date.now();
    const payload = { ...snap, standings: this.session.standings };
    this.io.broadcast(MsgType.SNAPSHOT, payload);
  }

  /**
   * Apply a client's report of its own car.
   *
   * The state is checked for plausibility first. A rejected update simply does
   * not move the server's copy of that car — which means a client that lies or
   * glitches falls behind in the server's race state rather than corrupting it.
   */
  handleClientMessage(client, type, data) {
    const p = this.players.get(client.id);
    if (!p) return;
    const entry = this.session.getEntry(p.entryId);
    if (!entry || !entry.vehicle) return;

    if (type === MsgType.CAR_STATE) {
      const state = data.s;
      const dt = (data.t ?? 0) - (p.lastStateTime ?? 0);
      if (!validateCarState(state, p.lastState, dt)) {
        p.rejected = (p.rejected || 0) + 1;
        return;
      }
      p.lastState = state;
      p.lastStateTime = data.t ?? 0;

      const v = entry.vehicle;
      v.body.position.set(state.p[0], state.p[1], state.p[2]);
      v.body.orientation.set(state.q[0], state.q[1], state.q[2], state.q[3]).normalize();
      v.body.velocity.set(state.v[0], state.v[1], state.v[2]);
      if (state.w) v.body.angularVelocity.set(state.w[0], state.w[1], state.w[2]);
      v.body.updateDerived();
      // Cosmetic and telemetry state the server rebroadcasts to everyone else.
      v.steerAngle = state.st ?? 0;
      v.gear = state.g ?? 1;
      v.rpm = state.r ?? 0;
      v.drsActive = !!state.drs;
      if (state.ws) {
        for (let i = 0; i < 4; i++) v.wheels[i].angularVelocity = state.ws[i];
      }
      if (state.wc) {
        for (let i = 0; i < 4; i++) v.wheels[i].compression = state.wc[i];
      }
    } else if (type === MsgType.PIT_REQUEST) {
      this.session.director.requestPitStop(
        entry.id, data.compound, !!data.repair
      );
    } else if (type === MsgType.INPUT) {
      // Inputs are advisory on the server (the client owns its own physics),
      // but they let the server animate the car sensibly if state stops
      // arriving, and they feed the audio mix for spectators.
      const c = entry.vehicle.controls;
      c.throttle = clampUnit(data.th);
      c.brake = clampUnit(data.br);
      c.steer = Math.max(-1, Math.min(1, Number(data.st) || 0));
      c.drs = !!data.drs;
    }
  }
}

function clampUnit(v) {
  const n = Number(v) || 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Events worth the bandwidth of sending to every client. */
const NETWORK_EVENTS = new Set([
  'lightsOut', 'light', 'countdownStart', 'lapComplete', 'sector', 'fastestLap',
  'finish', 'checkered', 'sessionFinished', 'pitStop', 'penalty', 'trackLimits',
  'jumpStart', 'retirement', 'recovery', 'weatherChange', 'damage', 'puncture',
  'collision', 'dnf', 'pitEntry', 'pitExit'
]);
