import { clamp, clamp01, lerp, wrapRange, circularDelta, formatLapTime } from '../math/MathUtils.js';
import { DriverTiming, SessionRecords } from './Timing.js';
import { TireCompound } from '../physics/Tire.js';
import { SurfaceType } from '../physics/Surfaces.js';

/**
 * ============================================================================
 *  RACE DIRECTOR
 * ============================================================================
 *
 * The authority on everything that is not physics: what phase the session is
 * in, who is where, who has been where they should not have been, and when it
 * is over.
 *
 * In multiplayer this runs on the server and its verdicts are final — clients
 * simulate their own car for responsiveness, but position, lap count, penalties
 * and the finishing order all come from here.
 */

export const RacePhase = {
  LOBBY: 'lobby',
  LOADING: 'loading',
  FORMATION: 'formation',   // rolling to the grid
  GRID: 'grid',             // stationary, engines running
  COUNTDOWN: 'countdown',   // starting lights
  RACING: 'racing',
  CHECKERED: 'checkered',   // leader has finished; others still running
  FINISHED: 'finished',
  PAUSED: 'paused'
};

export const SessionType = {
  PRACTICE: 'practice',
  QUALIFYING: 'qualifying',
  RACE: 'race',
  TIME_TRIAL: 'timeTrial'
};

export const DriverStatus = {
  RUNNING: 'running',
  PIT_LANE: 'pitLane',
  PIT_BOX: 'pitBox',
  FINISHED: 'finished',
  RETIRED: 'retired',
  DNF: 'dnf',
  SPECTATING: 'spectating'
};

export const PenaltyType = {
  TIME: 'time',                 // seconds added at the finish
  DRIVE_THROUGH: 'driveThrough',
  WARNING: 'warning'
};

/** Default rule configuration; every item is switchable from the lobby. */
export function defaultRules() {
  return {
    trackLimits: true,
    trackLimitWarnings: 3,
    trackLimitPenaltySeconds: 5,
    jumpStart: true,
    jumpStartPenaltySeconds: 5,
    pitSpeedLimit: true,
    pitSpeedPenaltySeconds: 5,
    collisionPenalties: false,
    unsafeRejoin: true,
    mandatoryPitStop: false,
    drsEnabled: true,
    drsDetectionGap: 1.0,
    // Laps at the start of the race during which DRS is not permitted.
    drsEnabledFromLap: 2,
    recoveryEnabled: true,
    recoveryDelaySeconds: 4.0,
    recoveryPenaltySeconds: 0,
    parcFermeSetup: false
  };
}

/** One driver's complete race state. */
export class DriverEntry {
  constructor(id, opts = {}) {
    this.id = id;
    this.name = opts.name || 'Driver';
    this.shortName = (opts.shortName || this.name.slice(0, 3)).toUpperCase();
    this.number = opts.number ?? 0;
    this.team = opts.team || '';
    this.colour = opts.colour || '#cccccc';
    this.isPlayer = !!opts.isPlayer;
    this.isAI = !!opts.isAI;
    this.isRemote = !!opts.isRemote;

    this.vehicle = opts.vehicle || null;
    this.ai = opts.ai || null;

    this.timing = new DriverTiming(3);
    this.status = DriverStatus.RUNNING;

    // Progress
    this.lap = 0;
    this.sector = 0;
    this.distance = 0;          // metres around the current lap
    this.lateral = 0;
    this.totalDistance = 0;     // lap * trackLength + distance; the ranking key
    this.position = opts.gridPosition ?? 1;
    this.gridPosition = opts.gridPosition ?? 1;
    this.startPosition = this.gridPosition;

    // Gaps
    this.gapToLeader = 0;
    this.gapAhead = 0;
    this.gapBehind = 0;
    this.lapsDown = 0;
    this.intervalAhead = Infinity;

    // Rules
    this.penalties = [];
    this.penaltySeconds = 0;
    this.trackLimitWarnings = 0;
    this.servedPenalties = 0;
    this._offTrackTimer = 0;
    this._offTrackGain = 0;

    // Pit
    this.pitStops = 0;
    this.tireStrategy = [];
    this.pitRequest = null;
    this.pitTimer = 0;
    this.inPitLane = false;
    this.pitEntryTime = 0;
    this.pitLaneTime = 0;
    this.mandatoryStopDone = false;

    // DRS
    this.drsEligible = false;
    this.drsAvailable = false;
    this.drsZone = null;
    this.gapAtDetection = Infinity;

    // Finish
    this.finished = false;
    this.finishTime = null;
    this.classified = false;
    this.totalRaceTime = 0;

    // Recovery
    this.stuckTimer = 0;
    this.recoveries = 0;

    this.events = [];
  }

