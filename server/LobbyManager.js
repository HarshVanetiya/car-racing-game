import { randomUUID } from 'node:crypto';
import {
  MsgType, encode, decode, sanitiseSettings, sanitiseName, PROTOCOL_VERSION
} from '../src/net/protocol.js';
import { RaceRoom } from './RaceRoom.js';

/**
 * Connection and lobby management.
 *
 * A client connects, says hello, and then either creates a lobby or joins one.
 * When the host starts, the lobby hands its roster to a RaceRoom which owns the
 * authoritative simulation from then on.
 */
export class LobbyManager {
  constructor() {
    this.clients = new Map();   // clientId -> client
    this.lobbies = new Map();   // lobbyId  -> lobby
    this.rooms = new Map();     // lobbyId  -> RaceRoom
    this._tick = setInterval(() => this._housekeeping(), 5000);
  }

  health() {
    return {
      ok: true,
      protocol: PROTOCOL_VERSION,
      clients: this.clients.size,
      lobbies: this.lobbies.size,
      races: this.rooms.size,
      uptime: Math.round(process.uptime())
    };
  }

  handleConnection(socket, req) {
    const id = randomUUID();
    const client = {
      id,
      socket,
      name: 'Driver',
      lobbyId: null,
      ready: false,
      carId: 'apex-gp',
      setup: null,
      alive: true,
      lastSeen: Date.now(),
      latency: 0,
      ip: req?.socket?.remoteAddress || ''
    };
    this.clients.set(id, client);

    socket.on('message', (raw) => {
      client.lastSeen = Date.now();
      // Guard against oversized frames before parsing.
      if (raw.length > 64 * 1024) return;
      const msg = decode(raw.toString());
      if (!msg) return;
      try {
        this._handleMessage(client, msg);
      } catch (err) {
        console.error('[apex] message error', msg.type, err.message);
      }
    });

    socket.on('close', () => this._disconnect(client));
    socket.on('error', () => this._disconnect(client));

    this._send(client, MsgType.WELCOME, {
      clientId: id,
      protocol: PROTOCOL_VERSION,
      lobbies: this._lobbyList()
    });
  }

  _handleMessage(client, msg) {
    const { type, data } = msg;
    switch (type) {
      case MsgType.HELLO:
        client.name = sanitiseName(data.name);
        this._send(client, MsgType.LOBBY_LIST, { lobbies: this._lobbyList() });
        break;

      case MsgType.CREATE_LOBBY: {
        this._leaveLobby(client);
        const settings = sanitiseSettings(data.settings);
        const lobby = {
          id: randomUUID().slice(0, 8),
          hostId: client.id,
          settings,
          members: new Set([client.id]),
          created: Date.now(),
          state: 'lobby'
        };
        this.lobbies.set(lobby.id, lobby);
        client.lobbyId = lobby.id;
        client.ready = false;
        this._broadcastLobby(lobby);
        this._broadcastLobbyList();
        break;
      }

      case MsgType.JOIN_LOBBY: {
        const lobby = this.lobbies.get(data.lobbyId);
        if (!lobby) { this._send(client, MsgType.ERROR, { message: 'Lobby not found' }); break; }
        if (lobby.state !== 'lobby') {
          this._send(client, MsgType.ERROR, { message: 'Race already started' }); break;
        }
        if (lobby.members.size >= lobby.settings.maxPlayers) {
          this._send(client, MsgType.ERROR, { message: 'Lobby full' }); break;
        }
        this._leaveLobby(client);
        lobby.members.add(client.id);
        client.lobbyId = lobby.id;
        client.ready = false;
        this._broadcastLobby(lobby);
        this._broadcastLobbyList();
        break;
      }

      case MsgType.LEAVE_LOBBY:
        this._leaveLobby(client);
        this._send(client, MsgType.LOBBY_LIST, { lobbies: this._lobbyList() });
        break;

      case MsgType.SET_READY: {
        client.ready = !!data.ready;
        const lobby = this.lobbies.get(client.lobbyId);
        if (lobby) this._broadcastLobby(lobby);
        break;
      }

      case MsgType.SET_CAR: {
        client.carId = String(data.carId || 'apex-gp');
        if (data.setup) client.setup = data.setup;
        const lobby = this.lobbies.get(client.lobbyId);
        if (lobby) this._broadcastLobby(lobby);
        break;
      }

      case MsgType.SET_SETUP:
        client.setup = data.setup || null;
        break;

      case MsgType.SET_SETTINGS: {
        const lobby = this.lobbies.get(client.lobbyId);
        if (!lobby || lobby.hostId !== client.id) break;
        lobby.settings = sanitiseSettings({ ...lobby.settings, ...data.settings });
        this._broadcastLobby(lobby);
        this._broadcastLobbyList();
        break;
      }

      case MsgType.START_RACE: {
        const lobby = this.lobbies.get(client.lobbyId);
        if (!lobby || lobby.hostId !== client.id) break;
        if (lobby.state !== 'lobby') break;
        this._startRace(lobby);
        break;
      }

      case MsgType.RETURN_TO_LOBBY: {
        const room = this.rooms.get(client.lobbyId);
        const lobby = this.lobbies.get(client.lobbyId);
        if (!lobby) break;
        if (lobby.hostId === client.id && room) {
          room.stop();
          this.rooms.delete(lobby.id);
          lobby.state = 'lobby';
          for (const mid of lobby.members) {
            const c = this.clients.get(mid);
            if (c) c.ready = false;
          }
          this._broadcastLobby(lobby);
          this._broadcastLobbyList();
        }
        break;
      }

      case MsgType.CAR_STATE:
      case MsgType.INPUT:
      case MsgType.PIT_REQUEST: {
        const room = this.rooms.get(client.lobbyId);
        if (room) room.handleClientMessage(client, type, data);
        break;
      }

      case MsgType.CHAT: {
        const lobby = this.lobbies.get(client.lobbyId);
        if (!lobby) break;
        const text = String(data.text || '').slice(0, 200);
        if (!text) break;
        this._broadcastToLobby(lobby, MsgType.CHAT, {
          from: client.name, text, time: Date.now()
        });
        break;
      }

      case MsgType.PING:
        this._send(client, MsgType.PONG, { t: data.t, server: Date.now() });
        break;

      default:
        break;
    }
  }

