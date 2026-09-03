/**
 * Physics unit tests.
 *
 * These check the behaviours the design brief insists on: grip that peaks and
 * then falls away, a friction ellipse, load sensitivity, temperature and wear
 * that matter, surfaces that differ, and aerodynamics that scale with speed.
 * They are written against the isolated components so a failure points at one
 * model rather than at "the car feels wrong".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Tire, TireCompound, COMPOUNDS, getCompound } from '../src/physics/Tire.js';
import { Aero, solveWakes } from '../src/physics/Aero.js';
import { Vec3 } from '../src/math/Vec3.js';
import { SurfaceType, getSurface } from '../src/physics/Surfaces.js';
import { Engine } from '../src/physics/Engine.js';
import { Transmission } from '../src/physics/Transmission.js';
import { Differential } from '../src/physics/Differential.js';
import { Brakes } from '../src/physics/Brakes.js';
import { CARS, defaultSetup } from '../src/cars/carDefs.js';

const DRY = {
  surfaceType: SurfaceType.ASPHALT, wetness: 0, waterDepth: 0,
  speed: 40, trackRubber: 0.5
};
const ctx = (over = {}) => ({ ...DRY, ...over });

/** A tire at its optimum, so temperature is not a hidden variable. */
function warmTire(compound = TireCompound.MEDIUM) {
  const t = new Tire({ compound });
  t.surfaceTemp = t.compound.optimalTemp;
  t.coreTemp = t.compound.optimalTemp;
  return t;
}

describe('tire: slip curve', () => {
  test('longitudinal grip rises to a peak and then falls away', () => {
    const t = warmTire();
    const load = 3400;
    const sample = (sr) => Math.abs(t.computeForces(load, sr, 0, ctx()).fx);

    const curve = [];
    for (let sr = 0.01; sr <= 1.0; sr += 0.01) curve.push({ sr, fx: sample(sr) });

    let peak = curve[0];
    for (const p of curve) if (p.fx > peak.fx) peak = p;

    // The peak must be at a real slip ratio, not at the end of the sweep.
    assert.ok(peak.sr > 0.02 && peak.sr < 0.35,
      `peak slip ratio ${peak.sr.toFixed(3)} outside a plausible band`);

    // And past it the tire must genuinely lose grip — this is the difference
    // between a simulator and "constant maximum grip".
    const sliding = sample(0.9);
    assert.ok(sliding < peak.fx * 0.92,
      `sliding force ${sliding.toFixed(0)} N is not below the peak ${peak.fx.toFixed(0)} N`);

    // Monotonic rise before the peak.
    const before = curve.filter((p) => p.sr < peak.sr * 0.8);
    for (let i = 1; i < before.length; i++) {
      assert.ok(before[i].fx >= before[i - 1].fx - 1, 'force dips before the peak');
    }
  });

  test('lateral grip peaks at a few degrees of slip angle', () => {
    const t = warmTire();
    const load = 3400;
    let peakDeg = 0; let peakFy = 0;
    for (let deg = 0.25; deg <= 25; deg += 0.25) {
      const fy = Math.abs(t.computeForces(load, 0, deg * Math.PI / 180, ctx()).fy);
      if (fy > peakFy) { peakFy = fy; peakDeg = deg; }
    }
    assert.ok(peakDeg > 3 && peakDeg < 14, `peak slip angle ${peakDeg} deg is not racing-tire-like`);
    const past = Math.abs(t.computeForces(load, 0, 25 * Math.PI / 180, ctx()).fy);
    assert.ok(past < peakFy * 0.92, 'lateral grip does not fall off past the peak');
  });

  test('force signs follow the SAE convention', () => {
    const t = warmTire();
    // Wheel overspeeding the road drives the car forwards.
    assert.ok(t.computeForces(3400, +0.1, 0, ctx()).fx > 0, 'traction should push forwards');
    // Wheel underspeeding (braking) pushes backwards.
    assert.ok(t.computeForces(3400, -0.1, 0, ctx()).fx < 0, 'braking should push backwards');
    // Lateral force opposes the slip angle.
    assert.ok(t.computeForces(3400, 0, +0.05, ctx()).fy < 0, 'lateral force should oppose slip');
    assert.ok(t.computeForces(3400, 0, -0.05, ctx()).fy > 0, 'lateral force should oppose slip');
  });

  test('braking and cornering share one friction budget', () => {
    const t = warmTire();
    const load = 3400;
    const angle = 6 * Math.PI / 180;

    const pureLat = Math.abs(t.computeForces(load, 0, angle, ctx()).fy);
    const combined = t.computeForces(load, -0.12, angle, ctx());
    const combinedLat = Math.abs(combined.fy);

    assert.ok(combinedLat < pureLat * 0.85,
      `lateral grip barely changed under braking (${combinedLat.toFixed(0)} vs ${pureLat.toFixed(0)} N)`);

    // The total never exceeds the friction circle by more than rounding.
    const total = Math.hypot(combined.fx, combined.fy);
    const mu = t.frictionCoefficient(load, SurfaceType.ASPHALT, 0, 0, 40, 0.5);
    assert.ok(total <= mu * load * 1.02,
      `combined force ${total.toFixed(0)} N exceeds the friction circle ${(mu * load).toFixed(0)} N`);
  });
});