  addPenalty(type, seconds, reason) {
    const p = { type, seconds, reason, served: false, time: Date.now() };
    this.penalties.push(p);
    if (type === PenaltyType.TIME) this.penaltySeconds += seconds;
    this.events.push({ type: 'penalty', penalty: p });
    return p;
  }

  get compound() {
    return this.vehicle ? this.vehicle.compound : TireCompound.MEDIUM;
  }
}

export class RaceDirector {
  /**
   * @param {TrackModel} track
   * @param {object} opts { sessionType, totalLaps, rules, weather }
   */
  constructor(track, opts = {}) {
    this.track = track;
    this.sessionType = opts.sessionType || SessionType.RACE;
    this.totalLaps = opts.totalLaps ?? 10;
    this.sessionDuration = opts.sessionDuration ?? 0;  // seconds, 0 = lap-limited
    this.rules = { ...defaultRules(), ...(opts.rules || {}) };
    this.weather = opts.weather || null;

    this.phase = RacePhase.GRID;
    this.time = 0;              // session clock
    this.raceTime = 0;          // time since the lights went out
    this.entries = new Map();
    this.order = [];            // driver ids, leader first
    this.records = new SessionRecords(3);

    this.countdownLights = 0;   // 0..5 lights illuminated
    this.countdownTimer = 0;
    this.lightsOutDelay = 0;

    this.leaderFinished = false;
    this.finishOrder = [];
    this.events = [];
    this.raceStartTime = 0;

    this._projScratch = {};
  }

  // -------------------------------------------------------------------------
  //  Entries
  // -------------------------------------------------------------------------

  addDriver(id, opts) {
    const entry = new DriverEntry(id, opts);
    this.entries.set(id, entry);
    this._reorder();
    return entry;
  }

  removeDriver(id) {
    this.entries.delete(id);
    this._reorder();
  }

  get(id) { return this.entries.get(id); }
  get drivers() { return [...this.entries.values()]; }
  get leader() { return this.entries.get(this.order[0]); }

  // -------------------------------------------------------------------------
  //  Session control
  // -------------------------------------------------------------------------

  /** Place every car on its grid slot and arm the countdown. */
  formGrid() {
    const slots = this.track.gridSlots;
    const sorted = this.drivers.sort((a, b) => a.gridPosition - b.gridPosition);
    sorted.forEach((entry, i) => {
      const slot = slots[Math.min(i, slots.length - 1)];
      entry.gridPosition = i + 1;
      entry.startPosition = i + 1;
      entry.position = i + 1;
      if (entry.vehicle) {
        entry.vehicle.placeAt(slot.position, slot.heading);
        entry.vehicle.body.position.y += 0.04;
        entry.vehicle.controls.handbrake = 1;
      }
      const p = this.track.project(slot.position.x, slot.position.z, {});
      entry.distance = p.distance;
      entry.lap = 0;
      // The grid sits behind the line, so the first crossing is the start of
      // lap 1. Rank them behind the line until then.
      entry._awaitingFirstCrossing = true;
      entry.totalDistance = p.distance - this.track.length;
    });
    this.phase = RacePhase.GRID;
    this._reorder();
  }

  /** Begin the starting-light sequence. */
  startCountdown(delay = 1.5) {
    this.phase = RacePhase.COUNTDOWN;
    this.countdownTimer = 0;
    this.countdownLights = 0;
    // Lights go out after a variable hold, as they do in reality — which is
    // what makes a start a reaction test rather than a memorised rhythm.
    this.lightsOutDelay = 5 * 1.0 + delay + Math.random() * 1.6;
    this.events.push({ type: 'countdownStart' });
  }

  /** Skip the grid entirely — used by practice, time trial and quick starts. */
  startImmediately() {
    this.phase = RacePhase.RACING;
    this.raceTime = 0;
    this.raceStartTime = this.time;
    for (const e of this.drivers) {
      e.timing.start(0);
      e.timing.outLap = this.sessionType !== SessionType.RACE;
      // A rolling or free-practice start is already past the line.
      e._awaitingFirstCrossing = false;
      if (e.vehicle) e.vehicle.controls.handbrake = 0;
    }
    this.events.push({ type: 'sessionStart' });
  }

