/**
 * Input tests.
 *
 * The one property that matters here is that what the tyres see does not
 * depend on how fast the display happens to be running. A driver on a slow
 * machine should get the same steering, applied just as smoothly, as one on a
 * fast machine — otherwise the car feels broken through no fault of the
 * physics.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Input } from '../src/core/Input.js';

/** A stand-in for `window` that lets the tests press and release keys. */
function fakeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    fire(type, event) {
      for (const fn of listeners.get(type) || []) fn(event);
    }
  };
}

/** Build an Input and immediately fire something at it. */
function fakeTargetWith(emit) {
  const target = fakeTarget();
  queueMicrotask(() => {});
  const original = target.addEventListener;
  let ready = false;
  target.addEventListener = (type, fn) => {
    original.call(target, type, fn);
    if (type === 'blur' && !ready) { ready = true; emit(target); }
  };
  return target;
}

function makeInput() {
  const target = fakeTarget();
  const input = new Input(target);
  return {
    input,
    down: (code) => target.fire('keydown', { code, repeat: false, preventDefault() {} }),
    up: (code) => target.fire('keyup', { code, preventDefault() {} })
  };
}

/**
 * Hold a key for `seconds`, running the input the way the game does: polled
 * once per rendered frame, advanced once per physics step.
 */
function driveFor(input, seconds, fps, physicsHz = 240) {
  const frameDt = 1 / fps;
  const stepDt = 1 / physicsHz;
  const samples = [];
  let accumulator = 0;
  for (let t = 0; t < seconds; t += frameDt) {
    input.update();
    accumulator += frameDt;
    while (accumulator >= stepDt) {
      const axes = input.advanceAxes(stepDt);
      samples.push(axes.steer);
      accumulator -= stepDt;
    }
  }
  return samples;
}

describe('steering does not depend on the frame rate', () => {
  test('a second of lock reaches the same place at 10 fps as at 144', () => {
    const results = [10, 30, 60, 144].map((fps) => {
      const { input, down } = makeInput();
      down('ArrowRight');
      const samples = driveFor(input, 1.0, fps);
      return { fps, steer: samples[samples.length - 1] };
    });

    const fastest = results[results.length - 1].steer;
    for (const r of results) {
      assert.ok(Math.abs(r.steer - fastest) < 0.02,
        `at ${r.fps} fps the wheel reached ${r.steer.toFixed(3)} but at 144 fps ${fastest.toFixed(3)}`);
    }
  });

  test('the wheel moves in small increments even when frames are long', () => {
    const { input, down } = makeInput();
    down('ArrowRight');
    const samples = driveFor(input, 1.0, 10);       // a machine managing 10 fps

    let biggestJump = 0;
    for (let i = 1; i < samples.length; i++) {
      biggestJump = Math.max(biggestJump, Math.abs(samples[i] - samples[i - 1]));
    }
    // At 240 Hz and a rate of 3.4/s, one step is 1.4% of full lock. Anything
    // approaching a tenth would be the old once-a-frame staircase.
    assert.ok(biggestJump < 0.03,
      `the wheel jumped ${(biggestJump * 100).toFixed(1)}% of full lock in one step`);
    assert.ok(samples.length > 200, 'the axes should advance once per physics step');
  });

  test('throttle and brake ramp rather than snapping', () => {
    const { input, down } = makeInput();
    down('ArrowUp');
    input.update();
    input.advanceAxes(1 / 240);
    assert.ok(input.throttle > 0 && input.throttle < 0.05,
      `one step of throttle gave ${input.throttle.toFixed(3)}, which is a step change`);

    const samples = driveFor(input, 0.5, 60);
    assert.ok(input.throttle > 0.9, 'half a second should be most of the way to full throttle');
    assert.ok(samples.length > 100);
  });

  test('releasing the wheel returns it to centre', () => {
    const { input, down, up } = makeInput();
    down('ArrowRight');
    driveFor(input, 1.0, 60);
    assert.ok(input.steer > 0.9, 'the wheel should be near full lock');

    up('ArrowRight');
    driveFor(input, 1.0, 60);
    assert.ok(Math.abs(input.steer) < 0.02, `the wheel stayed at ${input.steer.toFixed(3)}`);
  });

  test('a correction the other way is quicker than building lock from centre', () => {
    const build = makeInput();
    build.down('ArrowRight');
    driveFor(build.input, 0.2, 60);
    const fromCentre = build.input.steer;

    const correct = makeInput();
    correct.down('ArrowRight');
    driveFor(correct.input, 1.0, 60);              // on full right lock
    correct.up('ArrowRight');
    correct.down('ArrowLeft');
    const before = correct.input.steer;
    driveFor(correct.input, 0.2, 60);
    const moved = before - correct.input.steer;

    assert.ok(moved > fromCentre,
      `catching a slide moved the wheel ${moved.toFixed(3)}, no quicker than the ${fromCentre.toFixed(3)} from centre`);
  });

  test('keys are ignored while typing in a text field', () => {
    const target = fakeTarget();
    const input = new Input(target);
    const press = (code, on) => target.fire('keydown', {
      code, repeat: false, target: on, preventDefault() {}
    });

    press('ArrowUp', { tagName: 'CANVAS' });
    assert.equal(input.isDown('throttle'), true, 'the game should get the key');

    const typing = new Input(fakeTargetWith((t) => {
      t.fire('keydown', { code: 'ArrowUp', repeat: false,
                          target: { tagName: 'INPUT' }, preventDefault() {} });
    }));
    assert.equal(typing.isDown('throttle'), false,
      'a key typed into a text field must not drive the car');
  });

  test('losing focus releases everything, so the car does not run away', () => {
    const target = fakeTarget();
    const input = new Input(target);
    target.fire('keydown', { code: 'ArrowUp', repeat: false, preventDefault() {} });
    assert.equal(input.isDown('throttle'), true);
    target.fire('blur', {});
    assert.equal(input.isDown('throttle'), false, 'blur should let go of the pedals');
  });
});
