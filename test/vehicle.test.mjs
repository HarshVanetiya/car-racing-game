/**
 * Whole-car behaviour tests.
 *
 * These drive a real Vehicle on a flat, infinite plane and assert the
 * behaviours the design brief calls for: performance in the right ballpark,
 * weight transfer that emerges from the forces, grip that grows with speed
 * because of downforce, and none of the arcade shortcuts §69 forbids.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Vehicle } from '../src/physics/Vehicle.js';
import { CARS, getCar, defaultSetup } from '../src/cars/carDefs.js';
import { SurfaceType } from '../src/physics/Surfaces.js';
import { Vec3 } from '../src/math/Vec3.js';

const DT = 1 / 240;

/** An infinite flat asphalt plane — the car's behaviour with nothing else in it. */
function flatGround(surfaceType = SurfaceType.ASPHALT, wetness = 0) {
  return {
    sampleGround(x, z, out) {
      out.point.set(x, 0, z);
      out.normal.set(0, 1, 0);
      out.surfaceType = surfaceType;
      out.wetness = wetness;
      out.waterDepth = wetness > 0.7 ? 0.002 : 0;
      out.rubber = 0.5;
      out.distanceAlong = 0;
      out.lateral = 0;
      return out;
    }
  };
}

const ENV = { wetness: 0, waterDepth: 0, trackRubber: 0.5, airDensity: 1.225, tireWearScale: 1 };

function makeCar(overrides = {}) {
  const def = getCar(CARS[0].id);
  const setup = { ...defaultSetup(def), ...(overrides.setup || {}) };
  const v = new Vehicle(def, setup, {
    id: 'test', driverName: 'Test', isPlayer: true,
    assists: { tractionControl: 0, abs: 0, stabilityControl: 0, steeringAssist: 0,
               automaticGears: true, ...(overrides.assists || {}) },
    ...overrides.options
  });
  v.placeAt(new Vec3(0, 0, 0), 0);
  // Tires in their window, so a cold-tire lap does not masquerade as a physics bug.
  for (const w of v.wheels) w.tire.reset(w.tire.compoundKey, true);
  for (const w of v.wheels) {
    w.tire.surfaceTemp = w.tire.compound.optimalTemp;
    w.tire.coreTemp = w.tire.compound.optimalTemp;
  }
  return v;
}

/** Settle the car onto its springs so the first step is not a drop test. */
function settle(v, ground, seconds = 1.0) {
  v.controls.throttle = 0; v.controls.brake = 0; v.controls.steer = 0;
  for (let i = 0; i < seconds / DT; i++) v.step(DT, ground, ENV);
}

/** Run the car up to a target speed with full throttle in a straight line. */
function accelerateTo(v, ground, targetKmh, maxSeconds = 40) {
  let t = 0;
  v.controls.brake = 0;
  v.controls.steer = 0;
  v.controls.throttle = 1;
  while (v.speedKmh < targetKmh && t < maxSeconds) { v.step(DT, ground, ENV); t += DT; }
  return t;
}

describe('performance', () => {
  const ground = flatGround();

  test('the car accelerates like a formula car', () => {
    const v = makeCar();
    settle(v, ground);
    const to100 = accelerateTo(v, ground, 100);
    assert.ok(to100 > 2.0 && to100 < 6.0, `0-100 km/h in ${to100.toFixed(2)} s is not plausible`);
    const to200 = to100 + accelerateTo(v, ground, 200);
    assert.ok(to200 > to100 && to200 < 10, `0-200 km/h in ${to200.toFixed(2)} s is not plausible`);
    assert.ok(v.transmission.gear > 3, 'the gearbox should have worked its way up');
  });

  test('top speed is drag-limited, not clamped', () => {
    const v = makeCar();
    settle(v, ground);
    accelerateTo(v, ground, 500, 70);            // unreachable target: run until it stops pulling
    const top = v.speedKmh;
    assert.ok(top > 280 && top < 400, `top speed ${top.toFixed(0)} km/h is not plausible`);
    // At the top the drag really is eating the drive, which is what limits it.
    assert.ok(v.aero.drag > 5000, `only ${v.aero.drag.toFixed(0)} N of drag at ${top.toFixed(0)} km/h`);
  });

  test('braking from speed is heavy but finite, and takes real distance', () => {
    const v = makeCar();
    settle(v, ground);
    accelerateTo(v, ground, 300, 60);

    const startZ = v.body.position.z;
    v.controls.throttle = 0;
    v.controls.brake = 1;
    let t = 0; let peakG = 0;
    while (v.speedKmh > 5 && t < 20) {
      const before = v.speed;
      v.step(DT, ground, ENV);
      const g = (before - v.speed) / DT / 9.80665;
      if (g > peakG) peakG = g;
      t += DT;
    }
    const distance = Math.abs(v.body.position.z - startZ);
    assert.ok(distance > 60 && distance < 400, `${distance.toFixed(0)} m to stop from 300 km/h`);
    assert.ok(peakG > 2.5 && peakG < 7, `${peakG.toFixed(2)} g of braking is not plausible`);
  });
});

