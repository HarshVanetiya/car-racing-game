import { Vec3 } from '../math/Vec3.js';
import { TrackModel } from '../track/TrackModel.js';
import { Vehicle, createAssists } from '../physics/Vehicle.js';
import { solveWakes } from '../physics/Aero.js';
import { solveCollisions } from '../physics/Collision.js';
import { AIDriver } from '../ai/AIDriver.js';
import { Weather, WeatherState } from './Weather.js';
import { RaceDirector, RacePhase, SessionType, DriverStatus } from './RaceDirector.js';
import { getCar, CARS, defaultSetup } from '../cars/carDefs.js';
import { makeRng } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  RACE SESSION
 * ============================================================================
 *
 * The simulation world: track, weather, cars, AI, collisions, aerodynamic
 * interaction and the race director, advanced together on a fixed timestep.
 *
 * The SAME class runs in the browser and on the Node server. That is the whole
 * point — an AI car on the server and the player's car in the browser are
 * stepped by identical code, so there is no second physics model to keep in
 * agreement with the first.
 */

/** Physics substep. Fixed, and small enough for the stiff suspension rates. */
export const PHYSICS_DT = 1 / 240;
/** Never simulate more than this much wall time in one frame. */
const MAX_FRAME_TIME = 0.25;

export class RaceSession {
  constructor(opts = {}) {
    this.track = opts.track || new TrackModel();
    this.seed = opts.seed ?? 20260903;
    this.rng = makeRng(this.seed);

    this.weather = new Weather(this.track, {
      initial: opts.weather || WeatherState.DRY,
      dynamic: opts.dynamicWeather ?? false,
      seed: this.seed ^ 0x5f3759df
    });

    this.director = new RaceDirector(this.track, {
      sessionType: opts.sessionType || SessionType.RACE,
      totalLaps: opts.totalLaps ?? 8,
      sessionDuration: opts.sessionDuration ?? 0,
      rules: opts.rules,
      weather: this.weather
    });

    this.collisionsEnabled = opts.collisions !== false;
    this.damageEnabled = opts.damage !== false;
    this.tireWearScale = opts.tireWearScale ?? 1;
    this.fuelScale = opts.fuelScale ?? 1;

    this.vehicles = [];
    this.aiDrivers = [];
    this.accumulator = 0;
    this.elapsed = 0;
    this.stepCount = 0;

    // Events raised this frame, consumed by audio, HUD and the network layer.
    this.frameEvents = [];
    this.impacts = [];
  }

  // -------------------------------------------------------------------------
  //  Entrants
  // -------------------------------------------------------------------------

  /**
   * @param {object} spec {
   *   id, name, carId, setup, isPlayer, isAI, isRemote, skill, assists,
   *   gridPosition, colour, number
   * }
   */
  addDriver(spec) {
    const carDef = getCar(spec.carId || CARS[0].id);
    const setup = { ...defaultSetup(carDef), ...(spec.setup || {}) };

    const vehicle = new Vehicle(carDef, setup, {
      id: spec.id,
      driverName: spec.name,
      isPlayer: spec.isPlayer,
      isAI: spec.isAI,
      isRemote: spec.isRemote,
      colour: spec.colour || carDef.colour,
      seed: (this.seed + spec.id.length * 7919) | 0,
      assists: spec.assists,
      damageEnabled: this.damageEnabled,
      ambientTemp: this.weather.ambientTemp,
      trackTemp: this.weather.trackTemp,
      pitLimiterSpeed: this.track.pit.speedLimit
    });

    let ai = null;
    if (spec.isAI) {
      ai = new AIDriver(vehicle, this.track, {
        skill: spec.skill || 'pro',
        seed: (this.seed ^ (spec.id.length * 104729)) | 0,
        compound: setup.compound
      });
      this.aiDrivers.push(ai);
    }

    const entry = this.director.addDriver(spec.id, {
      name: spec.name,
      shortName: spec.shortName,
      number: spec.number,
      team: carDef.team,
      colour: spec.colour || carDef.colour,
      isPlayer: spec.isPlayer,
      isAI: spec.isAI,
      isRemote: spec.isRemote,
      vehicle,
      ai,
      gridPosition: spec.gridPosition ?? this.vehicles.length + 1
    });

    entry.tireStrategy.push({ lap: 0, compound: setup.compound });
    this.vehicles.push(vehicle);
    return entry;
  }

  removeDriver(id) {
    const entry = this.director.get(id);
    if (!entry) return;
    const vi = this.vehicles.indexOf(entry.vehicle);
    if (vi >= 0) this.vehicles.splice(vi, 1);
    const ai = this.aiDrivers.indexOf(entry.ai);
    if (ai >= 0) this.aiDrivers.splice(ai, 1);
    this.director.removeDriver(id);
  }

  // -------------------------------------------------------------------------
  //  Session lifecycle
  // -------------------------------------------------------------------------

  /** Put the field on the grid and arm the lights. */
  startRace(countdownDelay = 1.5) {
    this.director.formGrid();
    this._preheatTires();
    this.director.startCountdown(countdownDelay);
  }

  /** Roll straight into a session with no grid — practice, time trial. */
  startSession() {
    this.director.formGrid();
    this._preheatTires();
    this.director.startImmediately();
  }

  _preheatTires() {
    const compound = this.weather.recommendedCompound();
    for (const entry of this.director.drivers) {
      const v = entry.vehicle;
      // Only auto-fit a weather-appropriate tire where the driver has not
      // deliberately chosen one.
      const wet = this.weather.averageWetness > 0.2;
      const useCompound = wet ? compound : v.compound;
      for (const w of v.wheels) w.tire.reset(useCompound, true);
      v.currentCompound = useCompound;
      entry.tireStrategy[0] = { lap: 0, compound: useCompound };
    }
  }

