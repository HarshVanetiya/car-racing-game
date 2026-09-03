/**
 * Race rules, timing and weekend-format tests.
 *
 * The simulation can be perfect and the race still be wrong: positions have to
 * follow progress, laps have to be timed honestly, penalties have to be applied
 * and qualifying has to actually set the grid.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DriverTiming, SessionRecords } from '../src/race/Timing.js';
import { Weekend, WEEKEND_STAGES, WeekendStage } from '../src/race/Weekend.js';
import { SessionType } from '../src/race/RaceDirector.js';

describe('lap and sector timing', () => {
  /** Drive a lap: three sectors of the given lengths, then the line. */
  function driveLap(t, clock, sectors) {
    let time = clock;
    for (let s = 1; s < sectors.length; s++) {
      time += sectors[s - 1];
      t.update(time, s, false);
    }
    time += sectors[sectors.length - 1];
    const ev = t.update(time, 0, true);
    return { time, event: ev };
  }

  test('a lap time is the sum of its sectors', () => {
    const t = new DriverTiming(3);
    t.start(0);
    t.outLap = false;
    const { event } = driveLap(t, 0, [28.5, 31.25, 24.75]);
    assert.equal(event.type, 'personalBest');
    assert.ok(Math.abs(event.lapTime - 84.5) < 1e-9, `lap came out as ${event.lapTime}`);
    assert.equal(t.lap, 1);
    assert.ok(Math.abs(t.lastSectors.reduce((a, b) => a + b, 0) - 84.5) < 1e-9,
      'the sectors should add up to the lap');
  });

  test('the out lap does not count, and the flying lap does', () => {
    const t = new DriverTiming(3);
    t.start(0);
    assert.equal(t.outLap, true, 'timing starts on an out lap by default');
    const first = driveLap(t, 0, [40, 40, 40]);
    assert.equal(first.event.type, 'outLapComplete');
    assert.equal(t.bestLap, null, 'an out lap must not set a best lap');

    const second = driveLap(t, first.time, [28, 30, 26]);
    assert.equal(second.event.type, 'personalBest');
    assert.equal(t.bestLap, 84);
  });

  test('only a faster clean lap replaces the personal best', () => {
    const t = new DriverTiming(3);
    t.start(0);
    t.outLap = false;
    let clock = driveLap(t, 0, [28, 30, 26]).time;      // 84.0
    assert.equal(t.bestLap, 84);

    clock = driveLap(t, clock, [29, 31, 27]).time;      // 87.0, slower
    assert.equal(t.bestLap, 84, 'a slower lap must not become the best');
    assert.equal(t.lastLap, 87, 'but it is still the last lap');

    const ev = driveLap(t, clock, [27, 29, 25]);        // 81.0, faster
    assert.equal(ev.event.type, 'personalBest');
    assert.equal(t.bestLap, 81);
  });

  test('a lap with a track-limits violation cannot become a best lap', () => {
    const t = new DriverTiming(3);
    t.start(0);
    t.outLap = false;
    let clock = driveLap(t, 0, [28, 30, 26]).time;      // 84.0 clean
    t.invalidate();
    const ev = driveLap(t, clock, [26, 28, 24]);        // 78.0, but off track
    assert.equal(t.bestLap, 84, 'a deleted lap must not stand');
    assert.equal(ev.event.type, 'lap', 'it is still a completed lap');
    assert.equal(t.lastLap, 78, 'and it is still reported as the last lap');
  });

  test('best sectors are tracked separately from best laps', () => {
    const t = new DriverTiming(3);
    t.start(0);
    t.outLap = false;
    let clock = driveLap(t, 0, [28, 30, 26]).time;
    driveLap(t, clock, [27, 32, 26]);                   // faster S1, slower lap
    assert.equal(t.bestSectors[0], 27, 'the improved sector should stand');
    assert.equal(t.bestSectors[1], 30, 'the slower sector should not');
    assert.equal(t.bestLap, 84, 'the slower lap should not become the best');
  });

  test('the theoretical best is made of the fastest sectors in the session', () => {
    const r = new SessionRecords(3);
    r.submitLap('a', 'A', 84.0, 1);
    r.submitSector('a', 'A', 0, 28.0);
    r.submitSector('a', 'A', 1, 30.0);
    r.submitSector('a', 'A', 2, 26.0);
    r.submitSector('b', 'B', 0, 27.4);
    r.submitSector('b', 'B', 2, 25.6);
    r.submitLap('b', 'B', 83.6, 2);

    assert.ok(Math.abs(r.theoreticalBest - (27.4 + 30.0 + 25.6)) < 1e-9,
      `theoretical best came out as ${r.theoreticalBest}`);
    assert.ok(r.theoreticalBest < r.fastestLap,
      'the theoretical best should beat any single lap');
    assert.equal(r.fastestLapDriver.id, 'b');
    assert.equal(r.bestSectorDrivers[1].id, 'a', 'the middle sector belongs to A');
  });

  test('the session fastest lap only moves when someone genuinely goes faster', () => {
    const r = new SessionRecords(3);
    assert.equal(r.submitLap('a', 'A', 85.0, 1), true);
    assert.equal(r.fastestLapDriver.id, 'a');
    assert.equal(r.submitLap('b', 'B', 85.4, 1), false, 'a slower lap must not take the record');
    assert.equal(r.fastestLapDriver.id, 'a');
    assert.equal(r.submitLap('b', 'B', 84.2, 2), true);
    assert.equal(r.fastestLapDriver.id, 'b');
    assert.equal(r.fastestLap, 84.2);
    assert.equal(r.fastestLapNumber, 2);
    assert.equal(r.submitLap('c', 'C', 2.0, 1), false, 'a nonsense lap time is rejected');
  });
});