describe('no arcade shortcuts', () => {
  const ground = flatGround();

  test('the car does not turn without tire forces', () => {
    const v = makeCar();
    settle(v, ground);
    // Bring the car to a genuine standstill on the brakes first — a formula
    // car idles in gear, so it creeps until the discs have something to bite.
    v.controls.throttle = 0;
    v.controls.brake = 1;
    v.controls.steer = 0;
    for (let i = 0; i < 8 / DT && v.speedKmh > 0.1; i++) v.step(DT, ground, ENV);
    assert.ok(v.speedKmh <= 0.1, `the car would not stop (${v.speedKmh.toFixed(2)} km/h)`);

    // Now go to full lock. The roadwheels turn, but with no velocity through
    // the contact patch there is no slip angle, hence no lateral force and no
    // yaw. An arcade car would pivot on the spot regardless.
    const heading = () => Math.atan2(v.body.forward.x, v.body.forward.z);
    const heading0 = heading();
    v.controls.steer = 1;
    for (let i = 0; i < 2 / DT; i++) v.step(DT, ground, ENV);

    const drift = Math.abs(heading() - heading0) * 180 / Math.PI;
    assert.ok(drift < 1.0, `a stationary car turned ${drift.toFixed(2)} deg on full lock`);
    assert.ok(Math.abs(v.steerAngle) > 0.3, 'the roadwheels really were on lock');
    assert.ok(v.speedKmh < 0.5, 'and it did not drive itself along either');
  });

  test('steering takes time to reach lock', () => {
    const v = makeCar();
    settle(v, ground);
    accelerateTo(v, ground, 120);
    v.controls.steer = 1;
    v.steerAngle = 0;
    v.step(DT, ground, ENV);
    assert.ok(Math.abs(v.steerAngle) < v.car.maxSteerAngle * 0.2,
      'the wheel should not snap to full lock in one step');
    for (let i = 0; i < 1.5 / DT; i++) v.step(DT, ground, ENV);
    assert.ok(Math.abs(v.steerAngle) > v.car.maxSteerAngle * 0.3,
      'the wheel should get there eventually');
  });

  test('lifting off slows the car down', () => {
    const v = makeCar();
    settle(v, ground);
    accelerateTo(v, ground, 250, 60);
    const before = v.speedKmh;
    v.controls.throttle = 0;
    v.controls.brake = 0;
    for (let i = 0; i < 2 / DT; i++) v.step(DT, ground, ENV);
    assert.ok(v.speedKmh < before - 10,
      `coasting only lost ${(before - v.speedKmh).toFixed(1)} km/h in two seconds`);
  });

  test('grip is not the same at every speed', () => {
    const lowSpeedG = corneringLimitG(60);
    const highSpeedG = corneringLimitG(280);
    assert.ok(highSpeedG > lowSpeedG * 1.4,
      `lateral grip barely changed with speed (${lowSpeedG.toFixed(2)} g vs ${highSpeedG.toFixed(2)} g)`);
    assert.ok(lowSpeedG > 1.2 && lowSpeedG < 2.6, `${lowSpeedG.toFixed(2)} g at 60 km/h`);
    assert.ok(highSpeedG > 2.5 && highSpeedG < 6, `${highSpeedG.toFixed(2)} g at 280 km/h`);
  });

  /** Steer at a fixed speed and measure the peak lateral acceleration reached. */
  function corneringLimitG(kmh) {
    const v = makeCar();
    settle(v, ground);
    accelerateTo(v, ground, kmh, 60);
    let best = 0;
    // Sweep steering lock upward and record the best sustained lateral g.
    for (let lock = 0.05; lock <= 1.0; lock += 0.05) {
      v.controls.steer = lock;
      for (let i = 0; i < 0.35 / DT; i++) {
        // Hold the speed so this measures grip, not acceleration.
        v.controls.throttle = v.speedKmh < kmh ? 0.6 : 0;
        v.step(DT, ground, ENV);
        const g = Math.abs(v.telemetry.lateralG);
        if (g > best) best = g;
      }
    }
    return best;
  }
});