  // -------------------------------------------------------------------------
  //  Stepping
  // -------------------------------------------------------------------------

  /**
   * Advance by real elapsed time, running as many fixed physics substeps as
   * needed. A fixed step matters here beyond the usual stability argument: it
   * is what lets the server and every client agree about what the cars did.
   */
  update(frameTime, beforeStep = null) {
    this.frameEvents.length = 0;
    this.impacts.length = 0;

    const dt = Math.min(frameTime, MAX_FRAME_TIME);
    this.accumulator += dt;

    let steps = 0;
    while (this.accumulator >= PHYSICS_DT && steps < 32) {
      // The driver's inputs are advanced per step rather than per frame, so
      // the controls stay smooth even when frames are long and several steps
      // run back to back.
      if (beforeStep) beforeStep(PHYSICS_DT);
      this.step(PHYSICS_DT);
      this.accumulator -= PHYSICS_DT;
      steps++;
    }
    // Interpolation factor for the renderer, so motion stays smooth when the
    // display refresh and the physics rate do not divide evenly.
    this.alpha = this.accumulator / PHYSICS_DT;
    return steps;
  }

  /** One fixed physics step. */
  step(dt) {
    this.elapsed += dt;
    this.stepCount++;

    const env = this.weather.environment();
    env.tireWearScale = this.tireWearScale;

    // --- 1. Aerodynamic interaction ----------------------------------------
    // Slipstream and dirty air are solved across the whole field before any car
    // computes its own forces, so both cars in a tow always agree about it.
    solveWakes(this.vehicles);

    // --- 2. Driver inputs ---------------------------------------------------
    const phase = this.director.phase;
    const racing = phase === RacePhase.RACING || phase === RacePhase.CHECKERED;

    for (const entry of this.director.drivers) {
      const v = entry.vehicle;
      if (!v) continue;

      if (entry.ai) {
        if (racing) {
          entry.ai.update(dt, this._aiContext(entry, env));
        } else {
          // Held on the grid: engine running, brakes on.
          v.controls.throttle = phase === RacePhase.COUNTDOWN ? 0.1 : 0;
          v.controls.brake = 1;
          v.controls.steer = 0;
        }
      }

      // A car that has taken the flag must not fight anyone still racing.
      if (entry.status === DriverStatus.FINISHED) {
        v.controls.throttle = Math.min(v.controls.throttle, 0.25);
        v.controls.drs = false;
      }
    }

    // --- 3. Physics ---------------------------------------------------------
    for (const v of this.vehicles) v.step(dt, this.track, env);

    // --- 4. Contacts --------------------------------------------------------
    const impacts = solveCollisions(this.vehicles, this.track, {
      collisions: this.collisionsEnabled,
      iterations: 3
    });
    if (impacts.length) this.impacts.push(...impacts);

    // --- 5. Race state ------------------------------------------------------
    this.director.update(dt);

    // --- 6. Weather and track evolution ------------------------------------
    this.weather.update(dt, this.vehicles);

    // --- 7. Collect events --------------------------------------------------
    this._collectEvents();
  }

  /** Build the situational context an AI driver needs. */
  _aiContext(entry, env) {
    if (!this._aiCarsScratch) this._aiCarsScratch = [];
    const cars = this._aiCarsScratch;
    cars.length = 0;
    for (const other of this.director.drivers) {
      cars.push({
        id: other.id,
        vehicle: other.vehicle,
        progress: { distance: other.distance, lateral: other.lateral, lap: other.lap },
        racePosition: other.position
      });
    }
    return {
      env,
      progress: { distance: entry.distance, lateral: entry.lateral, lap: entry.lap },
      cars,
      raceState: {
        totalLaps: this.director.totalLaps,
        phase: this.director.phase,
        weather: { wetness: env.wetness }
      },
      phase: this.director.phase
    };
  }

  _collectEvents() {
    for (const e of this.director.events) this.frameEvents.push(e);
    for (const entry of this.director.drivers) {
      for (const ev of entry.events) {
        this.frameEvents.push({ ...ev, driver: entry.id, name: entry.name });
      }
      if (entry.vehicle) {
        for (const ev of entry.vehicle.events) {
          this.frameEvents.push({ ...ev, driver: entry.id });
        }
      }
    }
    for (const ev of this.weather.events) this.frameEvents.push(ev);
  }

  // -------------------------------------------------------------------------
  //  Queries
  // -------------------------------------------------------------------------

  get phase() { return this.director.phase; }
  get standings() { return this.director.standings(); }
  get classification() { return this.director.classification(); }

  getEntry(id) { return this.director.get(id); }

  playerEntry() {
    return this.director.drivers.find((e) => e.isPlayer) || null;
  }

  /** Full state snapshot, for the network layer. */
  serialize() {
    return {
      t: Math.round(this.elapsed * 1000) / 1000,
      race: this.director.serialize(),
      weather: this.weather.serialize(),
      cars: this.director.drivers.map((e) => ({
        id: e.id,
        s: e.vehicle ? e.vehicle.serializeState() : null,
        lap: e.lap,
        sec: e.sector,
        d: Math.round(e.distance * 10) / 10,
        pos: e.position,
        st: e.status,
        pen: e.penaltySeconds,
        pit: e.pitStops,
        tyre: e.vehicle ? e.vehicle.wheels[0].tire.serialize() : null,
        dmg: e.vehicle ? e.vehicle.damage.serialize() : null,
        fuel: e.vehicle ? Math.round(e.vehicle.fuel * 10) / 10 : 0,
        last: e.timing.lastLap,
        best: e.timing.bestLap,
        drs: e.drsAvailable ? 1 : 0
      }))
    };
  }
}
