// End-to-end multiplayer test against the real server, using two clients.
import WebSocket from 'ws';
import { MsgType, encode, decode } from '../src/net/protocol.js';

function client(name) {
  const ws = new WebSocket('ws://localhost:8787/ws');
  const c = { name, ws, id:null, lobby:null, snapshots:0, events:[], results:null, raceInit:null, lastSnap:null };
  ws.on('open', () => ws.send(encode(MsgType.HELLO, { name })));
  ws.on('message', (raw) => {
    const m = decode(raw.toString());
    if (!m) return;
    if (m.type === MsgType.WELCOME) c.id = m.data.clientId;
    else if (m.type === MsgType.LOBBY_STATE) c.lobby = m.data;
    else if (m.type === MsgType.LOBBY_LIST) c.lobbies = m.data.lobbies;
    else if (m.type === MsgType.RACE_INIT) c.raceInit = m.data;
    else if (m.type === MsgType.SNAPSHOT) { c.snapshots++; c.lastSnap = m.data; }
    else if (m.type === MsgType.RACE_EVENT) c.events.push(...m.data.events);
    else if (m.type === MsgType.RESULTS) c.results = m.data;
    else if (m.type === MsgType.ERROR) console.log('  ERROR ['+name+']:', m.data.message);
  });
  return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const a = client('Alice'), b = client('Bob');
await sleep(400);
console.log('two clients connected:', !!a.id, !!b.id);

a.ws.send(encode(MsgType.CREATE_LOBBY, { settings: { name:'Test GP', laps:2, aiCount:3, aiSkill:'pro', tireWearScale:4 } }));
await sleep(300);
console.log('lobby created:', a.lobby.settings.name, '| host is Alice:', a.lobby.hostId===a.id);

await sleep(200);
const target = (b.lobbies||[])[0];
console.log('Bob sees', (b.lobbies||[]).length, 'lobby in the browser');
b.ws.send(encode(MsgType.JOIN_LOBBY, { lobbyId: target.id }));
await sleep(300);
console.log('players in lobby:', a.lobby.players.map(p=>p.name+(p.isHost?' (host)':'')).join(', '));

b.ws.send(encode(MsgType.SET_READY, { ready:true }));
b.ws.send(encode(MsgType.SET_CAR, { carId:'vector-ms' }));
await sleep(200);
console.log('Bob ready:', a.lobby.players.find(p=>p.name==='Bob').ready, '| car:', a.lobby.players.find(p=>p.name==='Bob').carId);

a.ws.send(encode(MsgType.START_RACE, {}));
await sleep(600);
console.log('race init received by both:', !!a.raceInit, !!b.raceInit, '| grid size', a.raceInit.drivers.length);
console.log('grid:', a.raceInit.drivers.map(d=>d.gridPosition+'.'+d.name).join('  '));

// Both clients drive their cars by reporting state, as the real client does.
let t=0;
const drive = (c) => {
  const me = c.raceInit.drivers.find(d=>d.id===c.id);
  if (!me) return;
  const base = c.lastSnap?.cars?.find(x=>x.id===c.id);
  if (!base?.s) return;
  const s = JSON.parse(JSON.stringify(base.s));
  // Move forward along the car's own heading at 40 m/s.
  const q=s.q, fx=2*(q[0]*q[2]+q[3]*q[1]), fz=1-2*(q[0]*q[0]+q[1]*q[1]);
  s.p[0]+=fx*40*0.05; s.p[2]+=fz*40*0.05;
  s.v=[fx*40,0,fz*40]; s.th=1; s.g=5; s.r=11000;
  c.ws.send(encode(MsgType.CAR_STATE, { t: Date.now()/1000, s }));
};
for (let i=0;i<160;i++){ drive(a); drive(b); await sleep(50); t+=0.05; }

console.log('\nsnapshots received: Alice', a.snapshots, '| Bob', b.snapshots, '(20/s expected)');
const notable = a.events.filter(e=>['lightsOut','lapComplete','fastestLap','finish','checkered'].includes(e.type));
console.log('race events seen:', notable.slice(0,8).map(e=>e.type+(e.name?':'+e.name:'')).join(', '));
console.log('standings from server:');
for (const s of (a.lastSnap?.standings||[]).slice(0,6)) console.log('   P'+s.position, s.name.padEnd(10), 'lap', s.lap, 'gap', s.gapToLeader.toFixed(2), s.speed.toFixed(0)+' km/h');
// Verify Bob's car appears in Alice's snapshot (remote car replication)
const bobInAlice = a.lastSnap?.cars?.find(c=>c.id===b.id);
console.log('\nBob visible in Alice snapshot:', !!bobInAlice, bobInAlice? '| pos '+bobInAlice.s.p.map(x=>x.toFixed(0)).join(','):'');
// Reject an implausible teleport
const bad = JSON.parse(JSON.stringify(bobInAlice.s)); bad.p[0]+=5000;
b.ws.send(encode(MsgType.CAR_STATE, { t: Date.now()/1000, s: bad }));
await sleep(300);
const after = a.lastSnap?.cars?.find(c=>c.id===b.id);
console.log('after a 5000 m teleport attempt, server position moved by:',
  Math.abs(after.s.p[0]-bobInAlice.s.p[0]).toFixed(1), 'm  (rejected if small)');
a.ws.close(); b.ws.close();