describe('weight transfer emerges from the forces', () => {
  const ground = flatGround();
  const axleLoad = (v, a, b) => v.wheels[a].load + v.wheels[b].load;

  test('braking loads the front axle, accelerating loads the rear', () => {
    const v = makeCar();
    settle(v, ground, 2);
    const staticFront = axleLoad(v, 0, 1);
    const staticRear = axleLoad(v, 2, 3);
    assert.ok(staticFront > 0 && staticRear > 0, 'the car should be sitting on its wheels');

    const staticSplit = staticFront / (staticFront + staticRear);

    accelerateTo(v, ground, 150);
    v.controls.throttle = 0; v.controls.brake = 1;
    for (let i = 0; i < 0.6 / DT; i++) v.step(DT, ground, ENV);
    const brakingFront = axleLoad(v, 0, 1);
    const brakingRear = axleLoad(v, 2, 3);
    const brakingSplit = brakingFront / (brakingFront + brakingRear);
    assert.ok(brakingFront > staticFront * 1.15, 'braking should load the front');
    assert.ok(brakingSplit > staticSplit + 0.05,
      `braking moved the balance only from ${staticSplit.toFixed(3)} to ${brakingSplit.toFixed(3)}`);

    v.controls.brake = 0; v.controls.throttle = 1;
    for (let i = 0; i < 0.6 / DT; i++) v.step(DT, ground, ENV);
    const drivingFront = axleLoad(v, 0, 1);
    const drivingRear = axleLoad(v, 2, 3);
    const drivingSplit = drivingFront / (drivingFront + drivingRear);
    assert.ok(drivingSplit < brakingSplit - 0.05,
      'accelerating should throw the load back onto the rear');
    assert.ok(drivingRear > brakingRear, 'the rear axle should gain load under power');
  });

  test('cornering loads the outside wheels', () => {
    const v = makeCar();
    settle(v, ground);
    accelerateTo(v, ground, 160);
    v.controls.steer = 0.6;
    v.controls.throttle = 0.4;
    for (let i = 0; i < 1.2 / DT; i++) v.step(DT, ground, ENV);

    const left = v.wheels[0].load + v.wheels[2].load;
    const right = v.wheels[1].load + v.wheels[3].load;
    assert.ok(Math.abs(left - right) > 400,
      `lateral load transfer of only ${Math.abs(left - right).toFixed(0)} N in a corner`);
    // Steering right (+) throws the load onto the left-hand wheels.
    assert.ok(left > right, 'the outside of the corner should carry the load');
  });

  test('downforce loads all four wheels at speed', () => {
    const v = makeCar();
    settle(v, ground, 2);
    const stationary = v.wheels.reduce((s, w) => s + w.load, 0);
    accelerateTo(v, ground, 300, 60);
    v.controls.throttle = 0.35;                         // hold it, no traction squat
    for (let i = 0; i < 0.5 / DT; i++) v.step(DT, ground, ENV);
    const fast = v.wheels.reduce((s, w) => s + w.load, 0);
    assert.ok(fast > stationary * 1.8,
      `only ${(fast / stationary).toFixed(2)}x the static load at 300 km/h`);
  });
});