describe('tire: load, temperature, wear', () => {
  test('grip coefficient falls as load rises (load sensitivity)', () => {
    const t = warmTire();
    const muLow = t.frictionCoefficient(1700, SurfaceType.ASPHALT, 0, 0, 40, 0.5);
    const muHigh = t.frictionCoefficient(6800, SurfaceType.ASPHALT, 0, 0, 40, 0.5);
    assert.ok(muHigh < muLow, 'mu should drop with load');
    // Force still rises with load — just not proportionally.
    const fLow = Math.abs(t.computeForces(1700, 0, 0.1, ctx()).fy);
    const fHigh = Math.abs(t.computeForces(6800, 0, 0.1, ctx()).fy);
    assert.ok(fHigh > fLow && fHigh < fLow * 4, 'load response should be sub-linear but positive');
  });

  test('cold and overheated tires grip less than a tire in its window', () => {
    const t = warmTire();
    const opt = t.compound.optimalTemp;
    const at = (temp) => {
      t.surfaceTemp = temp; t.coreTemp = temp;
      return Math.abs(t.computeForces(3400, 0, 0.1, ctx()).fy);
    };
    const best = at(opt);
    assert.ok(at(opt - 45) < best * 0.94, 'cold tires should be greasy');
    assert.ok(at(opt + 55) < best * 0.94, 'overheated tires should give up grip');
  });

  test('softer compounds grip more but wear faster', () => {
    const order = [TireCompound.HARD, TireCompound.MEDIUM, TireCompound.SOFT];
    const grip = order.map((k) => {
      const t = warmTire(k);
      return Math.abs(t.computeForces(3400, 0, 0.1, ctx()).fy);
    });
    for (let i = 1; i < grip.length; i++) {
      assert.ok(grip[i] > grip[i - 1], `${order[i]} should grip more than ${order[i - 1]}`);
    }
    const wear = order.map((k) => getCompound(k).wearRate);
    for (let i = 1; i < wear.length; i++) {
      assert.ok(wear[i] > wear[i - 1], `${order[i]} should wear faster than ${order[i - 1]}`);
    }
  });

  test('sliding a tire heats it and wears it', () => {
    const t = warmTire();
    const before = { temp: t.surfaceTemp, wear: t.wear };
    for (let i = 0; i < 600; i++) {                 // 10 s of heavy sliding
      t.computeForces(4000, 0, 0.28, ctx({ speed: 60 }));
      t.update(1 / 60, ctx({ speed: 60 }));
    }
    assert.ok(t.surfaceTemp > before.temp + 5, 'sliding should heat the tread');
    assert.ok(t.wear > before.wear, 'sliding should wear the tire');
    assert.ok(t.wear < 1, 'ten seconds should not destroy the tire outright');
  });

  test('a worn tire has less grip than a fresh one', () => {
    const fresh = warmTire();
    const worn = warmTire();
    worn.wear = 0.85;
    const f = Math.abs(fresh.computeForces(3400, 0, 0.1, ctx()).fy);
    const w = Math.abs(worn.computeForces(3400, 0, 0.1, ctx()).fy);
    assert.ok(w < f * 0.95, `worn tire (${w.toFixed(0)} N) should give up grip vs fresh (${f.toFixed(0)} N)`);
  });

  test('wet weather and standing water cost grip; wets beat slicks in the rain', () => {
    const slick = warmTire(TireCompound.SOFT);
    const dry = slick.frictionCoefficient(3400, SurfaceType.ASPHALT, 0, 0, 40, 0.5);
    const damp = slick.frictionCoefficient(3400, SurfaceType.ASPHALT, 0.6, 0.001, 40, 0.5);
    const flooded = slick.frictionCoefficient(3400, SurfaceType.ASPHALT, 1, 0.006, 70, 0.5);
    assert.ok(damp < dry, 'a wet track should have less grip than a dry one');
    assert.ok(flooded < damp, 'standing water should cost even more grip');

    const wet = warmTire(TireCompound.WET);
    const wetInRain = wet.frictionCoefficient(3400, SurfaceType.ASPHALT, 1, 0.004, 60, 0.5);
    const slickInRain = slick.frictionCoefficient(3400, SurfaceType.ASPHALT, 1, 0.004, 60, 0.5);
    assert.ok(wetInRain > slickInRain, 'wet tires should beat slicks in the rain');
  });

  test('grip is not universal across surfaces', () => {
    const t = warmTire();
    const mu = (s) => t.frictionCoefficient(3400, s, 0, 0, 40, 0.5);
    const asphalt = mu(SurfaceType.ASPHALT);
    assert.ok(mu(SurfaceType.KERB) < asphalt, 'kerbs should be slipperier than asphalt');
    assert.ok(mu(SurfaceType.GRASS) < mu(SurfaceType.KERB), 'grass should be slipperier than kerbs');
    assert.ok(mu(SurfaceType.GRAVEL) < asphalt * 0.6, 'gravel should be a real penalty');
    assert.ok(getSurface(SurfaceType.GRAVEL).rollingResistance >
              getSurface(SurfaceType.ASPHALT).rollingResistance,
      'gravel should drag the car down');
  });
});

