import { SessionType } from './RaceDirector.js';

/**
 * ============================================================================
 *  RACE WEEKEND
 * ============================================================================
 *
 * Practice, then qualifying, then the race — with the result of each session
 * carrying into the next.
 *
 * The point of the format is that qualifying decides the grid. That is the only
 * thing in the game that lets a driver change where they start, and it makes a
 * clean lap worth something before the race has even begun.
 */

export const WeekendStage = {
  PRACTICE: 'practice',
  QUALIFYING: 'qualifying',
  RACE: 'race',
  COMPLETE: 'complete'
};

export const WEEKEND_STAGES = [
  {
    key: WeekendStage.PRACTICE,
    name: 'Practice',
    sessionType: SessionType.PRACTICE,
    duration: 600,
    description: 'Learn the circuit, try a setup, and find out how the tires behave.'
  },
  {
    key: WeekendStage.QUALIFYING,
    name: 'Qualifying',
    sessionType: SessionType.QUALIFYING,
    duration: 480,
    description: 'One clean lap decides where you start the race.'
  },
  {
    key: WeekendStage.RACE,
    name: 'Race',
    sessionType: SessionType.RACE,
    duration: 0,
    description: 'Starting from the position you earned.'
  }
];

export class Weekend {
  constructor(opts = {}) {
    this.stageIndex = 0;
    this.laps = opts.laps ?? 8;
    /** Grid order for the race, by driver id, set by qualifying. */
    this.grid = null;
    this.results = {};
    this.completed = false;
  }

  get stage() { return WEEKEND_STAGES[this.stageIndex]; }
  get isLast() { return this.stageIndex >= WEEKEND_STAGES.length - 1; }

  /** Session configuration for the current stage. */
  sessionConfig() {
    const stage = this.stage;
    return {
      sessionType: stage.sessionType,
      sessionDuration: stage.duration,
      totalLaps: stage.sessionType === SessionType.RACE ? this.laps : 999
    };
  }

  /**
   * Record the outcome of a stage and advance.
   * @returns {object|null} the next stage, or null when the weekend is over
   */
  completeStage(classification) {
    const stage = this.stage;
    this.results[stage.key] = classification;

    // Qualifying sets the grid for the race. Anyone who never set a lap starts
    // at the back, in the order they were already in.
    if (stage.sessionType === SessionType.QUALIFYING) {
      const withLap = classification.filter((r) => r.bestLap != null);
      const without = classification.filter((r) => r.bestLap == null);
      withLap.sort((a, b) => a.bestLap - b.bestLap);
      this.grid = [...withLap, ...without].map((r) => r.id);
    }

    this.stageIndex++;
    if (this.stageIndex >= WEEKEND_STAGES.length) {
      this.completed = true;
      return null;
    }
    return this.stage;
  }

  /** Grid position for a driver, 1-based. */
  gridPositionFor(id, fallback) {
    if (!this.grid) return fallback;
    const i = this.grid.indexOf(id);
    return i >= 0 ? i + 1 : fallback;
  }

  reset() {
    this.stageIndex = 0;
    this.grid = null;
    this.results = {};
    this.completed = false;
  }
}
