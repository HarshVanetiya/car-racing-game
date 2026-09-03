/**
 * AI tests.
 *
 * The brief is explicit that the AI must drive the same car through the same
 * controls, with no cheats. These tests check the speed profile the AI aims at
 * is derived from real physics, that skill only changes how much of the car's
 * limit a driver uses, and that an AI actually drives a lap.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SpeedProfile } from '../src/ai/SpeedProfile.js';
import { AIDriver, AI_SKILL_PRESETS } from '../src/ai/AIDriver.js';
import { TrackModel } from '../src/track/TrackModel.js';
import { Vehicle } from '../src/physics/Vehicle.js';
import { CARS, getCar, defaultSetup } from '../src/cars/carDefs.js';
import { Vec3 } from '../src/math/Vec3.js';

const track = new TrackModel();

describe('speed profile', () => {
  const profile = new SpeedProfile(track, {});

  test('the profile is slowest in the corners and fastest on the straights', () => {
    let slowest = Infinity; let slowestD = 0;
    let fastest = 0; let fastestD = 0;
    for (let d = 0; d < track.length; d += 5) {
      const v = profile.speedAt(d);
      if (v < slowest) { slowest = v; slowestD = d; }
      if (v > fastest) { fastest = v; fastestD = d; }
    }
    assert.ok(slowest > 10 && slowest < 30,
      `the slowest point of the lap is ${(slowest * 3.6).toFixed(0)} km/h`);
    assert.ok(fastest > 75, `the fastest point of the lap is only ${(fastest * 3.6).toFixed(0)} km/h`);

    // The slowest point should be a tight corner and the fastest a straight.
    assert.ok(Math.abs(profile.curvatureAt(slowestD)) > 0.02, 'the slow point should be a corner');
    assert.ok(Math.abs(profile.curvatureAt(fastestD)) < 0.005, 'the fast point should be straight');
  });

  test('braking zones sit before corners, not in them', () => {
    let zones = 0;
    for (let d = 0; d < track.length; d += 5) {
      if (!profile.isBrakingZone(d)) continue;
      zones++;
      // Somewhere in the next 350 m there must be a corner to brake for.
      let minSpeedAhead = Infinity;
      for (let a = 0; a < 350; a += 10) {
        minSpeedAhead = Math.min(minSpeedAhead, profile.speedAt(d + a));
      }
      assert.ok(minSpeedAhead < profile.speedAt(d),
        `braking at ${d.toFixed(0)} m with nothing slower ahead`);
    }
    assert.ok(zones > 5, 'a lap should have several braking zones');
  });

  test('the profile predicts a plausible lap time', () => {
    const lap = profile.computeLapTime();
    assert.ok(lap > 60 && lap < 160, `${lap.toFixed(1)} s is not a plausible lap`);
    // ...and within reach of the circuit's own record hint.
    assert.ok(Math.abs(lap - track.info.lapRecordHint) < track.info.lapRecordHint * 0.35,
      `${lap.toFixed(1)} s against a record hint of ${track.info.lapRecordHint} s`);
  });

  test('less grip means a slower lap, and downforce means faster corners', () => {
    const dry = new SpeedProfile(track, { grip: 1.62 });
    const wet = new SpeedProfile(track, { grip: 1.15 });
    assert.ok(wet.computeLapTime() > dry.computeLapTime() + 3,
      'losing a third of the grip should cost real lap time');

    const winged = new SpeedProfile(track, { clA: 4.1 });
    const none = new SpeedProfile(track, { clA: 0.2 });
    assert.ok(none.computeLapTime() > winged.computeLapTime() + 5,
      'a car with no downforce should be much slower');
  });

  test('a heavier car corners and stops no better than a light one', () => {
    const light = new SpeedProfile(track, { mass: 800 });
    const heavy = new SpeedProfile(track, { mass: 900 });
    assert.ok(heavy.computeLapTime() >= light.computeLapTime(),
      'extra mass should never make the car faster');
  });

  test('confidence scales the target without changing the car', () => {
    const bold = new SpeedProfile(track, { confidence: 0.95 });
    const cautious = new SpeedProfile(track, { confidence: 0.70 });
    assert.ok(cautious.computeLapTime() > bold.computeLapTime(),
      'a cautious driver should lap slower');
    // The difference must come from the corners, not from a higher top speed.
    const straight = 300;
    assert.ok(Math.abs(bold.speedAt(straight) - cautious.speedAt(straight)) <
              bold.speedAt(straight) * 0.2,
      'skill should not change how fast the car goes down a straight');
  });
});

describe('AI drivers', () => {
  function makeAI(skill) {
    const def = getCar(CARS[0].id);
    const vehicle = new Vehicle(def, defaultSetup(def), {
      id: `ai-${skill}`, driverName: skill, isAI: true
    });
    const slot = track.gridSlots[0];
    const p = track.pointAt(slot.distance, slot.lateral);
    vehicle.placeAt(p, track.headingAtDistance(slot.distance));
    // Tire blankets, exactly as the race session fits them on the grid.
    for (const w of vehicle.wheels) w.tire.reset(w.tire.compoundKey, true);
    const ai = new AIDriver(vehicle, track, { skill, seed: 1234 });
    return { vehicle, ai };
  }

  test('every skill level is a real driver with a confidence below 1', () => {
    for (const [key, preset] of Object.entries(AI_SKILL_PRESETS)) {
      const { ai } = makeAI(key);
      assert.equal(ai.skill.key, key);
      assert.ok(ai.skill.confidence > 0.6 && ai.skill.confidence <= 1.0,
        `${key} has a confidence of ${ai.skill.confidence}`);
      assert.ok(preset.reaction > 0, `${key} should have a real reaction time`);
    }
  });

  test('a faster preset really is faster than a slower one', () => {
    const rookie = makeAI('rookie');
    const legend = makeAI('legend');
    assert.ok(legend.ai.profile.computeLapTime() < rookie.ai.profile.computeLapTime(),
      'a legend should be quicker than a rookie');
  });

  test('the AI drives through the same controls a human uses', () => {
    const { vehicle, ai } = makeAI('pro');
    const before = { ...vehicle.controls };
    const env = { wetness: 0, waterDepth: 0, trackRubber: 0.5, airDensity: 1.225 };
    ai.update(1 / 60, {
      env,
      progress: { distance: track.gridSlots[0].distance, lateral: track.gridSlots[0].lateral, lap: 0 },
      cars: [{ id: vehicle.id, vehicle, progress: { distance: track.gridSlots[0].distance, lateral: 0, lap: 0 }, racePosition: 1 }],
      raceState: { totalLaps: 5, phase: 'racing', weather: { wetness: 0 } },
      phase: 'racing'
    });
    // The only thing an AI may do is move the pedals and the wheel.
    assert.ok(vehicle.controls.throttle >= 0 && vehicle.controls.throttle <= 1);
    assert.ok(vehicle.controls.brake >= 0 && vehicle.controls.brake <= 1);
    assert.ok(Math.abs(vehicle.controls.steer) <= 1);
    assert.ok('throttle' in before, 'controls existed before the AI touched them');
    // It must not have moved the car itself.
    assert.equal(vehicle.body.speed, 0, 'the AI must not teleport its car');
  });

  test('an AI gets a car round a lap of the circuit', () => {
    const { vehicle, ai } = makeAI('pro');
    const env = { wetness: 0, waterDepth: 0, trackRubber: 0.5, airDensity: 1.225,
                  tireWearScale: 1 };
    const DT = 1 / 240;
    const project = {};

    let distance = track.gridSlots[0].distance;
    let travelled = 0;
    let previous = distance;
    const budget = 240;                                   // s of race time

    for (let step = 0; step < budget / DT; step++) {
      track.project(vehicle.body.position.x, vehicle.body.position.z, project);
      distance = project.distance;

      const progress = { distance, lateral: project.lateral, lap: 0 };
      ai.update(DT, {
        env,
        progress,
        cars: [{ id: vehicle.id, vehicle, progress, racePosition: 1 }],
        raceState: { totalLaps: 5, phase: 'racing', weather: { wetness: 0 } },
        phase: 'racing'
      });
      vehicle.step(DT, track, env);

      let delta = distance - previous;
      if (delta < -track.length * 0.5) delta += track.length;
      if (delta > track.length * 0.5) delta -= track.length;
      travelled += delta;
      previous = distance;

      if (travelled > track.length) break;
    }

    assert.ok(travelled > track.length * 0.98,
      `the AI only got ${(travelled / track.length * 100).toFixed(0)}% of the way round`);
    assert.ok(vehicle.speedKmh > 40, 'the AI should still be moving at the end of the lap');
  });

  test('a spun AI turns the car round and drives on', () => {
    const def = getCar(CARS[0].id);
    const vehicle = new Vehicle(def, defaultSetup(def), {
      id: 'spun', driverName: 'Spun', isAI: true
    });
    // Drop it on the circuit facing backwards and stationary: a spin.
    const d = 1400;
    vehicle.placeAt(track.pointAt(d, 0), track.headingAtDistance(d) + Math.PI);
    for (const w of vehicle.wheels) w.tire.reset(w.tire.compoundKey, true);
    const ai = new AIDriver(vehicle, track, { skill: 'pro', seed: 7 });

    const env = { wetness: 0, waterDepth: 0, trackRubber: 0.5, airDensity: 1.225,
                  tireWearScale: 1 };
    const DT = 1 / 240;
    const project = {};
    const yawError = () => {
      let e = vehicle.yaw - track.headingAtDistance(project.distance);
      return Math.abs(((e + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    };

    let worstLateral = 0;
    for (let step = 0; step < 30 / DT; step++) {
      track.project(vehicle.body.position.x, vehicle.body.position.z, project);
      const progress = { distance: project.distance, lateral: project.lateral, lap: 0 };
      ai.update(DT, {
        env,
        progress,
        cars: [{ id: vehicle.id, vehicle, progress, racePosition: 1 }],
        raceState: { totalLaps: 5, phase: 'racing', weather: { wetness: 0 } },
        phase: 'racing'
      });
      vehicle.step(DT, track, env);
      worstLateral = Math.max(worstLateral, Math.abs(project.lateral));
    }

    track.project(vehicle.body.position.x, vehicle.body.position.z, project);
    assert.ok(yawError() < 0.5,
      `the car is still ${(yawError() * 180 / Math.PI).toFixed(0)} deg off the track direction`);
    assert.ok(vehicle.body.forwardSpeed > 10,
      `the car is only doing ${(vehicle.body.forwardSpeed * 3.6).toFixed(0)} km/h forwards`);
    assert.ok(vehicle.transmission.gear >= 1, 'it must not be left in reverse');
    assert.ok(worstLateral < 40,
      `recovery wandered ${worstLateral.toFixed(0)} m from the centreline`);
  });
});
