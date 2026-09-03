/**
 * ============================================================================
 *  NETWORK PROTOCOL
 * ============================================================================
 *
 * A compact JSON message protocol over a WebSocket.
 *
 * Authority model:
 *   - Each client simulates its OWN car locally, so steering and throttle have
 *     zero input latency. That is not negotiable for a driving game.
 *   - The server simulates AI cars, runs the race director, and is the sole
 *     authority on lap counts, positions, penalties and the finishing order.
 *   - Clients send their car's state; the server validates it for plausibility
 *     and rebroadcasts. Remote cars are interpolated from those snapshots.
 *
 * So a player always feels their own car immediately, while the RESULT of the
 * race is never something a client can decide for itself.
 */

export const PROTOCOL_VERSION = 1;

export const MsgType = {
  // client -> server
  HELLO: 'hello',
  JOIN_LOBBY: 'joinLobby',
  CREATE_LOBBY: 'createLobby',
  LEAVE_LOBBY: 'leaveLobby',
  SET_READY: 'ready',
  SET_CAR: 'car',
  SET_SETUP: 'setup',
  SET_SETTINGS: 'settings',
  START_RACE: 'startRace',
  INPUT: 'input',
  CAR_STATE: 'carState',
  PIT_REQUEST: 'pitRequest',
  CHAT: 'chat',
  PING: 'ping',
  RETURN_TO_LOBBY: 'returnToLobby',

  // server -> client
  WELCOME: 'welcome',
  LOBBY_LIST: 'lobbyList',
  LOBBY_STATE: 'lobbyState',
  RACE_INIT: 'raceInit',
  SNAPSHOT: 'snapshot',
  RACE_EVENT: 'raceEvent',
  RESULTS: 'results',
  PONG: 'pong',
  ERROR: 'error',
  KICK: 'kick'
};

/** Snapshots per second sent to each client. */
export const SNAPSHOT_RATE = 20;
/** Client car-state updates per second sent to the server. */
export const INPUT_RATE = 30;

export function encode(type, data) {
  return JSON.stringify({ t: type, d: data });
}

export function decode(raw) {
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m.t !== 'string') return null;
    return { type: m.t, data: m.d ?? {} };
  } catch {
    return null;
  }
}

/**
 * Plausibility checks on a client-reported car state.
 *
 * This is not anti-cheat in the strong sense — a determined client can always
 * lie about its own physics. What it does is stop a broken or malicious client
 * from corrupting everyone else's view of the race: teleports, impossible
 * speeds and NaNs are rejected, and the race director's own progress tracking
 * (which is what decides the result) uses only positions that passed here.
 */
export function validateCarState(state, previous, dt) {
  if (!state || !Array.isArray(state.p) || state.p.length !== 3) return false;
  for (const v of state.p) if (!Number.isFinite(v)) return false;
  if (!Array.isArray(state.q) || state.q.length !== 4) return false;
  for (const v of state.q) if (!Number.isFinite(v)) return false;
  if (!Array.isArray(state.v) || state.v.length !== 3) return false;

  const speed = Math.hypot(state.v[0], state.v[1], state.v[2]);
  // No car in this game can exceed ~110 m/s; allow headroom for a big impact.
  if (!Number.isFinite(speed) || speed > 160) return false;

  if (previous && dt > 0) {
    const dx = state.p[0] - previous.p[0];
    const dy = state.p[1] - previous.p[1];
    const dz = state.p[2] - previous.p[2];
    const moved = Math.hypot(dx, dy, dz);
    // Allow generous slack for latency spikes and collisions, but reject a
    // jump no continuous motion could produce.
    const maxMove = 160 * Math.max(dt, 0.05) + 12;
    if (moved > maxMove) return false;
  }
  return true;
}

/** Lobby settings a host can change, with their permitted ranges. */
export const LOBBY_DEFAULTS = {
  name: 'Race',
  trackId: 'apex-circuit',
  sessionType: 'race',
  laps: 8,
  aiCount: 6,
  aiSkill: 'pro',
  weather: 'dry',
  dynamicWeather: false,
  collisions: true,
  damage: true,
  tireWearScale: 2.5,
  fuelScale: 1,
  assists: {
    tractionControl: 0,
    abs: 0,
    stabilityControl: 0,
    steeringAssist: 0,
    automaticGears: true,
    autoPitLimiter: true,
    racingLine: true
  },
  rules: {
    trackLimits: true,
    jumpStart: true,
    pitSpeedLimit: true,
    drsEnabled: true,
    mandatoryPitStop: false
  },
  maxPlayers: 12,
  private: false
};

export function sanitiseSettings(input = {}) {
  const s = { ...LOBBY_DEFAULTS, ...input };
  s.name = String(s.name || 'Race').slice(0, 32);
  s.laps = Math.max(1, Math.min(50, Math.round(s.laps) || 8));
  s.aiCount = Math.max(0, Math.min(19, Math.round(s.aiCount) || 0));
  s.maxPlayers = Math.max(1, Math.min(20, Math.round(s.maxPlayers) || 12));
  s.tireWearScale = Math.max(0.25, Math.min(8, Number(s.tireWearScale) || 1));
  s.assists = { ...LOBBY_DEFAULTS.assists, ...(input.assists || {}) };
  s.rules = { ...LOBBY_DEFAULTS.rules, ...(input.rules || {}) };
  if (!['dry', 'lightRain', 'heavyRain'].includes(s.weather)) s.weather = 'dry';
  if (!['practice', 'qualifying', 'race', 'timeTrial'].includes(s.sessionType)) {
    s.sessionType = 'race';
  }
  if (!['rookie', 'amateur', 'pro', 'expert', 'legend'].includes(s.aiSkill)) {
    s.aiSkill = 'pro';
  }
  return s;
}

export function sanitiseName(name) {
  const n = String(name || '').replace(/[^\w \-.']/g, '').trim().slice(0, 18);
  return n || 'Driver';
}
