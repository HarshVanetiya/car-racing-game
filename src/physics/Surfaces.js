/**
 * Track surface definitions.
 *
 * Grip here is a *multiplier on the tire's own friction coefficient*, not a
 * replacement for it — so a soft tire on grass is still marginally better than
 * a hard tire on grass, and running wide always costs real lap time rather than
 * triggering a scripted penalty.
 */

export const SurfaceType = {
  ASPHALT: 0,
  KERB: 1,
  PIT_LANE: 2,
  GRASS: 3,
  GRAVEL: 4,
  RUNOFF: 5,   // paved runoff — grippy but dusty and off the racing line
  SAND: 6,
  BARRIER: 7
};

export const SURFACES = {
  [SurfaceType.ASPHALT]: {
    name: 'Asphalt',
    grip: 1.0,
    rollingResistance: 0.013,
    wearFactor: 1.0,
    heatFactor: 1.0,
    // Vertical displacement amplitude/frequency of surface texture (metres).
    bumpAmplitude: 0.004,
    bumpFrequency: 0.35,
    // Extra drag on the body when ploughing through the surface (N per m/s^2).
    dragFactor: 0.0,
    dirtPickup: 0.0,
    audio: 'asphalt'
  },
  [SurfaceType.KERB]: {
    name: 'Kerb',
    grip: 0.86,
    rollingResistance: 0.02,
    wearFactor: 1.9,
    heatFactor: 1.3,
    // Sawtooth kerbing: large amplitude, high spatial frequency. This is what
    // physically launches the wheel and unsettles the car.
    bumpAmplitude: 0.038,
    bumpFrequency: 1.55,
    dragFactor: 0.0,
    dirtPickup: 0.0,
    audio: 'kerb'
  },
  [SurfaceType.PIT_LANE]: {
    name: 'Pit Lane',
    grip: 0.94,
    rollingResistance: 0.015,
    wearFactor: 0.7,
    heatFactor: 0.7,
    bumpAmplitude: 0.005,
    bumpFrequency: 0.4,
    dragFactor: 0.0,
    dirtPickup: 0.0,
    audio: 'asphalt'
  },
  [SurfaceType.GRASS]: {
    name: 'Grass',
    grip: 0.40,
    rollingResistance: 0.085,
    wearFactor: 0.5,
    heatFactor: 0.35,
    bumpAmplitude: 0.030,
    bumpFrequency: 0.6,
    dragFactor: 2.2,
    dirtPickup: 0.9,
    audio: 'grass'
  },
  [SurfaceType.GRAVEL]: {
    name: 'Gravel',
    grip: 0.47,
    rollingResistance: 0.26,
    wearFactor: 1.4,
    heatFactor: 0.5,
    bumpAmplitude: 0.045,
    bumpFrequency: 0.9,
    dragFactor: 7.5,
    dirtPickup: 1.0,
    audio: 'gravel'
  },
  [SurfaceType.RUNOFF]: {
    name: 'Runoff',
    grip: 0.83,
    rollingResistance: 0.017,
    wearFactor: 1.15,
    heatFactor: 0.85,
    bumpAmplitude: 0.008,
    bumpFrequency: 0.45,
    dragFactor: 0.0,
    dirtPickup: 0.35,
    audio: 'asphalt'
  },
  [SurfaceType.SAND]: {
    name: 'Sand',
    grip: 0.44,
    rollingResistance: 0.30,
    wearFactor: 1.2,
    heatFactor: 0.45,
    bumpAmplitude: 0.030,
    bumpFrequency: 0.7,
    dragFactor: 9.0,
    dirtPickup: 1.0,
    audio: 'gravel'
  },
  [SurfaceType.BARRIER]: {
    name: 'Barrier',
    grip: 0.55,
    rollingResistance: 0.05,
    wearFactor: 2.5,
    heatFactor: 1.0,
    bumpAmplitude: 0.02,
    bumpFrequency: 1.0,
    dragFactor: 0.0,
    dirtPickup: 0.2,
    audio: 'asphalt'
  }
};

export function getSurface(type) {
  return SURFACES[type] || SURFACES[SurfaceType.ASPHALT];
}

/**
 * Vertical profile of a surface at a given travelled distance. Deterministic in
 * the distance parameter so the same bump is felt by every client and by the
 * server — no random shaking that would desync a multiplayer field.
 */
export function surfaceHeightOffset(surfaceType, distanceAlong, lateral) {
  const s = getSurface(surfaceType);
  if (s.bumpAmplitude <= 0) return 0;
  if (surfaceType === SurfaceType.KERB) {
    // Sawtooth ribs running across the kerb.
    const phase = distanceAlong * s.bumpFrequency * Math.PI * 2;
    const saw = Math.abs(((phase / Math.PI) % 2) - 1); // 0..1 triangle
    return saw * s.bumpAmplitude;
  }
  const a = Math.sin(distanceAlong * s.bumpFrequency * 2.1 + lateral * 0.8);
  const b = Math.sin(distanceAlong * s.bumpFrequency * 5.7 - lateral * 1.9);
  return (a * 0.65 + b * 0.35) * s.bumpAmplitude;
}

/** True when the surface should throw dust/stones and mark the tires. */
export function isLooseSurface(type) {
  return type === SurfaceType.GRAVEL || type === SurfaceType.SAND ||
         type === SurfaceType.GRASS;
}

export function isTrackSurface(type) {
  return type === SurfaceType.ASPHALT || type === SurfaceType.KERB ||
         type === SurfaceType.PIT_LANE;
}
