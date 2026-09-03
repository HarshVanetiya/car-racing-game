/**
 * Networking tests.
 *
 * The server is authoritative, so the two things that matter here are that it
 * refuses states no car could have reached, and that the client turns a stream
 * of 20 Hz snapshots back into smooth motion.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  encode, decode, validateCarState, sanitiseSettings, sanitiseName,
  LOBBY_DEFAULTS, MsgType, PROTOCOL_VERSION
} from '../src/net/protocol.js';
import { RemoteCarState, ClockSync } from '../src/net/Interpolator.js';
import { normaliseServerUrl } from '../src/net/ClientNet.js';

const carState = (over = {}) => ({
  p: [0, 0.3, 0], q: [0, 0, 0, 1], v: [0, 0, 60], w: [0, 0, 0], ...over
});

describe('protocol', () => {
  test('messages survive a round trip and bad ones do not crash the parser', () => {
    const round = decode(encode(MsgType.INPUT, { throttle: 1, steer: -0.5 }));
    assert.equal(round.type, MsgType.INPUT);
    assert.equal(round.data.throttle, 1);

    assert.equal(decode('not json'), null);
    assert.equal(decode('{"nope":1}'), null);
    assert.equal(decode('null'), null);
    // A message with no payload still decodes, with an empty body.
    assert.deepEqual(decode(encode(MsgType.PING, undefined)).data, {});
    assert.ok(PROTOCOL_VERSION >= 1);
  });

  test('a plausible car state is accepted', () => {
    assert.equal(validateCarState(carState()), true);
    const previous = carState();
    const moved = carState({ p: [0, 0.3, 3] });         // 3 m in 50 ms at 60 m/s
    assert.equal(validateCarState(moved, previous, 0.05), true);
  });

  test('teleports, impossible speeds and NaNs are rejected', () => {
    const previous = carState();
    assert.equal(validateCarState(carState({ p: [0, 0.3, 4000] }), previous, 0.05), false,
      'a 4 km jump should be refused');
    assert.equal(validateCarState(carState({ v: [0, 0, 900] }), previous, 0.05), false,
      'a 900 m/s car should be refused');
    assert.equal(validateCarState(carState({ p: [NaN, 0, 0] })), false, 'NaN position');
    assert.equal(validateCarState(carState({ q: [0, 0, Infinity, 1] })), false, 'infinite rotation');
    assert.equal(validateCarState(carState({ p: [0, 0] })), false, 'a short vector');
    assert.equal(validateCarState(carState({ v: 'fast' })), false, 'a non-vector velocity');
    assert.equal(validateCarState(null), false);
    assert.equal(validateCarState({}), false);
  });

  test('a big accident is still allowed through', () => {
    // A car thrown sideways by a heavy impact must not be mistaken for a cheat.
    const previous = carState();
    const launched = carState({ p: [6, 1.4, 8], v: [30, 6, 40] });
    assert.equal(validateCarState(launched, previous, 0.05), true);
  });

  test('lobby settings from a client are clamped to sane ranges', () => {
    const s = sanitiseSettings({
      laps: 9999, aiCount: -5, maxPlayers: 400, tireWearScale: 1e6,
      weather: 'meteors', sessionType: 'demolition', aiSkill: 'godlike',
      name: 'x'.repeat(200)
    });
    assert.ok(s.laps <= 50 && s.laps >= 1);
    assert.ok(s.aiCount >= 0 && s.aiCount <= 19);
    assert.ok(s.maxPlayers <= 20);
    assert.ok(s.tireWearScale <= 8);
    assert.equal(s.weather, 'dry');
    assert.equal(s.sessionType, 'race');
    assert.equal(s.aiSkill, 'pro');
    assert.ok(s.name.length <= 32);
    // Nested defaults survive a partial override.
    assert.deepEqual(sanitiseSettings({ rules: { drsEnabled: false } }).rules,
      { ...LOBBY_DEFAULTS.rules, drsEnabled: false });
  });

  test('driver names are cleaned up but not emptied', () => {
    assert.equal(sanitiseName('  Ada Lovelace  '), 'Ada Lovelace');
    assert.equal(sanitiseName('<script>alert(1)</script>'), 'scriptalert1script');
    assert.equal(sanitiseName(''), 'Driver');
    assert.equal(sanitiseName(null), 'Driver');
    assert.ok(sanitiseName('y'.repeat(100)).length <= 18);
  });
});

describe('snapshot interpolation', () => {
  const snap = (z, t) => ({ p: [0, 0.3, z], q: [0, 0, 0, 1], v: [0, 0, 40], w: [0, 0, 0], g: 5, r: 11000 });

  test('a car is rendered between the snapshots that bracket the moment', () => {
    const car = new RemoteCarState('a');
    for (let i = 0; i <= 10; i++) car.push(i * 0.05, snap(i * 2));   // 20 Hz, 2 m apart

    // Render 0.1 s in the past (the interpolation delay), midway between two.
    car.update(0.325, 1 / 60);
    assert.ok(car.position.z > 8 && car.position.z < 10,
      `interpolated to z=${car.position.z.toFixed(2)}, expected between 8 and 10`);
  });

  test('motion is smooth: no jumps between rendered frames', () => {
    const car = new RemoteCarState('a');
    for (let i = 0; i <= 40; i++) car.push(i * 0.05, snap(i * 2));

    let previous = null;
    let worst = 0;
    for (let t = 0.2; t < 1.6; t += 1 / 60) {
      car.update(t, 1 / 60);
      if (previous != null) worst = Math.max(worst, Math.abs(car.position.z - previous));
      previous = car.position.z;
    }
    // 40 m/s at 60 fps is 0.67 m per frame; anything much beyond that is a jump.
    assert.ok(worst < 1.2, `a frame moved the car ${worst.toFixed(2)} m`);
  });

  test('late snapshots are dropped rather than rewinding the car', () => {
    const car = new RemoteCarState('a');
    car.push(0.10, snap(4));
    car.push(0.15, snap(6));
    car.push(0.05, snap(2));                              // arrives late
    assert.equal(car.buffer.length, 2, 'the stale snapshot should be dropped');
    assert.equal(car.buffer[car.buffer.length - 1].p[2], 6);
  });

  test('a gap in the stream extrapolates briefly rather than freezing', () => {
    const car = new RemoteCarState('a');
    for (let i = 0; i <= 6; i++) car.push(i * 0.05, snap(i * 2));   // up to t=0.30, z=12

    car.update(0.40, 1 / 60);                             // just past the buffer
    const shortGap = car.position.z;
    assert.ok(shortGap >= 12, 'the car should keep moving through a short gap');

    car.update(3.0, 1 / 60);                              // a long dropout
    assert.ok(Number.isFinite(car.position.z), 'a long dropout must not produce NaN');
    assert.ok(car.position.z < 12 + 40 * 1.0,
      'extrapolation should be bounded, not run away');
  });

  test('cosmetic state comes across with the pose', () => {
    const car = new RemoteCarState('a');
    for (let i = 0; i <= 6; i++) {
      car.push(i * 0.05, { ...snap(i * 2), st: 0.2, th: 1, br: 0, drs: true, ws: [1, 1, 1, 1] });
    }
    car.update(0.25, 1 / 60);
    assert.equal(car.gear, 5);
    assert.ok(car.rpm > 0);
    assert.equal(car.drs, true);
    assert.ok(Math.abs(car.steerAngle - 0.2) < 0.05);
  });
});

describe('clock sync', () => {
  test('the offset is taken from the least-delayed sample', () => {
    const c = new ClockSync();
    assert.equal(c.synced, false);

    // Server clock is 5000 ms ahead. A clean sample and a jittery one.
    c.addSample(1000, 6020, 1040);        // rtt 40, offset ~5000
    c.addSample(2000, 7300, 2600);        // rtt 600, badly delayed
    assert.equal(c.synced, true);
    assert.equal(c.rtt, 40, 'the best sample should win');
    assert.ok(Math.abs(c.offset - 5000) < 30, `offset came out as ${c.offset}`);
  });

  test('nonsense round trips are ignored', () => {
    const c = new ClockSync();
    c.addSample(1000, 6020, 900);         // negative rtt
    c.addSample(1000, 6020, 9000);        // 8 s rtt
    assert.equal(c.synced, false, 'neither sample should have been accepted');
  });

  test('the clock reads in seconds on the server timebase', () => {
    const c = new ClockSync();
    c.addSample(1000, 6020, 1040);
    const t = c.now();
    assert.ok(Math.abs(t - (Date.now() + 5000) / 1000) < 0.2,
      'now() should report the server clock in seconds');
  });
});

describe('the configured race server address', () => {
  test('an https host becomes a secure socket address', () => {
    assert.equal(normaliseServerUrl('https://apex.onrender.com'),
                 'wss://apex.onrender.com/ws');
    assert.equal(normaliseServerUrl('https://apex.onrender.com/'),
                 'wss://apex.onrender.com/ws');
  });

  test('a bare host is assumed to be secure', () => {
    assert.equal(normaliseServerUrl('apex.onrender.com'), 'wss://apex.onrender.com/ws');
  });

  test('an address that already names the socket path is left alone', () => {
    assert.equal(normaliseServerUrl('wss://apex.onrender.com/ws'),
                 'wss://apex.onrender.com/ws');
  });

  test('a plain ws address is kept when the page is not secure', () => {
    // Without a `location`, nothing forces an upgrade.
    assert.equal(normaliseServerUrl('ws://192.168.1.20:8787'),
                 'ws://192.168.1.20:8787/ws');
  });

  test('a page served over https can only open a secure socket', () => {
    const original = globalThis.location;
    globalThis.location = { protocol: 'https:', host: 'example.github.io' };
    try {
      // An insecure address would be blocked by the browser, so it is upgraded
      // rather than left to fail at connect time.
      assert.equal(normaliseServerUrl('http://apex.onrender.com'),
                   'wss://apex.onrender.com/ws');
      assert.equal(normaliseServerUrl('ws://apex.onrender.com'),
                   'wss://apex.onrender.com/ws');
    } finally {
      if (original === undefined) delete globalThis.location;
      else globalThis.location = original;
    }
  });
});
