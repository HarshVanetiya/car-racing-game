import { Vec3, tmpVec } from '../math/Vec3.js';
import { clamp, clamp01, lerp } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  COLLISIONS
 * ============================================================================
 *
 * Cars are approximated by a small set of spheres: three along the survival
 * cell and one at each wheel. Spheres are cheap, always produce a well-defined
 * contact normal, and — most importantly here — give wheel-to-wheel contact for
 * free, which is the interaction that actually decides open-wheel racing
 * incidents.
 *
 * Contacts are solved with impulses rather than forces. A force-based contact
 * at these masses and closing speeds would need a timestep far shorter than the
 * rest of the simulation to stay stable.
 */

/** Restitution — race cars are not bouncy; most energy goes into deformation. */
const RESTITUTION_CAR = 0.14;
const RESTITUTION_BARRIER = 0.28;
const FRICTION_CAR = 0.42;
const FRICTION_BARRIER = 0.55;
/** Fraction of penetration corrected per step (Baumgarte stabilisation). */
const POSITION_CORRECTION = 0.28;
const PENETRATION_SLOP = 0.012;

export const ColliderKind = { BODY: 0, WHEEL: 1, WING: 2 };

/**
 * Build the collision proxy for a vehicle from its real geometry, so a longer
 * car really does have a longer collision footprint.
 */
export function buildColliders(vehicle) {
  const car = vehicle.car;
  const halfLen = car.bodyLength * 0.5;
  const bodyR = car.bodyWidth * 0.24;
  const noseR = car.bodyWidth * 0.16;

  const colliders = [
    // Nose / front wing — the part that breaks first.
    { local: new Vec3(0, -0.10, halfLen - 0.42), radius: noseR, kind: ColliderKind.WING },
    { local: new Vec3(0, 0.02, halfLen - 1.55), radius: bodyR, kind: ColliderKind.BODY },
    // Cockpit / sidepods.
    { local: new Vec3(0, 0.05, 0.10), radius: bodyR * 1.15, kind: ColliderKind.BODY },
    // Engine cover and rear wing.
    { local: new Vec3(0, 0.05, -halfLen + 1.35), radius: bodyR, kind: ColliderKind.BODY },
    { local: new Vec3(0, 0.12, -halfLen + 0.38), radius: noseR * 1.1, kind: ColliderKind.WING }
  ];

  // One sphere per wheel, at the wheel centre.
  for (const w of vehicle.wheels) {
    colliders.push({
      local: new Vec3(w.position.x, w.position.y - w.restLength, w.position.z),
      radius: w.radius * 0.94,
      kind: ColliderKind.WHEEL,
      wheelIndex: w.index
    });
  }
  return colliders;
}

/** Broad-phase radius so pairs far apart are rejected immediately. */
export function boundingRadius(vehicle) {
  return vehicle.car.bodyLength * 0.5 + 0.35;
}

const _worldA = new Vec3();
const _worldB = new Vec3();
const _normal = new Vec3();
const _ra = new Vec3();
const _rb = new Vec3();
const _vRel = new Vec3();
const _va = new Vec3();
const _vb = new Vec3();
const _impulse = new Vec3();
const _tangent = new Vec3();
const _contact = new Vec3();
const _localPoint = new Vec3();

/**
 * Solve all contacts between two vehicles.
 *
 * @returns {object|null} impact summary for audio, damage and race incidents
 */
