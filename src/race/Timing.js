import { formatLapTime, formatSector, circularDelta } from '../math/MathUtils.js';

/**
 * Per-driver lap and sector timing.
 *
 * Sector boundaries are crossed by *track distance*, not by proximity to a
 * point, so a car cannot miss a split by being off line or airborne, and
 * cannot re-trigger one by rocking backwards over it.
 */
export class DriverTiming {
  constructor(sectorCount = 3) {
    this.sectorCount = sectorCount;
    this.lap = 0;                 // completed laps
    this.currentSector = 0;
    this.lapStartTime = null;
    this.sectorStartTime = null;

    this.lapTimes = [];
    this.sectorTimes = [];        // per lap: [s1, s2, s3]
    this.currentSectors = new Array(sectorCount).fill(null);

    this.bestLap = null;
    this.bestLapNumber = 0;
    this.lastLap = null;
    this.previousLap = null;
    this.bestSectors = new Array(sectorCount).fill(null);
    this.lastSectors = new Array(sectorCount).fill(null);

    this.started = false;
    this.outLap = true;           // the first lap out of the pits is not timed
    this.invalidated = false;     // track limits / off-track this lap
    this.speedTrap = {};
  }

  /** Begin timing — called as the lights go out, or on a flying-lap start. */
  start(time) {
    this.started = true;
    this.lapStartTime = time;
    this.sectorStartTime = time;
    this.currentSector = 0;
    this.currentSectors.fill(null);
    this.invalidated = false;
  }

  /**
   * Advance the timing state for a driver's current position on the circuit.
   *
   * @param {number} time    race clock
   * @param {number} sector  sector index the car is currently in
   * @param {boolean} crossedLine true on the step the car crossed start/finish
   * @returns {object|null} an event describing a completed sector or lap
   */
  update(time, sector, crossedLine) {
    if (!this.started) return null;

    let event = null;

    if (crossedLine) {
      // Close the final sector and the lap together.
      if (this.sectorStartTime != null) {
        this.currentSectors[this.sectorCount - 1] = time - this.sectorStartTime;
      }
      const lapTime = this.lapStartTime != null ? time - this.lapStartTime : null;

      if (!this.outLap && lapTime != null && lapTime > 5) {
        this.previousLap = this.lastLap;
        this.lastLap = lapTime;
        this.lapTimes.push(lapTime);
        this.lastSectors = this.currentSectors.slice();
        this.sectorTimes.push(this.currentSectors.slice());

        if (!this.invalidated) {
          if (this.bestLap == null || lapTime < this.bestLap) {
            this.bestLap = lapTime;
            this.bestLapNumber = this.lap + 1;
            event = { type: 'personalBest', lapTime, lap: this.lap + 1 };
          }
          for (let i = 0; i < this.sectorCount; i++) {
            const st = this.currentSectors[i];
            if (st != null && (this.bestSectors[i] == null || st < this.bestSectors[i])) {
              this.bestSectors[i] = st;
            }
          }
        }
        if (!event) event = { type: 'lap', lapTime, lap: this.lap + 1 };
      } else if (this.outLap) {
        event = { type: 'outLapComplete' };
      }

      this.lap++;
      this.outLap = false;
      this.lapStartTime = time;
      this.sectorStartTime = time;
      this.currentSector = 0;
      this.currentSectors.fill(null);
      this.invalidated = false;
      return event;
    }

    // Sector transition (forward only).
    if (sector !== this.currentSector && sector === this.currentSector + 1) {
      this.currentSectors[this.currentSector] = time - this.sectorStartTime;
      const done = this.currentSector;
      this.currentSector = sector;
      this.sectorStartTime = time;
      return {
        type: 'sector',
        sector: done,
        time: this.currentSectors[done],
        best: this.bestSectors[done] == null ||
              this.currentSectors[done] < this.bestSectors[done]
      };
    }
    return null;
  }

  /** Time elapsed on the current lap. */
  currentLapTime(time) {
    if (!this.started || this.lapStartTime == null) return 0;
    return time - this.lapStartTime;
  }

  /** Mark this lap as not counting for a personal best. */
  invalidate() {
    this.invalidated = true;
  }

  /** Called on a pit exit: the next lap is an out lap. */
  markOutLap() {
    this.outLap = true;
  }

  get pitStops() {
    return this._pitStops || 0;
  }

  formatted() {
    return {
      last: formatLapTime(this.lastLap),
      best: formatLapTime(this.bestLap),
      previous: formatLapTime(this.previousLap),
      sectors: this.lastSectors.map(formatSector),
      bestSectors: this.bestSectors.map(formatSector)
    };
  }
}

/**
 * Session-wide timing records: the fastest lap and the theoretical best made
 * of everyone's best sectors.
 */
export class SessionRecords {
  constructor(sectorCount = 3) {
    this.sectorCount = sectorCount;
    this.fastestLap = null;
    this.fastestLapDriver = null;
    this.fastestLapNumber = 0;
    this.bestSectors = new Array(sectorCount).fill(null);
    this.bestSectorDrivers = new Array(sectorCount).fill(null);
    this.speedTrapBest = 0;
    this.speedTrapDriver = null;
  }

  submitLap(driverId, driverName, lapTime, lapNumber) {
    if (lapTime == null || !(lapTime > 5)) return false;
    if (this.fastestLap == null || lapTime < this.fastestLap) {
      this.fastestLap = lapTime;
      this.fastestLapDriver = { id: driverId, name: driverName };
      this.fastestLapNumber = lapNumber;
      return true;
    }
    return false;
  }

  submitSector(driverId, driverName, index, time) {
    if (time == null || !(time > 0.5)) return false;
    if (this.bestSectors[index] == null || time < this.bestSectors[index]) {
      this.bestSectors[index] = time;
      this.bestSectorDrivers[index] = { id: driverId, name: driverName };
      return true;
    }
    return false;
  }

  submitSpeedTrap(driverId, driverName, speed) {
    if (speed > this.speedTrapBest) {
      this.speedTrapBest = speed;
      this.speedTrapDriver = { id: driverId, name: driverName };
    }
  }

  /** Sum of the best sectors anyone has set — the "ideal lap". */
  get theoreticalBest() {
    if (this.bestSectors.some((s) => s == null)) return null;
    return this.bestSectors.reduce((a, b) => a + b, 0);
  }
}