  // -------------------------------------------------------------------------
  //  Main update
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt seconds
   */
  update(dt) {
    this.events.length = 0;
    this.time += dt;
    for (const e of this.drivers) e.events.length = 0;

    switch (this.phase) {
      case RacePhase.COUNTDOWN: this._updateCountdown(dt); break;
      case RacePhase.RACING:
      case RacePhase.CHECKERED: this.raceTime += dt; break;
      default: break;
    }

    // Progress and timing are tracked in every phase so the grid and formation
    // laps report sensible positions.
    for (const entry of this.drivers) {
      this._updateProgress(entry, dt);
    }

    this._reorder();
    this._updateGaps();

    if (this.phase === RacePhase.RACING || this.phase === RacePhase.CHECKERED) {
      for (const entry of this.drivers) {
        this._updateRules(entry, dt);
        this._updatePit(entry, dt);
        this._updateRecovery(entry, dt);
      }
      this._updateDRS();
      this._checkFinish();
    } else if (this.phase === RacePhase.GRID || this.phase === RacePhase.COUNTDOWN) {
      this._checkJumpStart(dt);
    }
  }

  _updateCountdown(dt) {
    this.countdownTimer += dt;
    // One light per second, then a variable hold before they all go out.
    const lights = Math.min(5, Math.floor(this.countdownTimer));
    if (lights !== this.countdownLights && lights <= 5) {
      this.countdownLights = lights;
      this.events.push({ type: 'light', count: lights });
    }
    if (this.countdownTimer >= this.lightsOutDelay) {
      this.phase = RacePhase.RACING;
      this.raceTime = 0;
      this.raceStartTime = this.time;
      this.countdownLights = 0;
      for (const e of this.drivers) {
        e.timing.start(0);
        e.timing.outLap = false;
        if (e.vehicle) e.vehicle.controls.handbrake = 0;
      }
      this.events.push({ type: 'lightsOut' });
    }
  }

  /**
   * Update a driver's position on the circuit and their timing.
   *
   * Race progress is measured as total distance travelled along the track —
   * completed laps times the circuit length plus the distance around the
   * current lap. Ranking by that, rather than by anything to do with world
   * position, is what makes the order correct when cars are lapped, spread out,
   * or momentarily off the road.
   */
  _updateProgress(entry, dt) {
    const v = entry.vehicle;
    if (!v) return;

    const prev = entry.distance;
    const p = this.track.project(v.position.x, v.position.z, this._projScratch);
    entry.distance = p.distance;
    entry.lateral = p.lateral;
    entry.onTrack = p.onTrack;

    const L = this.track.length;
    const delta = circularDelta(prev, entry.distance, L);
    // A crossing is a forward step over the line, not merely a small distance.
    const crossedLine = delta > 0 && prev > L * 0.75 && entry.distance < L * 0.25;

    if (crossedLine && entry.status !== DriverStatus.FINISHED) {
      if (entry._awaitingFirstCrossing) {
        // A standing start places the cars behind the start/finish line, so the
        // first time they cross it they are STARTING lap 1, not completing it.
        // Counting it as a completed lap would both shorten the race by a lap
        // and record a nonsense six-second opening lap time.
        entry._awaitingFirstCrossing = false;
        entry.timing.lapStartTime = this.raceTime;
        entry.timing.sectorStartTime = this.raceTime;
        entry.timing.currentSector = 0;
        entry.timing.currentSectors.fill(null);
        entry.timing.outLap = false;
        return;
      }
      entry.lap++;
    }

    entry.sector = this.track.sectorAtDistance(entry.distance);
    entry.totalDistance = entry.lap * L + entry.distance;

    if (this.phase === RacePhase.RACING || this.phase === RacePhase.CHECKERED) {
      const ev = entry.timing.update(this.raceTime, entry.sector, crossedLine);
      if (ev) this._handleTimingEvent(entry, ev);
    }

    // Speed trap
    for (const trap of this.track.speedTraps) {
      const crossedTrap = circularDelta(prev, trap.distance, L) > 0 &&
                          circularDelta(entry.distance, trap.distance, L) <= 0 &&
                          Math.abs(delta) < 200;
      if (crossedTrap) {
        this.records.submitSpeedTrap(entry.id, entry.name, v.speedKmh);
        entry.lastTrapSpeed = v.speedKmh;
      }
    }

    // Keep the vehicle informed about the pit lane so its limiter can engage.
    entry.inPitLane = this.track.isInPitLane(v.position.x, v.position.z);
    v.inPitLane = entry.inPitLane;
  }