describe('aerodynamics', () => {
  const carDef = CARS[0];
  const makeAero = () => new Aero({
    clA: carDef.clA, cdA: carDef.cdA, balance: carDef.aeroBalance
  });
  const RIDE = 0.045;

  test('downforce and drag scale with the square of speed', () => {
    const aero = makeAero();
    const a = aero.computeForces(50, RIDE);
    const df50 = a.downforceFront + a.downforceRear;
    const drag50 = a.drag;
    const b = aero.computeForces(100, RIDE);
    const df100 = b.downforceFront + b.downforceRear;

    assert.ok(df50 > 0 && drag50 > 0, 'there should be aero load at speed');
    assert.ok(df100 / df50 > 3.5 && df100 / df50 < 4.5,
      `doubling speed should roughly quadruple downforce, got ${(df100 / df50).toFixed(2)}x`);
    assert.ok(b.drag / drag50 > 3.5 && b.drag / drag50 < 4.5,
      `doubling speed should roughly quadruple drag, got ${(b.drag / drag50).toFixed(2)}x`);

    // Standing still, the air does nothing at all.
    const still = aero.computeForces(0, RIDE);
    assert.equal(still.downforceFront + still.downforceRear, 0);
  });

  test('at racing speed downforce exceeds the weight of the car', () => {
    const aero = makeAero();
    aero.computeForces(94, RIDE);                      // ~340 km/h
    const gs = aero.downforceInG(carDef.dryMass + 60);
    assert.ok(gs > 1.5, `only ${gs.toFixed(2)} car weights of downforce at 340 km/h`);
  });

  test('the floor works harder close to the road', () => {
    const aero = makeAero();
    const low = aero.computeForces(80, 0.030);
    const lowDf = low.downforceFront + low.downforceRear;
    const high = aero.computeForces(80, 0.090);
    const highDf = high.downforceFront + high.downforceRear;
    assert.ok(lowDf > highDf, 'ground effect should reward a low ride height');
  });

  test('a sliding car loses downforce and gains drag', () => {
    const aero = makeAero();
    const straight = aero.computeForces(70, RIDE, 0);
    const straightDf = straight.downforceFront + straight.downforceRear;
    const straightDrag = straight.drag;
    const sliding = aero.computeForces(70, RIDE, 0.35);
    const slidingDf = sliding.downforceFront + sliding.downforceRear;
    assert.ok(slidingDf < straightDf * 0.9, 'sideslip should stall the floor');
    assert.ok(sliding.drag > straightDrag, 'sideslip should cost drag');
  });

  test('DRS cuts drag and unloads the rear wing', () => {
    const closed = makeAero();
    const open = makeAero();
    const shut = closed.computeForces(90, RIDE);
    // Hold the flap open long enough for the actuator to finish.
    for (let i = 0; i < 30; i++) open.update(1 / 60, true, true);
    const drs = open.computeForces(90, RIDE);

    assert.ok(drs.drag < shut.drag * 0.95,
      `DRS should reduce drag (${drs.drag.toFixed(0)} vs ${shut.drag.toFixed(0)} N)`);
    assert.ok(drs.downforceRear < shut.downforceRear * 0.9, 'DRS should cost rear downforce');
    assert.ok(Math.abs(drs.downforceFront - shut.downforceFront) < shut.downforceFront * 0.02,
      'DRS should leave the front wing alone');
  });

  test('DRS only opens where it is allowed, and takes a moment to actuate', () => {
    const aero = makeAero();
    for (let i = 0; i < 30; i++) aero.update(1 / 60, true, false);   // requested, not allowed
    assert.equal(aero.drsOpen, false, 'DRS must not open outside a zone');
    assert.equal(aero.drsTransition, 0, 'the flap should stay shut');

    aero.update(1 / 60, true, true);
    assert.ok(aero.drsTransition > 0 && aero.drsTransition < 1, 'the flap should move over time');
  });

  test('running close behind gives a tow, and running just off-line gives dirty air', () => {
    const car = (id, x, z) => ({
      id,
      retired: false,
      aero: makeAero(),
      body: {
        position: new Vec3(x, 0, z),
        forward: new Vec3(0, 0, 1),
        right: new Vec3(1, 0, 0),
        speed: 90
      }
    });
    const lead = car('lead', 0, 0);
    const tow = car('tow', 0, -14);
    const off = car('off', 2.6, -14);
    const alone = car('alone', 0, -400);

    solveWakes([lead, tow, off, alone]);
    const f = {};
    for (const c of [lead, tow, off, alone]) f[c.id] = c.aero.computeForces(90, RIDE);

    assert.equal(lead.aero.slipstream, 0, 'the leader runs in clean air');
    assert.equal(lead.aero.dirtyAir, 0, 'the leader runs in clean air');
    assert.equal(alone.aero.slipstream, 0, 'a car 400 m back gets nothing');

    assert.ok(tow.aero.slipstream > 0.2, 'sitting right behind should give a real tow');
    assert.equal(tow.aero.wakeSource, 'lead', 'the tow should be credited to the car ahead');
    assert.ok(f.tow.drag < f.alone.drag * 0.95,
      `slipstream should reduce drag (${f.tow.drag.toFixed(0)} vs ${f.alone.drag.toFixed(0)} N)`);

    assert.ok(off.aero.dirtyAir > 0.05, 'a car just off-line should be in disturbed flow');
    assert.ok(f.off.downforceFront < f.alone.downforceFront * 0.98,
      'dirty air should cost front downforce');

    // Dirty air moves the balance rearward: that is the understeer drivers complain about.
    const cleanBalance = f.alone.downforceFront / (f.alone.downforceFront + f.alone.downforceRear);
    const dirtyBalance = f.off.downforceFront / (f.off.downforceFront + f.off.downforceRear);
    assert.ok(dirtyBalance < cleanBalance, 'following should push the balance towards understeer');
  });

  test('a car going the other way hands out no tow', () => {
    const lead = {
      id: 'lead', retired: false, aero: makeAero(),
      body: { position: new Vec3(0, 0, 0), forward: new Vec3(0, 0, 1), right: new Vec3(1, 0, 0), speed: 90 }
    };
    const oncoming = {
      id: 'oncoming', retired: false, aero: makeAero(),
      body: { position: new Vec3(0, 0, -12), forward: new Vec3(0, 0, -1), right: new Vec3(-1, 0, 0), speed: 90 }
    };
    solveWakes([lead, oncoming]);
    assert.equal(oncoming.aero.slipstream, 0);
  });
});

