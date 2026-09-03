import { TireCompound } from '../physics/Tire.js';
import { DiffType } from '../physics/Differential.js';

/**
 * Car definitions.
 *
 * Everything here is a real physical quantity in SI units. There are no
 * "handling" or "speed" stats — a car is fast because of its mass, its
 * aerodynamic coefficients and its torque curve, and nothing else.
 *
 * The list is data-driven so new chassis can be added without touching the
 * simulation.
 */

/** The 2.0 s of a modern formula car: shared baseline geometry. */
const FORMULA_BASE = {
  class: 'formula',
  // --- Mass -----------------------------------------------------------------
  dryMass: 798,             // kg, including driver, excluding fuel
  fuelCapacity: 110,        // kg
  cogHeight: 0.279,         // m above the road at static ride height
  frontWeightBias: 0.450,   // fraction of static weight on the front axle
  // Inertia is derived from these body dimensions rather than hand-tuned.
  bodyLength: 5.63,
  bodyWidth: 2.00,
  bodyHeight: 0.95,
  // An open-wheeler's mass is concentrated centrally, so its real yaw inertia
  // is well below a solid box of the same size.
  inertiaScale: 0.62,

  // --- Geometry -------------------------------------------------------------
  wheelbase: 3.60,
  trackFront: 1.62,
  trackRear: 1.56,
  wheelRadiusFront: 0.360,
  wheelRadiusRear: 0.372,
  tireWidthFront: 0.305,
  tireWidthRear: 0.405,
  wheelInertiaFront: 1.15,
  wheelInertiaRear: 1.55,
  maxSteerAngle: 0.36,      // rad at the roadwheel (~20.6 deg of lock)
  steerRate: 5.2,           // rad/s the driver can move the roadwheel

  // --- Suspension -----------------------------------------------------------
  springRateFront: 178000,  // N/m
  springRateRear: 152000,
  bumpDampingFront: 6600,
  bumpDampingRear: 6000,
  reboundDampingFront: 10400,
  reboundDampingRear: 9400,
  restLengthFront: 0.180,
  restLengthRear: 0.190,
  maxCompression: 0.055,
  maxExtension: 0.070,
  antiRollFront: 46000,     // N/m of differential compression
  antiRollRear: 32000,
  rideHeightFront: 0.038,
  rideHeightRear: 0.062,

  // --- Aero -----------------------------------------------------------------
  clA: 4.10,
  cdA: 1.30,
  aeroBalance: 0.435,
  // Where the aero load is applied, as a fraction of the wheelbase ahead of
  // and behind the centre of mass.
  frontCopZ: 1.98,
  rearCopZ: -1.62,
  dragCopHeight: 0.32,

  // --- Powertrain -----------------------------------------------------------
  engine: {
    idleRpm: 4200,
    maxRpm: 15000,
    limiterRpm: 14800,
    inertia: 0.24,
    torqueCurve: [
      [0, 150], [3000, 340], [5000, 450], [7000, 530], [9000, 590],
      [10000, 615], [11000, 605], [12000, 585], [13000, 545],
      [14000, 490], [15000, 420]
    ]
  },
  transmission: {
    gearRatios: [-3.10, 5.24, 4.35, 3.72, 3.24, 2.87, 2.57, 2.26, 2.00],
    finalDrive: 3.00,
    shiftTime: 0.055,
    downshiftTime: 0.075
  },
  differential: {
    type: DiffType.LSD,
    preload: 55,
    powerRamp: 0.45,
    coastRamp: 0.22
  },
  brakes: {
    maxTorque: 17000,
    balance: 0.58
  },

  // --- Consumables ----------------------------------------------------------
  defaultCompound: TireCompound.MEDIUM,
  fuelPerLap: 1.95           // kg, used by the strategy planner
};

function makeCar(id, overrides) {
  return {
    id,
    ...FORMULA_BASE,
    ...overrides,
    engine: { ...FORMULA_BASE.engine, ...(overrides.engine || {}) },
    transmission: { ...FORMULA_BASE.transmission, ...(overrides.transmission || {}) },
    differential: { ...FORMULA_BASE.differential, ...(overrides.differential || {}) },
    brakes: { ...FORMULA_BASE.brakes, ...(overrides.brakes || {}) }
  };
}

/**
 * The three chassis are genuinely different cars, not reskins. Each trades
 * along a real axis, so the choice interacts with the circuit and the setup.
 */