  _handleTimingEvent(entry, ev) {
    if (ev.type === 'sector') {
      const isBest = this.records.submitSector(entry.id, entry.name, ev.sector, ev.time);
      entry.events.push({ type: 'sector', sector: ev.sector, time: ev.time,
                          personalBest: ev.best, sessionBest: isBest });
    } else if (ev.type === 'lap' || ev.type === 'personalBest') {
      const fastest = this.records.submitLap(entry.id, entry.name, ev.lapTime, ev.lap);
      // The last sector is closed by the line crossing rather than by a sector
      // transition, so submit the completed set here or the session's best
      // final sector — and with it the theoretical best — is never recorded.
      entry.timing.lastSectors.forEach((st, i) => {
        this.records.submitSector(entry.id, entry.name, i, st);
      });
      entry.events.push({
        type: 'lapComplete', lapTime: ev.lapTime, lap: ev.lap,
        personalBest: ev.type === 'personalBest', fastestLap: fastest
      });
      if (fastest) {
        this.events.push({
          type: 'fastestLap', driver: entry.id, name: entry.name, lapTime: ev.lapTime
        });
      }
      // Ask the AI whether it wants to pit, once per lap.
      if (entry.ai && !entry.pitRequest && entry.status === DriverStatus.RUNNING) {
        const decision = entry.ai.considerPitStop(this, entry);
        if (decision.pit) {
          entry.pitRequest = { compound: decision.compound, reason: decision.reason };
        }
      }
    }
  }

  /** Rank by race progress, with finishers frozen in their finishing order. */
  _reorder() {
    const list = this.drivers;
    list.sort((a, b) => {
      const aFin = a.status === DriverStatus.FINISHED;
      const bFin = b.status === DriverStatus.FINISHED;
      if (aFin && bFin) return a.finishTime - b.finishTime;
      if (aFin) return -1;
      if (bFin) return 1;
      const aOut = a.status === DriverStatus.RETIRED || a.status === DriverStatus.DNF;
      const bOut = b.status === DriverStatus.RETIRED || b.status === DriverStatus.DNF;
      if (aOut !== bOut) return aOut ? 1 : -1;
      // Qualifying and time trial rank by best lap, not by track position.
      if (this.sessionType === SessionType.QUALIFYING ||
          this.sessionType === SessionType.TIME_TRIAL) {
        const al = a.timing.bestLap ?? Infinity;
        const bl = b.timing.bestLap ?? Infinity;
        if (al !== bl) return al - bl;
        return a.gridPosition - b.gridPosition;
      }
      return b.totalDistance - a.totalDistance;
    });
    this.order = list.map((e) => e.id);
    list.forEach((e, i) => { e.position = i + 1; });
  }

  /**
   * Gaps in seconds, estimated from the distance between cars and the speed of
   * the car behind — which is how a real timing screen does it.
   */
  _updateGaps() {
    const list = this.order.map((id) => this.entries.get(id));
    if (list.length === 0) return;
    const leader = list[0];
    const L = this.track.length;

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const v = e.vehicle;
      const speed = Math.max(12, v ? v.speed : 40);

      if (i === 0) {
        e.gapToLeader = 0;
        e.intervalAhead = 0;
        e.lapsDown = 0;
      } else {
        const behindLeader = leader.totalDistance - e.totalDistance;
        e.lapsDown = Math.floor(behindLeader / L);
        e.gapToLeader = (behindLeader % L) / speed;
        const ahead = list[i - 1];
        const gapDist = ahead.totalDistance - e.totalDistance;
        e.intervalAhead = (gapDist % L) / speed;
        e.gapAhead = e.intervalAhead;
      }
      if (i < list.length - 1) {
        const behind = list[i + 1];
        const d = e.totalDistance - behind.totalDistance;
        const bs = Math.max(12, behind.vehicle ? behind.vehicle.speed : 40);
        e.gapBehind = (d % L) / bs;
      } else {
        e.gapBehind = Infinity;
      }
    }