describe('drivetrain', () => {
  const carDef = CARS[0];

  test('the engine has a real power band', () => {
    const e = new Engine(carDef.engine);
    const power = (rpm) => e.torqueAt(rpm) * rpm * (Math.PI / 30) / 1000;
    let peakRpm = 0; let peakKw = 0;
    for (let rpm = 3000; rpm <= carDef.engine.maxRpm; rpm += 100) {
      const kw = power(rpm);
      if (kw > peakKw) { peakKw = kw; peakRpm = rpm; }
    }
    assert.ok(peakKw > 500 && peakKw < 900, `${peakKw.toFixed(0)} kW is not a formula engine`);
    assert.ok(peakRpm > 9000, 'peak power should be high in the range');
    assert.ok(power(5000) < peakKw * 0.75, 'there should be a genuine cost to being off the band');
  });

  test('the rev limiter cuts drive rather than clamping the revs silently', () => {
    const e = new Engine(carDef.engine);
    e.setThrottle(1);
    for (let i = 0; i < 20; i++) e.update(1 / 60, true);   // settle the throttle lag
    e.rpm = 11000;
    const pulling = e.update(1 / 240, true);
    assert.ok(pulling > 0, 'the engine should pull mid-range');

    e.rpm = carDef.engine.limiterRpm + 50;
    const cut = e.update(1 / 240, true);
    assert.ok(e.limiterActive, 'the limiter should be flagged');
    assert.ok(cut < 0, 'on the limiter the engine should be braking, not driving');
  });

  test('closing the throttle brakes the engine, and burning fuel needs work', () => {
    const e = new Engine(carDef.engine);
    e.setThrottle(0);
    e.throttle = 0;
    e.rpm = 12000;
    const coasting = e.update(1 / 240, true);
    assert.ok(coasting < 0, 'a closed throttle should give engine braking');
    assert.ok(e.fuelUsedThisStep < 1e-4, 'coasting should barely use fuel');

    e.setThrottle(1); e.throttle = 1;
    e.update(1 / 240, true);
    const wot = e.fuelUsedThisStep;
    assert.ok(wot > 0, 'full throttle should burn fuel');

    // A racing lap should cost of the order of a couple of kg, not grams or tens of kg.
    const perLap = wot * 240 * 85;
    assert.ok(perLap > 0.8 && perLap < 5, `${perLap.toFixed(2)} kg/lap is not plausible`);
  });

  test('gear ratios shorten through the box and reverse runs backwards', () => {
    const t = new Transmission(carDef.transmission);
    for (let g = 2; g <= t.topGear; g++) {
      assert.ok(t.ratioFor(g) < t.ratioFor(g - 1), `gear ${g} should be longer than ${g - 1}`);
    }
    assert.ok(t.ratioFor(1) > t.ratioFor(t.topGear) * 2,
      'first should be far shorter than top');
    assert.ok(t.ratioFor(0) < 0, 'reverse should turn the wheels the other way');
  });

  test('a shift cuts the torque path for a moment', () => {
    const t = new Transmission(carDef.transmission);
    assert.ok(t.outputTorque(500) > 0, 'drive should reach the diff in gear');
    assert.equal(t.requestUpshift(), true);
    assert.equal(t.outputTorque(500), 0, 'the torque path should be cut mid-shift');

    let elapsed = 0;
    while (t.isShifting && elapsed < 1) { t.update(1 / 240); elapsed += 1 / 240; }
    assert.ok(!t.isShifting && elapsed < 0.2, 'the shift should complete quickly');
    assert.equal(t.gear, 2, 'the shift should land in the next gear');
    assert.ok(t.outputTorque(500) > 0, 'drive should return after the shift');
  });

  test('taller gears trade acceleration for speed', () => {
    const t = new Transmission(carDef.transmission);
    const wheelTorque = (gear) => t.ratioFor(gear) * 550 * t.efficiency;
    assert.ok(wheelTorque(1) > wheelTorque(t.topGear) * 2,
      'first gear should multiply engine torque far more than top');
  });

  test('the limited-slip diff moves torque to the wheel with grip', () => {
    const d = new Differential(carDef.differential);

    const even = d.split(600, 100, 100);
    assert.ok(Math.abs(even.left - even.right) < 1e-9, 'equal speeds should split evenly');
    assert.ok(Math.abs(even.left + even.right - 600) < 1e-6, 'the diff should conserve torque');

    // Left wheel spinning up on the exit of a corner.
    const spinning = d.split(600, 130, 100);
    assert.ok(spinning.right > spinning.left,
      'the gripping wheel should get the larger share');
    assert.ok(Math.abs(spinning.left + spinning.right - 600) < 1e-6,
      'transfer should move torque, not create it');
    assert.ok(d.lockTorque > 0 && d.transferTorque > 0, 'the clutch pack should be loaded');

    // The transfer is bounded by the ramp, so it is not a locked axle.
    const violent = d.split(600, 400, 100);
    assert.ok(Math.abs(violent.transferTorque ?? d.transferTorque) <= d.lockTorque + 1e-9,
      'transfer should be capped by the locking torque');
  });

  test('brake balance and temperature both change the stop', () => {
    const b = new Brakes({ ...carDef.brakes, balance: 0.60 });
    // Bring the discs into their window.
    b.temps = [b.optimalTemp, b.optimalTemp, b.optimalTemp, b.optimalTemp];
    const front = b.torqueAt(0, 1, true);
    const rear = b.torqueAt(2, 1, false);
    assert.ok(front > rear, 'a forward bias should brake the front harder');

    const rearward = new Brakes({ ...carDef.brakes, balance: 0.50 });
    rearward.temps = [...b.temps];
    assert.ok(rearward.torqueAt(2, 1, false) > rear, 'moving the bias back should load the rear');

    b.temps[0] = b.ambient + 20;                       // stone cold front-left
    assert.ok(b.torqueAt(0, 1, true) < front * 0.7, 'cold carbon should be weak');

    b.temps[0] = b.fadeTemp + 300;                     // cooked
    assert.ok(b.torqueAt(0, 1, true) < front * 0.9, 'overheated brakes should fade');
  });

  test('braking work heats the discs and airflow cools them', () => {
    const b = new Brakes(carDef.brakes);
    const start = b.temps[0];
    for (let i = 0; i < 120; i++) b.update(1 / 60, [220000, 220000, 90000, 90000], 60);
    assert.ok(b.temps[0] > start + 50, 'a heavy stop should heat the fronts');
    assert.ok(b.temps[0] > b.temps[2], 'the fronts should run hotter than the rears');

    const hot = b.temps[0];
    for (let i = 0; i < 600; i++) b.update(1 / 60, [0, 0, 0, 0], 80);
    assert.ok(b.temps[0] < hot, 'the discs should cool down a straight');
  });
});