describe('consumables and conditions', () => {
  test('fuel burns, and the car gets lighter as it does', () => {
    const ground = flatGround();
    const v = makeCar();
    settle(v, ground);
    const startFuel = v.fuel;
    const startMass = v.body.mass;
    accelerateTo(v, ground, 280, 60);
    for (let i = 0; i < 10 / DT; i++) { v.controls.throttle = 1; v.step(DT, ground, ENV); }
    assert.ok(v.fuel < startFuel, 'the engine should burn fuel');
    assert.ok(v.fuel > startFuel - 3, `${(startFuel - v.fuel).toFixed(2)} kg in ~20 s is too much`);
    assert.ok(v.body.mass < startMass, 'a lighter tank should mean a lighter car');
    // Mass properties are refreshed every 0.25 kg rather than every step, so
    // the two track each other to within that granularity.
    const massLost = startMass - v.body.mass;
    const fuelBurnt = startFuel - v.fuel;
    assert.ok(Math.abs(massLost - fuelBurnt) < 0.3,
      `mass fell ${massLost.toFixed(3)} kg for ${fuelBurnt.toFixed(3)} kg of fuel`);
  });

  test('a wet track costs grip and lengthens the stop', () => {
    const stop = (wetness) => {
      const ground = flatGround(SurfaceType.ASPHALT, wetness);
      const env = { ...ENV, wetness, waterDepth: wetness > 0.7 ? 0.002 : 0 };
      const v = makeCar();
      v.controls.throttle = 0; v.controls.brake = 0; v.controls.steer = 0;
      for (let i = 0; i < 1 / DT; i++) v.step(DT, ground, env);
      let t = 0;
      v.controls.throttle = 1;
      while (v.speedKmh < 200 && t < 40) { v.step(DT, ground, env); t += DT; }
      const start = v.body.position.z;
      v.controls.throttle = 0; v.controls.brake = 1;
      let bt = 0;
      while (v.speedKmh > 40 && bt < 30) { v.step(DT, ground, env); bt += DT; }
      return Math.abs(v.body.position.z - start);
    };
    const dry = stop(0);
    const wet = stop(1);
    assert.ok(wet > dry * 1.15, `wet stop ${wet.toFixed(0)} m vs dry ${dry.toFixed(0)} m`);
  });

  test('running onto the grass costs grip and speed', () => {
    const onGrass = flatGround(SurfaceType.GRASS);
    const onAsphalt = flatGround();
    const v = makeCar();
    settle(v, onAsphalt);
    accelerateTo(v, onAsphalt, 200, 60);
    const before = v.speedKmh;
    v.controls.throttle = 1;
    for (let i = 0; i < 2 / DT; i++) v.step(DT, onGrass, ENV);
    assert.ok(v.speedKmh < before, 'the grass should slow the car even at full throttle');
  });
});

describe('assists help without driving for you', () => {
  const ground = flatGround();

  test('traction control limits wheelspin off the line', () => {
    const spin = (tc) => {
      const v = makeCar({ assists: { tractionControl: tc } });
      settle(v, ground);
      let worst = 0;
      v.controls.throttle = 1;
      for (let i = 0; i < 2 / DT; i++) {
        v.step(DT, ground, ENV);
        for (const w of v.wheels) worst = Math.max(worst, w.tire.slipRatio);
      }
      return { worst, speed: v.speedKmh };
    };
    const off = spin(0);
    const on = spin(1);
    assert.ok(on.worst < off.worst, 'traction control should cut wheelspin');
    // ...but it must not make the car faster than a driver who can modulate.
    assert.ok(on.speed <= off.speed * 1.35, 'traction control should not be a speed boost');
  });

  test('ABS keeps the wheels turning under maximum braking', () => {
    const lock = (abs) => {
      const v = makeCar({ assists: { abs } });
      settle(v, ground);
      accelerateTo(v, ground, 200, 60);
      v.controls.throttle = 0; v.controls.brake = 1;
      let locked = 0; let steps = 0;
      while (v.speedKmh > 60 && steps < 20 / DT) {
        v.step(DT, ground, ENV);
        if (v.wheels.some((w) => w.tire.isLocked)) locked++;
        steps++;
      }
      return locked / Math.max(1, steps);
    };
    assert.ok(lock(1) < lock(0) + 1e-9, 'ABS should not increase lockups');
    assert.ok(lock(1) < 0.25, 'with ABS the wheels should mostly keep turning');
  });
});

