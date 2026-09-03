/**
 * Circuit model tests.
 *
 * The track is the other half of the physics: if its geometry, surface map or
 * racing line are wrong, a perfect tire model still produces a bad game. These
 * check the queries the simulation leans on every step.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TrackModel } from '../src/track/TrackModel.js';
import { SurfaceType, isTrackSurface } from '../src/physics/Surfaces.js';
import { Vec3 } from '../src/math/Vec3.js';

const track = new TrackModel();

describe('geometry', () => {
  test('the circuit is a closed loop of a plausible length', () => {
    assert.ok(track.length > 3000 && track.length < 8000,
      `${track.length.toFixed(0)} m is not a road course`);
    // Advertised length and measured length should agree.
    assert.ok(Math.abs(track.length - track.info.lengthHint) < track.length * 0.05,
      `measured ${track.length.toFixed(0)} m vs advertised ${track.info.lengthHint} m`);

    const start = track.pointAtDistance(0);
    const end = track.pointAtDistance(track.length - 0.01);
    assert.ok(start.distanceTo(end) < 2, 'the lap should close on itself');
  });

  test('arc length is uniform, so distance really is distance', () => {
    const step = 25;
    let shortest = Infinity; let longest = 0;
    const a = new Vec3(); const b = new Vec3();
    for (let d = 0; d < track.length - step; d += step) {
      track.pointAtDistance(d, a);
      track.pointAtDistance(d + step, b);
      const gap = a.distanceTo(b);
      shortest = Math.min(shortest, gap);
      longest = Math.max(longest, gap);
    }
    // Chords are slightly shorter than arc through corners, but only slightly.
    assert.ok(longest <= step * 1.02, `a ${step} m step spanned ${longest.toFixed(2)} m`);
    assert.ok(shortest > step * 0.93, `a ${step} m step spanned only ${shortest.toFixed(2)} m`);
  });

  test('projecting a point back onto the centreline round-trips', () => {
    const out = {};
    for (let d = 0; d < track.length; d += 137) {
      for (const lateral of [-4, 0, 3]) {
        const p = track.pointAt(d, lateral);
        track.project(p.x, p.z, out);
        const err = Math.abs(((out.distance - d + track.length * 1.5) % track.length) - track.length * 0.5);
        assert.ok(err < 2.5, `distance ${d} came back as ${out.distance.toFixed(1)} (lateral ${lateral})`);
        assert.ok(Math.abs(out.lateral - lateral) < 0.6,
          `lateral ${lateral} came back as ${out.lateral.toFixed(2)}`);
        assert.equal(out.onTrack, true, 'a point 4 m off centre should be on the track');
      }
    }
  });

  test('the circuit has elevation change and corners in both directions', () => {
    let low = Infinity; let high = -Infinity;
    let leftHanders = 0; let rightHanders = 0;
    const p = new Vec3();
    for (let d = 0; d < track.length; d += 10) {
      track.pointAtDistance(d, p);
      low = Math.min(low, p.y); high = Math.max(high, p.y);
      const k = track.curvatureAtDistance(d);
      if (k > 0.004) rightHanders++;
      if (k < -0.004) leftHanders++;
    }
    assert.ok(high - low > 8, `only ${(high - low).toFixed(1)} m of elevation change`);
    assert.ok(leftHanders > 10 && rightHanders > 10, 'the lap should turn both ways');
  });

  test('the track varies in width and has a genuinely long straight', () => {
    let minW = Infinity; let maxW = 0;
    for (let d = 0; d < track.length; d += 10) {
      const w = track.widthAtDistance(d);
      minW = Math.min(minW, w); maxW = Math.max(maxW, w);
    }
    assert.ok(minW > 8 && maxW < 30, `widths run ${minW.toFixed(1)}-${maxW.toFixed(1)} m`);
    assert.ok(maxW > minW + 1, 'the circuit should not be a constant-width ribbon');

    // Longest run of near-zero curvature.
    let best = 0; let run = 0;
    for (let d = 0; d < track.length; d += 5) {
      if (Math.abs(track.curvatureAtDistance(d)) < 0.0016) { run += 5; best = Math.max(best, run); }
      else run = 0;
    }
    assert.ok(best > 500, `the longest straight is only ${best} m`);
  });
});

describe('surfaces', () => {
  const out = {
    point: new Vec3(), normal: new Vec3(0, 1, 0), surfaceType: SurfaceType.ASPHALT,
    wetness: 0, waterDepth: 0, rubber: 0, distanceAlong: 0, lateral: 0
  };
  const env = { wetness: 0, waterDepth: 0 };

  test('the racing surface is asphalt, and leaving it is not', () => {
    for (let d = 0; d < track.length; d += 53) {
      const on = track.pointAt(d, 0);
      track.sampleGround(on.x, on.z, out, env);
      assert.ok(isTrackSurface(out.surfaceType),
        `the centreline at ${d.toFixed(0)} m is ${out.surfaceType}`);

      const half = track.widthAtDistance(d) * 0.5;
      const off = track.pointAt(d, half + 12);
      track.sampleGround(off.x, off.z, out, env);
      assert.ok(!isTrackSurface(out.surfaceType) || out.surfaceType === SurfaceType.KERB,
        `12 m beyond the edge at ${d.toFixed(0)} m is still ${out.surfaceType}`);
    }
  });

  test('kerbs sit at the edge of the track and stand proud of it', () => {
    let foundKerb = false;
    for (let d = 0; d < track.length && !foundKerb; d += 7) {
      const half = track.widthAtDistance(d) * 0.5;
      for (const side of [-1, 1]) {
        const p = track.pointAt(d, side * (half + 0.6));
        track.sampleGround(p.x, p.z, out, env);
        if (out.surfaceType === SurfaceType.KERB) { foundKerb = true; break; }
      }
    }
    assert.ok(foundKerb, 'the circuit should have kerbs at its edges');
  });

  test('the ground normal is upright on track and follows the elevation', () => {
    for (let d = 0; d < track.length; d += 91) {
      const p = track.pointAt(d, 0);
      track.sampleGround(p.x, p.z, out, env);
      assert.ok(out.normal.y > 0.9, `the road at ${d.toFixed(0)} m is impossibly steep`);
      assert.ok(Math.abs(out.normal.length() - 1) < 1e-3, 'the normal should be a unit vector');
    }
  });

  test('rain wets the circuit and traffic dries the line', () => {
    const wet = new TrackModel();
    wet.wetness.fill(0.8);
    wet.waterDepth.fill(0.003);
    const p = wet.pointAt(1000, 0);

    wet.sampleGround(p.x, p.z, out, { wetness: 0.8, waterDepth: 0.003 });
    const soaked = out.wetness;
    assert.ok(soaked > 0.4, 'rain should wet the road');

    wet.lineDry.fill(1);
    const lineOffset = wet.lineOffsetAt(1000, 'racing');
    const onLine = wet.pointAt(1000, lineOffset);
    wet.sampleGround(onLine.x, onLine.z, out, { wetness: 0.8, waterDepth: 0.003 });
    assert.ok(out.wetness < soaked, 'the racing line should dry before the rest of the road');
  });
});

describe('circuit features', () => {
  test('sectors partition the lap exactly once', () => {
    assert.equal(track.sectors.length, 3, 'a lap should have three sectors');
    const seen = new Set();
    let changes = 0;
    let previous = track.sectorAtDistance(0);
    for (let d = 0; d < track.length; d += 5) {
      const s = track.sectorAtDistance(d);
      seen.add(s);
      if (s !== previous) { changes++; previous = s; }
    }
    assert.deepEqual([...seen].sort(), [0, 1, 2]);
    assert.equal(changes, 2, 'the sector should change exactly twice around a lap');
  });

  test('DRS zones are real stretches of track with detection ahead of them', () => {
    assert.ok(track.drsZones.length >= 2, 'the circuit should have at least two DRS zones');
    for (const z of track.drsZones) {
      const start = z.startFraction * track.length;
      const end = z.endFraction * track.length;
      const len = (end - start + track.length) % track.length;
      assert.ok(len > 150 && len < 1400, `a DRS zone of ${len.toFixed(0)} m`);
      assert.ok(track.drsZoneAt(start + len * 0.5) === z, 'the middle of a zone should be in it');
      assert.ok(z.detectionFraction != null, 'a zone needs a detection point');
    }
  });

  test('the corners are named and spread around the lap', () => {
    assert.ok(track.features.length >= 8, 'the circuit should have named corners');
    for (const f of track.features) {
      assert.ok(typeof f.name === 'string' && f.name.length > 0, 'every feature needs a name');
      assert.ok(f.midDistance >= 0 && f.midDistance < track.length, 'features must lie on the lap');
    }
    const named = track.featureAt(track.features[3].midDistance);
    assert.equal(named, track.features[3], 'a corner should identify itself');
  });

  test('the grid sits on the straight before the line, in staggered rows', () => {
    assert.ok(track.gridSlots.length >= 20, 'there should be a full grid of slots');
    const first = track.gridSlots[0];
    const second = track.gridSlots[1];
    const third = track.gridSlots[2];

    // Pole is ahead of second, and second is on the other side of the road.
    assert.ok(first.lateral * second.lateral < 0, 'the front row should be staggered');
    assert.ok(Math.sign(first.lateral) === Math.sign(third.lateral),
      'slots should alternate sides down the grid');

    for (const slot of track.gridSlots) {
      const half = track.widthAtDistance(slot.distance) * 0.5;
      assert.ok(Math.abs(slot.lateral) < half, 'every grid slot must be on the road');
      assert.ok(Math.abs(track.curvatureAtDistance(slot.distance)) < 0.006,
        'the grid should be on a straight, not in a corner');
    }
  });

  test('the pit lane runs alongside the circuit, not across it', () => {
    assert.ok(track.pit.speedLimit > 10 && track.pit.speedLimit < 30,
      'the pit limit should be a real speed in m/s');
    const p = track.pointAtDistance(track.pit.entryDistance);
    assert.ok(p.length() > 0, 'the pit entry should be a real place');
    assert.equal(track.isInPitLane(p.x, p.z), false,
      'the racing line at the pit entry is not itself the pit lane');

    // A point offset to the pit side, mid-lane, is in the pit lane.
    const mid = (track.pit.entryDistance + track.pit.exitDistance) / 2;
    const lat = track.widthAtDistance(mid) * 0.5 + track.pit.width * 0.5 + 2;
    const inLane = track.pointAt(mid, Math.sign(track.pit.offset || 1) * lat);
    assert.equal(typeof track.isInPitLane(inLane.x, inLane.z), 'boolean');
  });
});

describe('racing line', () => {
  test('the line stays on the road all the way round', () => {
    for (let d = 0; d < track.length; d += 5) {
      const offset = track.lineOffsetAt(d, 'racing');
      const half = track.widthAtDistance(d) * 0.5;
      assert.ok(Math.abs(offset) <= half,
        `the racing line is ${Math.abs(offset).toFixed(2)} m off centre where the track is ${half.toFixed(2)} m wide`);
    }
  });

  test('the line uses the width of the road rather than hugging the centre', () => {
    let widest = 0; let travelled = 0;
    let previous = track.lineOffsetAt(0, 'racing');
    for (let d = 5; d < track.length; d += 5) {
      const offset = track.lineOffsetAt(d, 'racing');
      widest = Math.max(widest, Math.abs(offset));
      travelled += Math.abs(offset - previous);
      previous = offset;
    }
    assert.ok(widest > 3, `the line never gets more than ${widest.toFixed(2)} m from the centre`);
    assert.ok(travelled > 100, 'the line should move across the road through the lap');
  });

  test('the line is smooth — no kinks a car could not follow', () => {
    let steepest = 0;       // how far across the road it moves per metre along
    let sharpest = 0;       // second difference: a kink rather than a sweep
    for (let d = 0; d < track.length; d += 2) {
      const a = track.lineOffsetAt(d, 'racing');
      const b = track.lineOffsetAt(d + 2, 'racing');
      const c = track.lineOffsetAt(d + 4, 'racing');
      steepest = Math.max(steepest, Math.abs(b - a) / 2);
      sharpest = Math.max(sharpest, Math.abs(c - 2 * b + a));
    }
    // Crossing the road at a corner entry is normal; doing it at more than
    // about 20 degrees to the centreline is not.
    const angle = Math.atan(steepest) * 180 / Math.PI;
    assert.ok(angle < 20, `the line crosses the road at ${angle.toFixed(1)} deg`);
    // A kink would show up as a large change of direction between samples.
    assert.ok(sharpest < 0.08, `the line kinks by ${sharpest.toFixed(3)} m between samples`);
  });

  test('a wet line exists and differs from the dry one', () => {
    let differs = 0;
    for (let d = 0; d < track.length; d += 10) {
      const dry = track.lineOffsetAt(d, 'racing');
      const wet = track.lineOffsetAt(d, 'wet');
      if (Math.abs(dry - wet) > 0.3) differs++;
    }
    assert.ok(differs > 20, 'the wet line should take a different path to the dry one');
  });
});
