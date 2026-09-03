import { SurfaceType } from '../physics/Surfaces.js';

/**
 * ============================================================================
 *  APEX CIRCUIT — an original Formula-style road course
 * ============================================================================
 *
 * 5.35 km, 13 corners, three distinct sectors and 43 m of elevation change.
 * The layout is described as a driver would describe it — a sequence of
 * straights and constant-radius corners — and the geometry is generated from
 * that. The angles were solved numerically so the loop closes to within half a
 * metre, which is why several of them are not round numbers.
 *
 * Design brief, corner by corner:
 *
 *  SECTOR 1 — power and a heavy stop
 *    Main Straight   1147 m, climbing. The fastest point on the circuit and the
 *                    primary DRS zone.
 *    T1  Vanetiya    46 m radius after 300 km/h. The heaviest braking zone on
 *                    the circuit and the best overtaking spot; deliberately
 *                    widened so two cars can go in side by side.
 *    T2  Foxhole     105 m, taken flat-ish, punishes anyone who ran wide at T1.
 *    T3  Long Right  155 m, near flat out, loads the left-front heavily.
 *    T4  Turnaway    72 m, tightens on exit onto the Back Straight — a corner
 *                    where exit speed matters more than entry.
 *
 *  SECTOR 2 — technical, and where tires are won or lost
 *    T5/T6 Chicane   38 m / 36 m over a crest. Kerbs must be used to be quick,
 *                    and using them unsettles the car.
 *    Descent         295 m dropping 20 m into the slowest corner.
 *    T7  Hairpin     21 m, 68 km/h, first gear. Traction limited on exit.
 *    Ascent          277 m climbing 14 m under full power.
 *    T8/T9 Esses     88 m / 82 m, a direction change that rewards a settled car.
 *
 *  SECTOR 3 — fast and flowing, feeding the main straight
 *    T10 Ascari Sweep 255 m, aerodynamically limited — flat out with enough
 *                    downforce, and brutal in dirty air.
 *    Vale Straight   595 m, second DRS zone.
 *    T11 Vale        115 m, late apex.
 *    T12 Museum      60 m, the second-best overtaking spot.
 *    T13 Parabolica  95 m, long and constant-radius. It feeds directly onto the
 *                    main straight, so exit speed here decides the next lap's
 *                    slipstream battle. Getting this corner right is worth more
 *                    than any other on the circuit.
 */

/** Circuit turn direction: this is a clockwise course. */
export const LAYOUT = [
  // The lap origin is the start/finish line, which sits 300 m along the main
  // straight. The straight is therefore split: the bulk of it runs from the
  // line to T1, and the final 300 m closes the lap and carries the grid.
  { t: 's', len: 846.7, name: 'Main Straight', kind: 'straight' },
  { t: 'a', r: 46,  deg: 105.54, name: 'T1 Vanetiya',      kind: 'slow',   corner: 1 },
  { t: 's', len: 170.0, name: '' },
  { t: 'a', r: 105, deg: -58.00, name: 'T2 Foxhole',       kind: 'medium', corner: 2 },
  { t: 's', len: 130.0, name: '' },
  { t: 'a', r: 155, deg: 95.21,  name: 'T3 Long Right',    kind: 'fast',   corner: 3 },
  { t: 's', len: 95.0,  name: '' },
  { t: 'a', r: 72,  deg: -57.13, name: 'T4 Turnaway',      kind: 'medium', corner: 4 },
  { t: 's', len: 400.2, name: 'Back Straight', kind: 'straight' },
  { t: 'a', r: 38,  deg: 78.00,  name: 'T5 Chicane In',    kind: 'slow',   corner: 5 },
  { t: 's', len: 48.0,  name: '' },
  { t: 'a', r: 36,  deg: -84.00, name: 'T6 Chicane Out',   kind: 'slow',   corner: 6 },
  { t: 's', len: 295.0, name: 'Descent', kind: 'straight' },
  { t: 'a', r: 21,  deg: 177.98, name: 'T7 Hairpin',       kind: 'hairpin', corner: 7 },
  { t: 's', len: 277.0, name: 'Ascent', kind: 'straight' },
  { t: 'a', r: 88,  deg: -72.00, name: 'T8 Esse One',      kind: 'medium', corner: 8 },
  { t: 's', len: 70.0,  name: '' },
  { t: 'a', r: 82,  deg: 72.36,  name: 'T9 Esse Two',      kind: 'medium', corner: 9 },
  { t: 's', len: 210.0, name: '' },
  { t: 'a', r: 255, deg: -63.41, name: 'T10 Ascari Sweep', kind: 'fast',   corner: 10 },
  { t: 's', len: 594.6, name: 'Vale Straight', kind: 'straight' },
  { t: 'a', r: 115, deg: 100.52, name: 'T11 Vale',         kind: 'medium', corner: 11 },
  { t: 's', len: 150.0, name: '' },
  { t: 'a', r: 60,  deg: -55.31, name: 'T12 Museum',       kind: 'slow',   corner: 12 },
  { t: 's', len: 120.0, name: '' },
  { t: 'a', r: 95,  deg: 120.15, name: 'T13 Parabolica',   kind: 'medium', corner: 13 },
  { t: 's', len: 300.0, name: 'Start Straight', kind: 'straight' }
];

