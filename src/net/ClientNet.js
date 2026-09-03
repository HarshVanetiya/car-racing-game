import {
  MsgType, encode, decode, INPUT_RATE, PROTOCOL_VERSION
} from './protocol.js';
import { RemoteCarState, ClockSync } from './Interpolator.js';

/**
 * Client side of the multiplayer connection.
 *
 * Owns the socket, the clock sync, and the interpolated state of every remote
 * car. The game asks it for `remoteCars` each frame and renders them; it never
 * has to think about packets.
 *
 * Reconnection is automatic and backs off, because a brief network drop in the
 * middle of a race should not end the session.
 */
export class ClientNet extends EventTarget {
  constructor(url) {
    super();
    this.url = url || defaultUrl();
    this.socket = null;
    this.clientId = null;
    this.connected = false;
    this.clock = new ClockSync();

    this.lobbies = [];
    this.lobby = null;
    this.raceInit = null;
    this.remoteCars = new Map();   // driverId -> RemoteCarState
    this.standings = [];
    this.raceState = null;
    this.weatherState = null;
    this.results = null;

    this.latency = 0;
    this.packetLoss = 0;
    this._snapshotsReceived = 0;
    this._lastSnapshotAt = 0;
    this._inputAccum = 0;
    this._pingAccum = 0;
    this._reconnectDelay = 500;
    this._deliberateClose = false;
    this._localId = null;
  }

  // -------------------------------------------------------------------------
  //  Connection
  // -------------------------------------------------------------------------

  connect(playerName) {
    this._deliberateClose = false;
    this.playerName = playerName || this.playerName || 'Driver';
    try {
      this.socket = new WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }

    this.socket.addEventListener('open', () => {
      this.connected = true;
      this._reconnectDelay = 500;
      this._send(MsgType.HELLO, { name: this.playerName, protocol: PROTOCOL_VERSION });
      this._emit('connected', {});
    });

    this.socket.addEventListener('message', (ev) => this._onMessage(ev.data));

    this.socket.addEventListener('close', () => {
      this.connected = false;
      this._emit('disconnected', {});
      if (!this._deliberateClose) this._scheduleReconnect();
    });

    this.socket.addEventListener('error', () => {
      // `close` follows; handled there.
    });
  }

  disconnect() {
    this._deliberateClose = true;
    if (this.socket) this.socket.close();
    this.connected = false;
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._emit('reconnecting', { delay: this._reconnectDelay });
      this.connect(this.playerName);
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 1.8, 15000);
  }

  // -------------------------------------------------------------------------
  //  Outbound
  // -------------------------------------------------------------------------

  _send(type, data) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(encode(type, data));
    return true;
  }

  createLobby(settings) { this._send(MsgType.CREATE_LOBBY, { settings }); }
  joinLobby(lobbyId) { this._send(MsgType.JOIN_LOBBY, { lobbyId }); }
  leaveLobby() { this._send(MsgType.LEAVE_LOBBY, {}); }
  setReady(ready) { this._send(MsgType.SET_READY, { ready }); }
  setCar(carId, setup) { this._send(MsgType.SET_CAR, { carId, setup }); }
  setSettings(settings) { this._send(MsgType.SET_SETTINGS, { settings }); }
  startRace() { this._send(MsgType.START_RACE, {}); }
  returnToLobby() { this._send(MsgType.RETURN_TO_LOBBY, {}); }
  chat(text) { this._send(MsgType.CHAT, { text }); }
  requestPit(compound, repair) {
    this._send(MsgType.PIT_REQUEST, { compound, repair });
  }

  /**
   * Called every frame with the local car. Sends state at a fixed rate and
   * keeps the clock synchronised.
   */
  update(dt, localVehicle) {
    if (!this.connected) return;

    this._pingAccum += dt;
    if (this._pingAccum >= 1.0) {
      this._pingAccum = 0;
      this._send(MsgType.PING, { t: Date.now() });
    }

    if (!localVehicle) return;
    this._inputAccum += dt;
    if (this._inputAccum >= 1 / INPUT_RATE) {
      this._inputAccum = 0;
      this._send(MsgType.CAR_STATE, {
        t: this.clock.now(),
        s: localVehicle.serializeState()
      });
    }
  }

  /** Advance every remote car to the current render time. */
  interpolate(dt) {
    const renderTime = this.clock.now();
    for (const car of this.remoteCars.values()) car.update(renderTime, dt);
  }

  // -------------------------------------------------------------------------
  //  Inbound
  // -------------------------------------------------------------------------

  _onMessage(raw) {
    const msg = decode(raw);
    if (!msg) return;
    const { type, data } = msg;

    switch (type) {
      case MsgType.WELCOME:
        this.clientId = data.clientId;
        this._localId = data.clientId;
        this.lobbies = data.lobbies || [];
        this._emit('welcome', data);
        this._emit('lobbyList', { lobbies: this.lobbies });
        break;

      case MsgType.LOBBY_LIST:
        this.lobbies = data.lobbies || [];
        this._emit('lobbyList', data);
        break;

      case MsgType.LOBBY_STATE:
        this.lobby = data;
        this._emit('lobbyState', data);
        break;

      case MsgType.RACE_INIT:
        this.raceInit = data;
        this.remoteCars.clear();
        this.results = null;
        for (const d of data.drivers || []) {
          if (d.id !== this.clientId) {
            this.remoteCars.set(d.id, new RemoteCarState(d.id));
          }
        }
        this._emit('raceInit', data);
        break;

      case MsgType.SNAPSHOT: {
        this._snapshotsReceived++;
        this._lastSnapshotAt = Date.now();
        this.raceState = data.race;
        this.weatherState = data.weather;
        this.standings = data.standings || [];
        // Server timestamps are already on the shared clock.
        const t = data.t;
        for (const car of data.cars || []) {
          if (car.id === this.clientId) {
            // Our own car: the server's copy is authoritative for RACE state
            // (lap, position, penalties) but never for where the car is — that
            // is simulated locally so the controls feel immediate.
            this._emit('ownRaceState', car);
            continue;
          }
          const remote = this.remoteCars.get(car.id);
          if (remote && car.s) remote.push(t, car.s);
          if (remote) {
            remote.lap = car.lap;
            remote.position = car.pos;
            remote.status = car.st;
            remote.compound = car.tyre?.c;
            remote.tireWear = car.tyre?.w ?? 0;
            remote.damage = car.dmg;
            remote.name = this.raceInit?.drivers?.find((d) => d.id === car.id)?.name;
          }
        }
        this._emit('snapshot', data);
        break;
      }

      case MsgType.RACE_EVENT:
        this._emit('raceEvents', data);
        break;

      case MsgType.RESULTS:
        this.results = data;
        this._emit('results', data);
        break;

      case MsgType.PONG: {
        const now = Date.now();
        this.clock.addSample(data.t, data.server, now);
        this.latency = this.clock.rtt;
        break;
      }

      case MsgType.CHAT:
        this._emit('chat', data);
        break;

      case MsgType.ERROR:
        this._emit('error', data);
        break;

      case MsgType.KICK:
        this._emit('kicked', data);
        this.disconnect();
        break;

      default:
        break;
    }
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /** Connection quality summary for the HUD. */
  get quality() {
    const age = (Date.now() - this._lastSnapshotAt) / 1000;
    return {
      latency: Math.round(this.latency),
      connected: this.connected,
      snapshotAge: age,
      degraded: age > 0.5,
      lost: age > 2.0
    };
  }
}

function defaultUrl() {
  if (typeof location === 'undefined') return 'ws://localhost:8787/ws';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