    if (this.sessionType === SessionType.QUALIFYING ||
        this.sessionType === SessionType.TIME_TRIAL) {
      const best = leader.timing.bestLap;
      for (const e of list) {
        e.gapToLeader = (e.timing.bestLap != null && best != null)
          ? e.timing.bestLap - best : Infinity;
      }
    }
  }

  // -------------------------------------------------------------------------
  //  Rules
  // -------------------------------------------------------------------------

  _updateRules(entry, dt) {
    const v = entry.vehicle;
    if (!v || entry.status === DriverStatus.FINISHED ||
        entry.status === DriverStatus.RETIRED) return;

    // --- Track limits -------------------------------------------------------
    // A minor excursion is not policed. What matters is being fully off the
    // racing surface for long enough to have gained something by it.
    if (this.rules.trackLimits && !entry.inPitLane) {
      const halfWidth = this.track.widthAtDistance(entry.distance) * 0.5;
      const kerbEdge = halfWidth + this.track.circuit.KERB_WIDTH;
      const beyond = Math.abs(entry.lateral) - kerbEdge;

      // Leaving the circuit because you have just spun, been hit, or are
      // rejoining is not a track-limits offence — stewards judge the ones where
      // a driver went off and gained by it. Without this exclusion a single
      // incident collects penalties all the way through the recovery.
      const inIncident = v.telemetry.oversteer > 0.7 ||
                         v.telemetry.slipAngleBody > 0.45 ||
                         entry.stuckTimer > 0.5 ||
                         (this.raceTime - (entry._lastRecoverTime ?? -999)) < 6;

      if (beyond > 0.35 && v.speed > 12 && !inIncident) {
        entry._offTrackTimer += dt;
        // Only count it as an advantage if the car is going quickly enough
        // that cutting could plausibly have helped.
        entry._offTrackGain += dt * clamp01(v.speed / 40);
        if (entry._offTrackTimer > 0.55 && !entry._offTrackFlagged) {
          entry._offTrackFlagged = true;
          entry.timing.invalidate();
          entry.trackLimitWarnings++;
          entry.events.push({
            type: 'trackLimits', warnings: entry.trackLimitWarnings
          });
          if (entry.trackLimitWarnings >= this.rules.trackLimitWarnings) {
            entry.trackLimitWarnings = 0;
            entry.addPenalty(
              PenaltyType.TIME, this.rules.trackLimitPenaltySeconds,
              'Track limits'
            );
          }
        }
      } else {
        entry._offTrackTimer = Math.max(0, entry._offTrackTimer - dt * 2);
        if (entry._offTrackTimer <= 0) entry._offTrackFlagged = false;
      }
    }

    // --- Pit lane speed limit ----------------------------------------------
    if (this.rules.pitSpeedLimit && entry.inPitLane) {
      const limit = this.track.pit.speedLimit;
      if (v.speed > limit * 1.06) {
        entry._pitSpeedTimer = (entry._pitSpeedTimer || 0) + dt;
        if (entry._pitSpeedTimer > 0.4 && !entry._pitSpeedFlagged) {
          entry._pitSpeedFlagged = true;
          entry.addPenalty(
            PenaltyType.TIME, this.rules.pitSpeedPenaltySeconds,
            'Pit lane speeding'
          );
        }
      } else {
        entry._pitSpeedTimer = 0;
      }
    } else {
      entry._pitSpeedFlagged = false;
    }

    // --- Retirement ---------------------------------------------------------
    if (v.retired && entry.status !== DriverStatus.DNF) {
      entry.status = DriverStatus.DNF;
      entry.events.push({ type: 'dnf', reason: 'damage' });
      this.events.push({ type: 'retirement', driver: entry.id, name: entry.name });
    }
  }

  // -------------------------------------------------------------------------
  //  Pit stops
  // -------------------------------------------------------------------------

  /** Request a stop; it is serviced when the car reaches its box. */
  requestPitStop(id, compound, repair = false) {
    const e = this.entries.get(id);
    if (!e) return false;
    e.pitRequest = { compound, repair };
    return true;
  }

  cancelPitStop(id) {
    const e = this.entries.get(id);
    if (e) e.pitRequest = null;
  }

  _updatePit(entry, dt) {
    const v = entry.vehicle;
    if (!v) return;

    if (entry.inPitLane) {
      if (entry.status === DriverStatus.RUNNING) {
        entry.status = DriverStatus.PIT_LANE;
        entry.pitEntryTime = this.raceTime;
        entry.events.push({ type: 'pitEntry' });
      }
      entry.pitLaneTime = this.raceTime - entry.pitEntryTime;

      // Reaching the box: close to the assigned pit box and slow enough.
      const box = this.track.pit.boxes[
        Math.min(entry.gridPosition - 1, this.track.pit.boxes.length - 1)
      ];
      if (box && entry.status === DriverStatus.PIT_LANE && entry.pitRequest) {
        const d = v.position.distanceTo(box.position);
        if (d < 4.0 && v.speed < 6) {
          entry.status = DriverStatus.PIT_BOX;
          // Service time: the tire change plus any repairs, both real costs.
          const repairTime = entry.pitRequest.repair ? v.damage.repairTime() : 0;
          entry.pitTimer = this.track.pit.serviceTime +
                           this.track.pit.stopOverhead + repairTime;
          entry.events.push({ type: 'pitStopStart', duration: entry.pitTimer });
        }
      }

      if (entry.status === DriverStatus.PIT_BOX) {
        // Hold the car stationary while it is being worked on.
        v.controls.throttle = 0;
        v.controls.brake = 1;
        v.body.velocity.scale(Math.max(0, 1 - dt * 12));
        v.body.angularVelocity.scale(Math.max(0, 1 - dt * 12));

        entry.pitTimer -= dt;
        if (entry.pitTimer <= 0) {
          const req = entry.pitRequest;
          v.changeTires(req.compound || v.compound, true);
          if (req.repair) v.damage.repair();
          if (req.fuel) v.refuel(req.fuel);
          entry.pitStops++;
          entry.mandatoryStopDone = true;
          entry.tireStrategy.push({ lap: entry.lap, compound: req.compound || v.compound });
          entry.pitRequest = null;
          entry.status = DriverStatus.PIT_LANE;
          entry.timing.markOutLap();
          v.controls.brake = 0;
          entry.events.push({ type: 'pitStopEnd', compound: v.compound });
          this.events.push({
            type: 'pitStop', driver: entry.id, name: entry.name,
            compound: v.compound, stop: entry.pitStops
          });
        }
      }
    } else if (entry.status === DriverStatus.PIT_LANE ||
               entry.status === DriverStatus.PIT_BOX) {
      entry.status = DriverStatus.RUNNING;
      entry.events.push({ type: 'pitExit', laneTime: entry.pitLaneTime });
    }
  }

  // -------------------------------------------------------------------------
  //  DRS
  // -------------------------------------------------------------------------

  /**
   * DRS eligibility.
   *
   * The gap is measured at the detection point, not continuously — so a driver
   * has to be close through the corner BEFORE the straight to get the benefit
   * along it, which is what makes the system interesting rather than automatic.
   */
  _updateDRS() {
    if (!this.rules.drsEnabled) {
      for (const e of this.drivers) {
        e.drsAvailable = false;
        if (e.vehicle) e.vehicle.drsAvailable = false;
      }
      return;
    }

    const L = this.track.length;
    const list = this.order.map((id) => this.entries.get(id));

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const v = e.vehicle;
      if (!v) continue;

      // Not permitted in the wet, in the pits, or in the opening laps.
      const wet = this.weather ? this.weather.averageWetness : 0;
      const allowedNow = e.lap >= this.rules.drsEnabledFromLap &&
                         !e.inPitLane && wet < 0.25 &&
                         this.phase === RacePhase.RACING;

      // Detection: crossing a zone's detection point records the gap.
      for (const zone of this.track.drsZones) {
        const prevD = e._prevDistance ?? e.distance;
        const crossed = circularDelta(prevD, zone.detectionDistance, L) > 0 &&
                        circularDelta(e.distance, zone.detectionDistance, L) <= 0 &&
                        Math.abs(circularDelta(prevD, e.distance, L)) < 200;
        if (crossed) {
          const ahead = i > 0 ? list[i - 1] : null;
          e.gapAtDetection = ahead ? e.intervalAhead : Infinity;
          e._drsArmedZone = e.gapAtDetection <= this.rules.drsDetectionGap
            ? zone.id : null;
        }
      }
      e._prevDistance = e.distance;

      const zone = this.track.drsZoneAt(e.distance);
      e.drsZone = zone ? zone.id : null;
      e.drsEligible = !!zone && e._drsArmedZone === (zone ? zone.id : -1);
      e.drsAvailable = allowedNow && e.drsEligible;
      v.drsAvailable = e.drsAvailable;
      // Leaving the zone disarms it until the next detection point.
      if (!zone) e.drsArmed = false;
    }
  }

  // -------------------------------------------------------------------------
  //  Recovery
  // -------------------------------------------------------------------------

  /**
   * Return a beached or stranded car to the circuit.
   *
   * The cost is real: the car is placed BEHIND where it went off, stationary,
   * and only once there is a safe gap in traffic. Being recovered is never
   * faster than not going off in the first place.
   */
  _updateRecovery(entry, dt) {
    if (!this.rules.recoveryEnabled) return;
    const v = entry.vehicle;
    if (!v || entry.status === DriverStatus.FINISHED ||
        entry.status === DriverStatus.DNF || entry.inPitLane) return;

    const stranded = v.speed < 2.2 &&
                     (!entry.onTrack || v.surfaceUnderCar === SurfaceType.GRAVEL ||
                      v.surfaceUnderCar === SurfaceType.GRASS ||
                      v.surfaceUnderCar === SurfaceType.SAND || v.stuckTimer > 2);
    if (stranded) entry.stuckTimer += dt;
    else entry.stuckTimer = Math.max(0, entry.stuckTimer - dt * 2);

    if (entry.stuckTimer < this.rules.recoveryDelaySeconds) return;

    // Do not rejoin into the path of another car.
    const rejoinDistance = wrapRange(entry.distance - 12, this.track.length);
    for (const other of this.drivers) {
      if (other.id === entry.id || !other.vehicle) continue;
      const gap = circularDelta(rejoinDistance, other.distance, this.track.length);
      if (gap > -40 && gap < 55) return;   // someone is about to come past
    }

    const lineOffset = this.track.lineOffsetAt(rejoinDistance);
    const pos = this.track.pointAt(rejoinDistance, lineOffset);
    v.placeAt(pos, this.track.headingAtDistance(rejoinDistance));
    v.body.position.y += 0.15;
    if (entry.ai) entry.ai.reset();
    entry.stuckTimer = 0;
    entry._lastRecoverTime = this.raceTime;
    entry.recoveries++;
    entry.timing.invalidate();
    if (this.rules.recoveryPenaltySeconds > 0) {
      entry.addPenalty(
        PenaltyType.TIME, this.rules.recoveryPenaltySeconds, 'Recovery'
      );
    }
    entry.events.push({ type: 'recovered' });
    this.events.push({ type: 'recovery', driver: entry.id, name: entry.name });
  }

  // -------------------------------------------------------------------------
  //  Start rules and finish
  // -------------------------------------------------------------------------

  _checkJumpStart(dt) {
    // Only once the lights are actually on. A car dropped onto its grid slot
    // settles on its springs, and that vertical motion is not a jump start.
    if (!this.rules.jumpStart || this.phase !== RacePhase.COUNTDOWN) return;
    // Give the field a moment to come to rest before the rule is armed.
    if (this.countdownTimer < 0.6) return;
    for (const entry of this.drivers) {
      const v = entry.vehicle;
      if (!v || entry._jumpStarted) continue;
      // Forward movement along the circuit, not speed in any direction.
      if (v.body.forwardSpeed > 1.4) {
        entry._jumpStarted = true;
        entry.addPenalty(
          PenaltyType.TIME, this.rules.jumpStartPenaltySeconds, 'Jump start'
        );
        entry.events.push({ type: 'jumpStart' });
        this.events.push({ type: 'jumpStart', driver: entry.id, name: entry.name });
      }
    }
  }

  _checkFinish() {
    if (this.sessionType !== SessionType.RACE) {
      // Timed sessions end on the clock.
      if (this.sessionDuration > 0 && this.raceTime >= this.sessionDuration &&
          this.phase === RacePhase.RACING) {
        this.phase = RacePhase.CHECKERED;
        this.events.push({ type: 'sessionEnding' });
      }
      if (this.phase === RacePhase.CHECKERED) {
        // Everyone gets to complete the lap they are on.
        const stillRunning = this.drivers.some(
          (e) => e.status === DriverStatus.RUNNING || e.status === DriverStatus.PIT_LANE
        );
        if (!stillRunning) this._finishSession();
      }
      return;
    }

    for (const entry of this.drivers) {
      if (entry.status === DriverStatus.FINISHED ||
          entry.status === DriverStatus.DNF ||
          entry.status === DriverStatus.RETIRED) continue;
      if (entry.lap >= this.totalLaps) {
        entry.status = DriverStatus.FINISHED;
        entry.finished = true;
        entry.finishTime = this.raceTime;
        entry.totalRaceTime = this.raceTime + entry.penaltySeconds;
        entry.classified = true;
        this.finishOrder.push(entry.id);
        entry.events.push({ type: 'finished', position: this.finishOrder.length });
        this.events.push({
          type: 'finish', driver: entry.id, name: entry.name,
          position: this.finishOrder.length
        });
        // A finished car must not interfere with those still racing.
        if (entry.vehicle) {
          entry.vehicle.controls.throttle = 0;
          entry.vehicle.controls.drs = false;
        }
        if (!this.leaderFinished) {
          this.leaderFinished = true;
          this.phase = RacePhase.CHECKERED;
          this.events.push({ type: 'checkered' });
        }
      }
    }

    if (this.phase === RacePhase.CHECKERED) {
      const stillRacing = this.drivers.some(
        (e) => e.status !== DriverStatus.FINISHED &&
               e.status !== DriverStatus.DNF &&
               e.status !== DriverStatus.RETIRED
      );
      // Give the stragglers a lap's grace, then classify them where they are.
      if (!stillRacing) this._finishSession();
      else if (this.raceTime - (this._checkeredAt ?? (this._checkeredAt = this.raceTime)) > 240) {
        this._finishSession();
      }
    }
  }

  _finishSession() {
    this.phase = RacePhase.FINISHED;
    for (const e of this.drivers) {
      if (e.status !== DriverStatus.FINISHED && e.status !== DriverStatus.DNF) {
        e.status = DriverStatus.FINISHED;
        e.finished = true;
        e.finishTime = this.raceTime;
        e.totalRaceTime = this.raceTime + e.penaltySeconds;
        // Classified if they completed at least 90% of the leader's distance.
        e.classified = e.lap >= Math.floor(this.totalLaps * 0.9);
      }
    }
    this._reorder();
    this.events.push({ type: 'sessionFinished', classification: this.classification() });
  }

  // -------------------------------------------------------------------------
  //  Reporting
  // -------------------------------------------------------------------------

  /** Final classification, penalties applied. */
  classification() {
    const list = this.drivers.slice();
    list.sort((a, b) => {
      const aOut = a.status === DriverStatus.DNF || !a.classified;
      const bOut = b.status === DriverStatus.DNF || !b.classified;
      if (aOut !== bOut) return aOut ? 1 : -1;
      if (aOut && bOut) return b.totalDistance - a.totalDistance;
      if (this.sessionType === SessionType.RACE) {
        if (a.lap !== b.lap) return b.lap - a.lap;
        return (a.finishTime + a.penaltySeconds) - (b.finishTime + b.penaltySeconds);
      }
      return (a.timing.bestLap ?? Infinity) - (b.timing.bestLap ?? Infinity);
    });

    const winner = list[0];
    const winnerTime = winner && winner.finishTime != null
      ? winner.finishTime + winner.penaltySeconds : null;
    const winnerLaps = winner ? winner.lap : 0;
    return list.map((e, i) => {
      // Only a driver who took the flag has a race time. Everyone else is
      // reported in laps down, never as a negative gap to the winner.
      const finished = e.finishTime != null;
      const totalTime = finished ? e.finishTime + e.penaltySeconds : null;
      const lapsDown = Math.max(0, winnerLaps - e.lap);
      return {
      position: i + 1,
      id: e.id,
      name: e.name,
      shortName: e.shortName,
      team: e.team,
      colour: e.colour,
      laps: e.lap,
      totalTime,
      lapsDown,
      gapToWinner: i === 0 ? 0
        : (finished && winnerTime != null ? totalTime - winnerTime : null),
      bestLap: e.timing.bestLap,
      bestSectors: e.timing.bestSectors.slice(),
      pitStops: e.pitStops,
      tireStrategy: e.tireStrategy.slice(),
      penaltySeconds: e.penaltySeconds,
      penalties: e.penalties.map((p) => ({ type: p.type, seconds: p.seconds, reason: p.reason })),
      status: e.status,
      classified: e.classified,
      startPosition: e.startPosition,
      positionsGained: e.startPosition - (i + 1),
      fastestLap: this.records.fastestLapDriver?.id === e.id,
      recoveries: e.recoveries
      };
    });
  }

  /** Live timing tower rows. */
  standings() {
    return this.order.map((id) => {
      const e = this.entries.get(id);
      return {
        position: e.position,
        id: e.id,
        name: e.name,
        shortName: e.shortName,
        colour: e.colour,
        lap: e.lap,
        gapToLeader: e.gapToLeader,
        interval: e.intervalAhead,
        lapsDown: e.lapsDown,
        lastLap: e.timing.lastLap,
        bestLap: e.timing.bestLap,
        sector: e.sector,
        compound: e.compound,
        tireWear: e.vehicle ? 1 - e.vehicle.tireCondition : 0,
        pitStops: e.pitStops,
        status: e.status,
        inPit: e.inPitLane,
        penaltySeconds: e.penaltySeconds,
        drs: e.drsAvailable,
        speed: e.vehicle ? e.vehicle.speedKmh : 0,
        fastestLap: this.records.fastestLapDriver?.id === e.id
      };
    });
  }

  serialize() {
    return {
      phase: this.phase,
      sessionType: this.sessionType,
      time: Math.round(this.time * 100) / 100,
      raceTime: Math.round(this.raceTime * 100) / 100,
      totalLaps: this.totalLaps,
      lights: this.countdownLights,
      fastestLap: this.records.fastestLap,
      fastestLapDriver: this.records.fastestLapDriver,
      order: this.order.slice()
    };
  }
}