export function resolveCarCar(a, b, opts = {}) {
  if (a.retired || b.retired) return null;
  const collisionsEnabled = opts.collisions !== false;

  const broad = boundingRadius(a) + boundingRadius(b);
  if (a.body.position.distanceToSq(b.body.position) > broad * broad) return null;

  if (!a._colliders) a._colliders = buildColliders(a);
  if (!b._colliders) b._colliders = buildColliders(b);

  let strongest = null;
  let totalImpulse = 0;
  let contacts = 0;

  for (const ca of a._colliders) {
    a.body.localToWorldPoint(ca.local, _worldA);
    for (const cb of b._colliders) {
      b.body.localToWorldPoint(cb.local, _worldB);

      const dx = _worldB.x - _worldA.x;
      const dy = _worldB.y - _worldA.y;
      const dz = _worldB.z - _worldA.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const rSum = ca.radius + cb.radius;
      if (distSq >= rSum * rSum) continue;

      const dist = Math.sqrt(Math.max(distSq, 1e-9));
      const penetration = rSum - dist;
      _normal.set(dx / dist, dy / dist, dz / dist); // points from A toward B

      // Contact point midway between the two sphere surfaces.
      _contact.copy(_worldA).addScaled(_normal, ca.radius - penetration * 0.5);

      _ra.subVectors(_contact, a.body.position);
      _rb.subVectors(_contact, b.body.position);

      a.body.pointVelocity(_ra, _va);
      b.body.pointVelocity(_rb, _vb);
      _vRel.subVectors(_vb, _va);

      const vn = _vRel.dot(_normal);
      const closing = -vn;

      // Wheel-to-wheel contact is far more violent than bodywork: interlocked
      // rotating wheels launch cars, so those contacts get more restitution.
      const wheelPair = ca.kind === ColliderKind.WHEEL && cb.kind === ColliderKind.WHEEL;
      const restitution = wheelPair ? RESTITUTION_CAR + 0.22 : RESTITUTION_CAR;

      contacts++;

      if (!collisionsEnabled) continue;

      if (vn < 0) {
        // --- Normal impulse ---------------------------------------------
        const effMass = a.body.effectiveInvMass(_normal, _ra) +
                        b.body.effectiveInvMass(_normal, _rb);
        if (effMass < 1e-9) continue;

        let j = -(1 + restitution) * vn / effMass;
        j = Math.max(0, j);

        _impulse.copy(_normal).scale(j);
        a.body.applyImpulseAtPoint(tmpVec().copy(_impulse).negate(), _ra);
        b.body.applyImpulseAtPoint(_impulse, _rb);

        totalImpulse += j;

        // --- Friction impulse -------------------------------------------
        a.body.pointVelocity(_ra, _va);
        b.body.pointVelocity(_rb, _vb);
        _vRel.subVectors(_vb, _va);
        _tangent.copy(_vRel).addScaled(_normal, -_vRel.dot(_normal));
        const tLen = _tangent.length();
        if (tLen > 0.05) {
          _tangent.scale(1 / tLen);
          const effT = a.body.effectiveInvMass(_tangent, _ra) +
                       b.body.effectiveInvMass(_tangent, _rb);
          let jt = -_vRel.dot(_tangent) / effT;
          const maxFriction = FRICTION_CAR * j;
          jt = clamp(jt, -maxFriction, maxFriction);
          _impulse.copy(_tangent).scale(jt);
          a.body.applyImpulseAtPoint(tmpVec().copy(_impulse).negate(), _ra);
          b.body.applyImpulseAtPoint(_impulse, _rb);
        }

        // --- Damage -------------------------------------------------------
        // Energy is taken from the closing speed rather than absolute speed,
        // so two cars touching at 300 km/h side by side barely scratch while a
        // rear-ender at 60 km/h closing does real harm.
        const reducedMass = 1 / (a.body.invMass + b.body.invMass);
        const energy = 0.5 * reducedMass * closing * closing;

        if (!strongest || energy > strongest.energy) {
          a.body.worldToLocalPoint(_contact, _localPoint);
          strongest = {
            energy,
            closing,
            point: _contact.clone(),
            localA: _localPoint.clone(),
            localB: b.body.worldToLocalPoint(_contact, new Vec3()),
            wheelPair,
            kindA: ca.kind,
            kindB: cb.kind,
            a: a.id,
            b: b.id
          };
        }
      }

      // --- Positional correction -----------------------------------------
      // Impulses alone leave cars interpenetrating; a small positional push
      // keeps them apart without injecting energy.
      const corr = Math.max(penetration - PENETRATION_SLOP, 0) * POSITION_CORRECTION;
      if (corr > 0) {
        const totalInvMass = a.body.invMass + b.body.invMass;
        if (totalInvMass > 1e-9) {
          const sa = (a.body.invMass / totalInvMass) * corr;
          const sb = (b.body.invMass / totalInvMass) * corr;
          a.body.position.addScaled(_normal, -sa);
          b.body.position.addScaled(_normal, sb);
        }
      }
    }
  }

  if (strongest && collisionsEnabled) {
    applyImpactDamage(a, strongest.localA, strongest.energy, strongest.wheelPair, strongest.kindA);
    applyImpactDamage(b, strongest.localB, strongest.energy, strongest.wheelPair, strongest.kindB);
    strongest.totalImpulse = totalImpulse;
    strongest.contacts = contacts;
  }
  return strongest;
}