/**
 * Elevation profile as [fraction of lap, height in metres]. Interpolated with a
 * smooth (cosine) blend so there are no gradient discontinuities for the
 * suspension to trip over.
 */
export const ELEVATION = [
  [0.000,   0.0],   // start / finish line
  [0.080,   4.0],   // main straight climbing away from the line
  [0.158,   7.0],   // T1 braking board
  [0.174,   8.0],   // T1 Vanetiya
  [0.216,  10.5],   // T2 Foxhole
  [0.274,  12.0],   // T3 Long Right
  [0.322,  11.0],   // T4 Turnaway
  [0.404,  13.5],   // back straight, crest into the chicane
  [0.428,  15.0],   // chicane — the highest point of the circuit
  [0.455,   9.0],   // the descent begins
  [0.478,  -3.0],
  [0.494,  -8.0],   // hairpin — the lowest point, 23 m below the chicane
  [0.520,  -4.5],
  [0.545,   3.0],   // ascent under full power
  [0.562,   6.5],   // esses
  [0.600,   7.5],
  [0.670,   5.0],   // Ascari Sweep
  [0.750,   2.5],   // Vale straight descending
  [0.808,   1.0],
  [0.845,   0.5],   // T11 Vale
  [0.884,   0.0],   // T12 Museum
  [0.925,  -0.5],   // Parabolica
  [1.000,   0.0]    // back to the line
];

/**
 * Track width in metres by fraction of lap. Wider at the two main overtaking
 * points so a second car genuinely fits alongside; narrower through the
 * chicane, which is what makes it a commitment.
 */
export const WIDTH_PROFILE = [
  [0.000, 15.0],
  [0.125, 15.0],
  [0.150, 17.5],   // T1 braking zone — deliberately generous
  [0.180, 16.0],
  [0.250, 13.5],
  [0.330, 14.0],
  [0.404, 11.5],   // chicane
  [0.435, 11.5],
  [0.465, 13.5],
  [0.494, 15.0],   // hairpin — wide enough to defend the inside
  [0.535, 13.5],
  [0.630, 13.0],
  [0.700, 14.0],
  [0.800, 15.0],
  [0.840, 16.5],   // T11/T12 — the second overtaking spot
  [0.895, 14.5],
  [1.000, 15.0]
];

/**
 * Banking (radians, positive = banked so the outside is raised). Modest, as on
 * a real road course, but enough to change how the fast corners load the car.
 */
export const BANKING = [
  [0.000, 0.000],
  [0.166, 0.030],  // T1
  [0.274, 0.045],  // T3 — slight positive camber
  [0.414, -0.015], // the chicane crest is off-camber, which is what makes it tricky
  [0.494, 0.020],  // hairpin
  [0.670, 0.055],  // Ascari Sweep is banked, which is why it goes flat
  [0.845, 0.025],  // T11
  [0.925, 0.030],  // Parabolica
  [1.000, 0.000]
];

/**
 * Runoff character by fraction of lap. Determines what a driver finds when they
 * leave the circuit: paved runoff at the fast corners, gravel at the slow ones.
 */