describe('driver aids do their job without doing the driving', () => {
  const ground = flatGround();

  /** Full lock and a given throttle at a given speed — what a keyboard does. */
  function provoke(assists, kmh, lock, throttle) {
    const v = makeCar({ assists });
    settle(v, ground);
    accelerateTo(v, ground, kmh, 40);
    if (v.speedKmh < kmh * 0.9) return null;
    v.controls.steer = lock;
    v.controls.throttle = throttle;
    let worst = 0;
    for (let i = 0; i < 3.5 / DT; i++) {
      v.step(DT, ground, ENV);
      worst = Math.max(worst, Math.abs(v.telemetry.slipAngleBody) * 180 / Math.PI);
    }
    return worst;
  }

  test('traction control keeps a standing start on the road', () => {
    // A short first gear and eight hundred horsepower will break the rear
    // tyres loose whatever the electronics do — that is the car, not a fault.
    // What the aid has to do is stop it running away.
    const peakSlip = (level) => {
      const v = makeCar({ assists: { tractionControl: level } });
      settle(v, ground);
      v.controls.throttle = 1;
      let worst = 0;
      for (let i = 0; i < 4 / DT; i++) {
        v.step(DT, ground, ENV);
        worst = Math.max(worst, v.wheels[2].tire.slipRatio, v.wheels[3].tire.slipRatio);
      }
      return worst;
    };

    const bare = peakSlip(0);
    const aided = peakSlip(0.4);            // the default
    assert.ok(bare > 3, `the car should light up its tyres unaided, got ${bare.toFixed(1)}`);
    assert.ok(aided < bare * 0.6,
      `traction control barely helped: ${aided.toFixed(1)} against ${bare.toFixed(1)} unaided`);
    assert.ok(peakSlip(1) < aided,
      'a higher setting should allow less wheelspin than a lower one');
  });

  test('and gives away nothing when it is switched off', () => {
    const off = makeCar({ assists: { tractionControl: 0 } });
    settle(off, ground);
    const tOff = accelerateTo(off, ground, 150, 30);

    const on = makeCar({ assists: { tractionControl: 0.4 } });
    settle(on, ground);
    const tOn = accelerateTo(on, ground, 150, 30);

    // It may cost a little — it is protecting traction, not finding grip —
    // but it must never be the faster way round.
    assert.ok(tOn >= tOff - 0.05, 'traction control must not be a speed boost');
    assert.ok(tOn < tOff * 1.6, `traction control cost ${(tOn - tOff).toFixed(2)} s to 150 km/h`);
  });

  test('stability control never helps the car rotate', () => {
    // A car already sliding at full lock is usually rotating SLOWER than that
    // lock demands. A stability system that simply chases the commanded yaw
    // rate will push it to rotate faster, driving the spin it exists to stop.
    const v = makeCar({ assists: { stabilityControl: 1 } });
    settle(v, ground);
    accelerateTo(v, ground, 90, 30);
    v.controls.steer = 1;
    v.controls.throttle = 1;

    for (let i = 0; i < 2.5 / DT; i++) {
      const before = v.body.angularVelocity.y;
      v.step(DT, ground, ENV);
      const after = v.body.angularVelocity.y;
      // Once the car is genuinely sliding, the aid may only ever calm it.
      if (Math.abs(v.telemetry.slipAngleBody) > 0.3 && Math.abs(before) > 1.5) {
        assert.ok(Math.abs(after) <= Math.abs(before) + 0.25,
          `yaw rate grew from ${before.toFixed(2)} to ${after.toFixed(2)} while sliding`);
      }
    }
  });

  test('the default aids stop the car spinning under provocation', () => {
    const bare = { tractionControl: 0, stabilityControl: 0 };
    const aided = { tractionControl: 0.4, stabilityControl: 0.5 };
    let bareSpins = 0, aidedSpins = 0, cases = 0;

    for (const kmh of [60, 120, 180]) {
      for (const lock of [0.7, 1.0]) {
        const a = provoke(bare, kmh, lock, 1);
        const b = provoke(aided, kmh, lock, 1);
        if (a === null || b === null) continue;
        cases++;
        if (a > 45) bareSpins++;
        if (b > 45) aidedSpins++;
      }
    }
    assert.ok(cases >= 4, 'the sweep should actually have run');
    assert.ok(aidedSpins < bareSpins,
      `aids made no difference: ${aidedSpins}/${cases} spins with, ${bareSpins}/${cases} without`);
    assert.ok(aidedSpins <= 1, `still spun ${aidedSpins} times out of ${cases} with the aids on`);
  });

  test('the driveline cannot run away when a wheel is turned backwards', () => {
    // Engine speed is tied to wheel speed through the gear, and reading that
    // as a magnitude hides the case where the wheels turn the wrong way for
    // the gear — whereupon the driveline drives them harder the further
    // backwards they go.
    const v = makeCar();
    settle(v, ground);
    accelerateTo(v, ground, 80, 30);

    // Force the driven wheels backwards, as a savage downshift or a spin can.
    v.wheels[2].angularVelocity = -40;
    v.wheels[3].angularVelocity = -40;
    v.controls.throttle = 1;

    let worst = 0;
    for (let i = 0; i < 3 / DT; i++) {
      v.step(DT, ground, ENV);
      worst = Math.min(worst, v.wheels[2].angularVelocity, v.wheels[3].angularVelocity);
      assert.ok(Number.isFinite(v.wheels[2].angularVelocity), 'wheel speed went non-finite');
    }
    assert.ok(worst > -200,
      `a driven wheel ran away to ${worst.toFixed(0)} rad/s backwards`);
    assert.ok(v.engine.rpm <= v.engine.maxRpm * 1.25,
      `engine reached ${v.engine.rpm.toFixed(0)} rpm`);
  });
});