function applyImpactDamage(vehicle, local, energy, wheelPair, kind) {
  // A wing takes far more of the impact than a wheel or the survival cell.
  const severity = kind === ColliderKind.WING ? 1.35
                 : kind === ColliderKind.WHEEL ? 0.55
                 : 0.85;
  const event = vehicle.damage.applyImpact(energy, local, severity);
  if (event) {
    vehicle.events.push({ type: 'damage', parts: event.parts, energy });
  }
  if (wheelPair && energy > 8000) {
    for (let i = 0; i < 4; i++) {
      if (vehicle.damage.tryPuncture(i, energy, vehicle.rng)) {
        vehicle.events.push({ type: 'puncture', wheel: i });
        break;
      }
    }
  }
  vehicle.events.push({ type: 'collision', energy, kind });
  vehicle.lastCollision = { energy, kind, time: Date.now() };
}

/**
 * Resolve a vehicle against the trackside barriers.
 *
 * @param {Vehicle} vehicle
 * @param {object} barrierQuery  must expose queryBarrier(point, radius, out)
 *                               returning { hit, point, normal, penetration, type }
 */
export function resolveBarriers(vehicle, barrierQuery) {
  if (vehicle.retired || !barrierQuery) return null;
  if (!vehicle._colliders) vehicle._colliders = buildColliders(vehicle);

  let strongest = null;
  const hit = vehicle._barrierHit || (vehicle._barrierHit = {
    hit: false, point: new Vec3(), normal: new Vec3(), penetration: 0, type: 0
  });

  for (const c of vehicle._colliders) {
    vehicle.body.localToWorldPoint(c.local, _worldA);
    if (!barrierQuery.queryBarrier(_worldA, c.radius, hit)) continue;

    _normal.copy(hit.normal); // points away from the barrier, into the track
    _ra.subVectors(hit.point, vehicle.body.position);
    vehicle.body.pointVelocity(_ra, _va);

    const vn = _va.dot(_normal);
    if (vn < 0) {
      const effMass = vehicle.body.effectiveInvMass(_normal, _ra);
      if (effMass > 1e-9) {
        // Tecpro and tyre walls absorb energy; a concrete wall does not.
        const absorb = hit.type === 1 ? 0.55 : 1.0;
        let j = -(1 + RESTITUTION_BARRIER * absorb) * vn / effMass;
        j = Math.max(0, j);
        _impulse.copy(_normal).scale(j);
        vehicle.body.applyImpulseAtPoint(_impulse, _ra);

        // Friction along the wall — this is what scrubs speed off a car
        // sliding down a barrier rather than letting it glance away cleanly.
        vehicle.body.pointVelocity(_ra, _va);
        _tangent.copy(_va).addScaled(_normal, -_va.dot(_normal));
        const tLen = _tangent.length();
        if (tLen > 0.05) {
          _tangent.scale(1 / tLen);
          const effT = vehicle.body.effectiveInvMass(_tangent, _ra);
          let jt = clamp(-_va.dot(_tangent) / effT, -FRICTION_BARRIER * j, FRICTION_BARRIER * j);
          vehicle.body.applyImpulseAtPoint(tmpVec().copy(_tangent).scale(jt), _ra);
        }

        const closing = -vn;
        const energy = 0.5 * vehicle.body.mass * closing * closing * absorb;
        if (!strongest || energy > strongest.energy) {
          strongest = {
            energy, closing, barrier: true,
            point: hit.point.clone(),
            local: vehicle.body.worldToLocalPoint(hit.point, new Vec3()),
            kind: c.kind
          };
        }
      }
    }

    const corr = Math.max(hit.penetration - PENETRATION_SLOP, 0) * POSITION_CORRECTION * 1.6;
    if (corr > 0) vehicle.body.position.addScaled(_normal, corr);
  }

  if (strongest) {
    applyImpactDamage(vehicle, strongest.local, strongest.energy, false, strongest.kind);
  }
  return strongest;
}

/**
 * Solve the whole field. Several iterations let contacts in a multi-car pile-up
 * settle instead of squirting cars out of the stack.
 */
export function solveCollisions(vehicles, barrierQuery, opts = {}) {
  const impacts = [];
  const iterations = opts.iterations ?? 3;

  for (let iter = 0; iter < iterations; iter++) {
    const first = iter === 0;
    for (let i = 0; i < vehicles.length; i++) {
      for (let j = i + 1; j < vehicles.length; j++) {
        const r = resolveCarCar(vehicles[i], vehicles[j], opts);
        if (r && first) impacts.push(r);
      }
    }
    if (barrierQuery) {
      for (const v of vehicles) {
        const r = resolveBarriers(v, barrierQuery);
        if (r && first) impacts.push(r);
      }
    }
  }
  return impacts;
}