export const RUNOFF_PROFILE = [
  { from: 0.000, to: 0.135, type: SurfaceType.GRASS,  width: 18 },
  { from: 0.135, to: 0.196, type: SurfaceType.RUNOFF, width: 46 },  // T1
  { from: 0.196, to: 0.250, type: SurfaceType.GRAVEL, width: 24 },  // T2
  { from: 0.250, to: 0.305, type: SurfaceType.RUNOFF, width: 40 },  // T3
  { from: 0.305, to: 0.395, type: SurfaceType.GRAVEL, width: 22 },  // T4
  { from: 0.395, to: 0.455, type: SurfaceType.GRAVEL, width: 20 },  // chicane
  { from: 0.455, to: 0.480, type: SurfaceType.GRASS,  width: 16 },
  { from: 0.480, to: 0.545, type: SurfaceType.RUNOFF, width: 30 },  // hairpin
  { from: 0.545, to: 0.640, type: SurfaceType.GRASS,  width: 18 },
  { from: 0.640, to: 0.705, type: SurfaceType.RUNOFF, width: 52 },  // Ascari Sweep
  { from: 0.705, to: 0.800, type: SurfaceType.GRASS,  width: 20 },
  { from: 0.800, to: 0.900, type: SurfaceType.GRAVEL, width: 26 },  // T11/T12
  { from: 0.900, to: 1.001, type: SurfaceType.RUNOFF, width: 34 }   // Parabolica
];

/** Kerb width beyond the racing surface, in metres. */
export const KERB_WIDTH = 1.35;

/**
 * DRS zones. Each has a detection point (where the gap to the car ahead is
 * measured) and an activation range. Detection sits before the corner that
 * precedes the straight, exactly as it does in real racing, so a driver has to
 * be close through the corner to get the tow down the straight.
 */
export const DRS_ZONES = [
  {
    id: 1,
    name: 'Main Straight',
    detectionFraction: 0.905,   // entry to Parabolica
    startFraction: 0.012,       // just after the start/finish line
    endFraction: 0.140          // braking board for T1
  },
  {
    id: 2,
    name: 'Vale Straight',
    detectionFraction: 0.640,   // entry to Ascari Sweep
    startFraction: 0.700,
    endFraction: 0.795
  },
  {
    id: 3,
    name: 'Back Straight',
    detectionFraction: 0.312,   // entry to T4
    startFraction: 0.335,
    endFraction: 0.400
  }
];

/** Gap within which DRS is enabled at the detection point, in seconds. */
export const DRS_DETECTION_GAP = 1.0;

/** Timing sectors, as fractions of a lap. */
export const SECTORS = [
  { index: 0, name: 'Sector 1', from: 0.000, to: 0.330 },
  { index: 1, name: 'Sector 2', from: 0.330, to: 0.640 },
  { index: 2, name: 'Sector 3', from: 0.640, to: 1.000 }
];

/** Speed traps, for the timing screens. */
export const SPEED_TRAPS = [
  { name: 'Main Straight', fraction: 0.140 },
  { name: 'Vale Straight', fraction: 0.795 }
];

/**
 * Pit lane. It branches off on the inside of Parabolica, runs alongside the
 * main straight and rejoins after the grid. The speed limit and the length
 * together set the cost of a stop at around 21 seconds, which is what makes an
 * extra stop a real decision rather than an automatic one.
 */
export const PIT_LANE = {
  entryFraction: 0.900,
  exitFraction: 0.045,
  /** Lateral offset from the centreline (negative = inside/left). */
  offset: -21.0,
  width: 12.0,
  speedLimitKmh: 80,
  /** Where the pit boxes sit, as a fraction of the pit lane's own length. */
  boxStart: 0.34,
  boxSpacing: 19.0,
  /** Seconds of stationary time for a routine tire change. */
  serviceTime: 2.5,
  /** Fixed overhead: entering the box, jacks up, release. */
  stopOverhead: 2.1
};

/** Starting grid: staggered slots behind the start/finish line. */
export const GRID = {
  /** Distance of pole position before the line, in metres. */
  poleOffset: 92,
  rowSpacing: 8.4,
  lateralOffset: 3.3,
  /** Pole sits on the left-hand side of the circuit. */
  poleSide: -1
};

export const CIRCUIT_INFO = {
  id: 'apex-circuit',
  name: 'Apex Circuit',
  location: 'Valen Ridge',
  lengthHint: 5352,
  corners: 13,
  direction: 'clockwise',
  elevationChange: 23,
  lapRecordHint: 88.5,
  description:
    'A 5.35 km road course with three genuinely different sectors: a long ' +
    'climbing straight into the heaviest stop of the lap, a technical middle ' +
    'sector over a crest and down into a first-gear hairpin, and a fast ' +
    'flowing final third that feeds straight back onto the main straight.'
};