export const CARS = [
  makeCar('apex-gp', {
    name: 'Apex GP-1',
    team: 'Apex Racing',
    colour: '#e8323c',
    accent: '#ffffff',
    description:
      'The balanced benchmark. Neutral aero platform, forgiving on entry and ' +
      'strong everywhere without excelling anywhere. The car to learn on.',
    traits: { downforce: 3, power: 3, agility: 3, stability: 3 }
  }),

  makeCar('vector-ms', {
    name: 'Vector MS-9',
    team: 'Vector Motorsport',
    colour: '#2f7fd6',
    accent: '#c8e4ff',
    // A low-drag, low-downforce package: quick on the straights, hard work in
    // the technical middle sector, and it eats its rear tires.
    clA: 3.72,
    cdA: 1.19,
    aeroBalance: 0.448,
    dryMass: 798,
    springRateRear: 143000,
    antiRollRear: 27000,
    engine: {
      torqueCurve: [
        [0, 155], [3000, 350], [5000, 468], [7000, 548], [9000, 606],
        [10000, 628], [11000, 622], [12000, 602], [13000, 561],
        [14000, 502], [15000, 430]
      ]
    },
    differential: { powerRamp: 0.38, preload: 45 },
    description:
      'Low drag and extra power: the quickest car in a straight line and the ' +
      'best slipstream weapon, but it leans on its rear tires through Sector 2.',
    traits: { downforce: 2, power: 4, agility: 3, stability: 2 }
  }),

  makeCar('meridian-rs', {
    name: 'Meridian RS',
    team: 'Meridian Works',
    colour: '#f2c53d',
    accent: '#2a2a2a',
    // High downforce, heavier on drag: superb through the fast sweepers, slow
    // down the main straight and therefore vulnerable to DRS.
    clA: 4.48,
    cdA: 1.42,
    aeroBalance: 0.424,
    springRateFront: 190000,
    antiRollFront: 52000,
    brakes: { maxTorque: 17800, balance: 0.585 },
    differential: { powerRamp: 0.52, preload: 65 },
    description:
      'Maximum downforce. Extraordinary through Ascari Sweep and the fast ' +
      'stuff, but it drags its wing down the straight — defend carefully.',
    traits: { downforce: 4, power: 3, agility: 4, stability: 4 }
  })
];

export function getCar(id) {
  return CARS.find((c) => c.id === id) || CARS[0];
}

/**
 * Default setup. Every value here is fed straight into the physics — there are
 * no cosmetic settings on this screen.
 */
export function defaultSetup(car = CARS[0]) {
  return {
    frontWing: 6,
    rearWing: 6,
    // Aero balance is derived from the wings but can be trimmed directly.
    aeroBalanceTrim: 0,

    springFront: 5,          // 1..11, scales the base spring rate
    springRear: 5,
    antiRollFront: 5,
    antiRollRear: 5,
    rideHeightFront: 5,
    rideHeightRear: 5,
    dampingBump: 5,
    dampingRebound: 5,

    brakeBalance: car.brakes.balance,   // 0.40..0.75
    brakePressure: 1.0,

    diffPower: car.differential.powerRamp,
    diffCoast: car.differential.coastRamp,
    diffPreload: car.differential.preload,

    finalDrive: car.transmission.finalDrive,

    compound: car.defaultCompound,
    fuel: 110
  };
}

/** Preset setups so a new player has somewhere sensible to start. */
export const SETUP_PRESETS = {
  balanced: {
    name: 'Balanced',
    description: 'The default working setup. Neutral and predictable.',
    values: {}
  },
  lowDrag: {
    name: 'Low Drag',
    description:
      'Wings trimmed out for straight-line speed and defence. Harder work ' +
      'through Sector 2 and much easier to lock a front on entry.',
    values: { frontWing: 3, rearWing: 2, brakeBalance: 0.60, rideHeightRear: 4 }
  },
  highDownforce: {
    name: 'High Downforce',
    description:
      'Maximum wing for the technical middle sector. Strong in the corners, ' +
      'a sitting duck on the main straight.',
    values: { frontWing: 9, rearWing: 10, brakeBalance: 0.565, springFront: 7 }
  },
  stable: {
    name: 'Stable',
    description:
      'Rearward aero balance, soft front bar, open differential on coast. ' +
      'Understeers on entry but very hard to spin.',
    values: {
      frontWing: 5, rearWing: 8, antiRollFront: 3, antiRollRear: 7,
      diffCoast: 0.12, brakeBalance: 0.615
    }
  },
  aggressive: {
    name: 'Aggressive',
    description:
      'Front-biased aero, stiff front bar, locked differential on power. ' +
      'Rotates brilliantly and will spit you off if you are careless.',
    values: {
      frontWing: 9, rearWing: 6, antiRollFront: 8, antiRollRear: 3,
      diffPower: 0.62, brakeBalance: 0.545, rideHeightFront: 3
    }
  },
  wet: {
    name: 'Wet Weather',
    description:
      'Raised ride height, softer springs, more wing and a rearward brake ' +
      'balance to survive standing water.',
    values: {
      frontWing: 8, rearWing: 9, rideHeightFront: 8, rideHeightRear: 8,
      springFront: 3, springRear: 3, antiRollFront: 3, antiRollRear: 3,
      brakeBalance: 0.545, diffPower: 0.32, compound: TireCompound.WET
    }
  }
};

export function applyPreset(car, presetKey) {
  const base = defaultSetup(car);
  const preset = SETUP_PRESETS[presetKey];
  if (!preset) return base;
  return { ...base, ...preset.values };
}