describe('race weekend', () => {
  test('the weekend runs practice, then qualifying, then the race', () => {
    const w = new Weekend({ laps: 12 });
    assert.equal(w.stage.key, WeekendStage.PRACTICE);
    assert.equal(w.stage.sessionType, SessionType.PRACTICE);
    assert.equal(w.isLast, false);

    assert.equal(w.completeStage([]).key, WeekendStage.QUALIFYING);
    assert.equal(w.stage.sessionType, SessionType.QUALIFYING);

    assert.equal(w.completeStage([]).key, WeekendStage.RACE);
    assert.equal(w.stage.sessionType, SessionType.RACE);
    assert.equal(w.isLast, true);

    assert.equal(w.completeStage([]), null, 'the weekend ends after the race');
    assert.equal(w.completed, true);
  });

  test('each stage configures its own session', () => {
    const w = new Weekend({ laps: 12 });
    const practice = w.sessionConfig();
    assert.ok(practice.sessionDuration > 0, 'practice should be timed');

    w.completeStage([]);
    const quali = w.sessionConfig();
    assert.ok(quali.sessionDuration > 0, 'qualifying should be timed');

    w.completeStage([]);
    const race = w.sessionConfig();
    assert.equal(race.totalLaps, 12, 'the race should run the chosen distance');
    assert.equal(race.sessionDuration, 0, 'a race is measured in laps, not minutes');
  });

  test('qualifying sets the grid, fastest first', () => {
    const w = new Weekend({ laps: 8 });
    w.completeStage([]);                                  // practice

    // Classification order is deliberately not the lap-time order.
    w.completeStage([
      { id: 'slow', bestLap: 86.4 },
      { id: 'pole', bestLap: 83.1 },
      { id: 'none', bestLap: null },
      { id: 'mid', bestLap: 84.9 }
    ]);

    assert.deepEqual(w.grid, ['pole', 'mid', 'slow', 'none']);
    assert.equal(w.gridPositionFor('pole', 99), 1);
    assert.equal(w.gridPositionFor('mid', 99), 2);
    assert.equal(w.gridPositionFor('none', 99), 4, 'a driver with no lap starts at the back');
    assert.equal(w.gridPositionFor('unknown', 7), 7, 'an unknown driver keeps its fallback');
  });

  test('practice does not set the grid', () => {
    const w = new Weekend({ laps: 8 });
    w.completeStage([{ id: 'a', bestLap: 80 }, { id: 'b', bestLap: 90 }]);
    assert.equal(w.grid, null, 'only qualifying decides where you start');
    assert.equal(w.gridPositionFor('a', 5), 5);
  });

  test('a weekend can be run again from the start', () => {
    const w = new Weekend({ laps: 8 });
    w.completeStage([]);
    w.completeStage([{ id: 'a', bestLap: 80 }]);
    w.reset();
    assert.equal(w.stage.key, WeekendStage.PRACTICE);
    assert.equal(w.grid, null);
    assert.equal(w.completed, false);
    assert.deepEqual(w.results, {});
  });

  test('every stage is described for the player', () => {
    for (const stage of WEEKEND_STAGES) {
      assert.ok(stage.name && stage.description, `${stage.key} needs a name and a description`);
      assert.ok(Object.values(SessionType).includes(stage.sessionType),
        `${stage.key} has an unknown session type`);
    }
  });
});