  _startRace(lobby) {
    lobby.state = 'racing';
    const members = [...lobby.members]
      .map((id) => this.clients.get(id))
      .filter(Boolean);

    const room = new RaceRoom(lobby, members, {
      send: (client, type, data) => this._send(client, type, data),
      broadcast: (type, data) => this._broadcastToLobby(lobby, type, data),
      onFinished: () => {
        lobby.state = 'results';
        this._broadcastLobby(lobby);
      }
    });
    this.rooms.set(lobby.id, room);
    room.start();
    this._broadcastLobbyList();
  }

  _leaveLobby(client) {
    const lobby = this.lobbies.get(client.lobbyId);
    client.lobbyId = null;
    client.ready = false;
    if (!lobby) return;

    lobby.members.delete(client.id);
    const room = this.rooms.get(lobby.id);
    if (room) room.removePlayer(client.id);

    if (lobby.members.size === 0) {
      if (room) { room.stop(); this.rooms.delete(lobby.id); }
      this.lobbies.delete(lobby.id);
    } else if (lobby.hostId === client.id) {
      // Hand the lobby to whoever has been there longest.
      lobby.hostId = [...lobby.members][0];
      this._broadcastLobby(lobby);
    } else {
      this._broadcastLobby(lobby);
    }
    this._broadcastLobbyList();
  }

  _disconnect(client) {
    if (!this.clients.has(client.id)) return;
    this._leaveLobby(client);
    this.clients.delete(client.id);
  }

  _lobbyList() {
    return [...this.lobbies.values()]
      .filter((l) => !l.settings.private)
      .map((l) => ({
        id: l.id,
        name: l.settings.name,
        players: l.members.size,
        maxPlayers: l.settings.maxPlayers,
        track: l.settings.trackId,
        laps: l.settings.laps,
        sessionType: l.settings.sessionType,
        weather: l.settings.weather,
        state: l.state
      }));
  }

  _lobbyState(lobby) {
    return {
      id: lobby.id,
      hostId: lobby.hostId,
      settings: lobby.settings,
      state: lobby.state,
      players: [...lobby.members].map((id) => {
        const c = this.clients.get(id);
        return c ? {
          id: c.id, name: c.name, ready: c.ready,
          carId: c.carId, isHost: id === lobby.hostId, latency: c.latency
        } : null;
      }).filter(Boolean)
    };
  }

  _broadcastLobby(lobby) {
    this._broadcastToLobby(lobby, MsgType.LOBBY_STATE, this._lobbyState(lobby));
  }

  _broadcastLobbyList() {
    const list = this._lobbyList();
    for (const c of this.clients.values()) {
      if (!c.lobbyId) this._send(c, MsgType.LOBBY_LIST, { lobbies: list });
    }
  }

  _broadcastToLobby(lobby, type, data) {
    const payload = encode(type, data);
    for (const id of lobby.members) {
      const c = this.clients.get(id);
      if (c && c.socket.readyState === 1) c.socket.send(payload);
    }
  }

  _send(client, type, data) {
    if (client.socket.readyState === 1) client.socket.send(encode(type, data));
  }

  _housekeeping() {
    const now = Date.now();
    for (const c of [...this.clients.values()]) {
      // Drop connections that have gone quiet for a long time.
      if (now - c.lastSeen > 60000) {
        try { c.socket.terminate(); } catch { /* already gone */ }
        this._disconnect(c);
      }
    }
    // Reap empty lobbies whose members all vanished.
    for (const [id, lobby] of [...this.lobbies]) {
      if (lobby.members.size === 0) {
        const room = this.rooms.get(id);
        if (room) { room.stop(); this.rooms.delete(id); }
        this.lobbies.delete(id);
      }
    }
  }

  shutdown() {
    clearInterval(this._tick);
    for (const room of this.rooms.values()) room.stop();
  }
}
