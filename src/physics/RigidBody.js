import { Vec3, tmpVec } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { Mat3 } from '../math/Mat3.js';

/**
 * A 6-DOF rigid body integrated with semi-implicit Euler.
 *
 * Everything the car does — pitching under brakes, squatting under power,
 * rolling into a corner, snapping into oversteer — comes out of applying tire
 * and aero forces at their real world positions on *this* body. There is no
 * separate "weight transfer" system; load transfer is simply what happens when
 * a longitudinal force is applied at ground level to a body whose centre of
 * mass sits some distance above it.
 */
export class RigidBody {
  constructor() {
    this.position = new Vec3();
    this.orientation = new Quat();
    this.velocity = new Vec3();          // world-space linear velocity (m/s)
    this.angularVelocity = new Vec3();   // world-space angular velocity (rad/s)

    this.mass = 1;
    this.invMass = 1;
    this.inertia = new Vec3(1, 1, 1);        // body-frame diagonal
    this.invInertia = new Vec3(1, 1, 1);

    this.force = new Vec3();
    this.torque = new Vec3();

    this.rotMatrix = new Mat3();
    this.invInertiaWorld = new Mat3();

    // Cached body axes in world space, refreshed once per substep.
    this.right = new Vec3(1, 0, 0);
    this.up = new Vec3(0, 1, 0);
    this.forward = new Vec3(0, 0, 1);

    // Acceleration measured between substeps — drives camera feel, the g-meter
    // and the driver's seat-of-the-pants cues.
    this.acceleration = new Vec3();
    this._prevVelocity = new Vec3();

    this.gravity = new Vec3(0, -9.80665, 0);
    this.enabled = true;
  }

  setMass(mass) {
    this.mass = Math.max(1e-3, mass);
    this.invMass = 1 / this.mass;
    return this;
  }

  /**
   * Inertia of a solid box approximation. An open-wheel car is long and narrow,
   * so yaw inertia is dominated by the wheelbase and roll inertia by track
   * width; using the real dimensions keeps rotational response believable.
   */
  setBoxInertia(mass, width, height, length, scale = 1) {
    const m = mass * scale;
    const ix = (m / 12) * (height * height + length * length); // pitch
    const iy = (m / 12) * (width * width + length * length);   // yaw
    const iz = (m / 12) * (width * width + height * height);   // roll
    this.inertia.set(ix, iy, iz);
    this.invInertia.set(1 / ix, 1 / iy, 1 / iz);
    return this;
  }

  /** Refresh cached rotation matrix, world inverse inertia and body axes. */
  updateDerived() {
    this.rotMatrix.setFromQuat(this.orientation);
    this.invInertiaWorld.setWorldInverseInertia(this.rotMatrix, this.invInertia);
    const m = this.rotMatrix.m;
    this.right.set(m[0], m[3], m[6]);
    this.up.set(m[1], m[4], m[7]);
    this.forward.set(m[2], m[5], m[8]);
    return this;
  }

  clearAccumulators() {
    this.force.setZero();
    this.torque.setZero();
    return this;
  }

  /** Apply a world-space force at the centre of mass (no torque). */
  applyCentralForce(f) {
    this.force.add(f);
    return this;
  }

  /**
   * Apply a world-space force at a world-space point offset from the centre of
   * mass. This is the single most important call in the whole simulation: tire
   * forces enter here at the contact patch, and the resulting torque is what
   * pitches, rolls and yaws the car.
   */
  applyForceAtPoint(f, worldOffset) {
    this.force.add(f);
    const t = tmpVec().crossVectors(worldOffset, f);
    this.torque.add(t);
    return this;
  }

  applyTorque(t) {
    this.torque.add(t);
    return this;
  }

  /** Instantaneous velocity of a point rigidly attached at `worldOffset`. */
  pointVelocity(worldOffset, out = new Vec3()) {
    out.crossVectors(this.angularVelocity, worldOffset);
    out.add(this.velocity);
    return out;
  }

  /** Transform a body-local vector into world space. */
  localToWorldDir(local, out = new Vec3()) {
    return this.rotMatrix.transformVector(local, out);
  }

  /** Transform a body-local point into world space. */
  localToWorldPoint(local, out = new Vec3()) {
    this.rotMatrix.transformVector(local, out);
    out.add(this.position);
    return out;
  }

  worldToLocalDir(world, out = new Vec3()) {
    return this.orientation.rotateVectorInverse(world, out);
  }

  worldToLocalPoint(world, out = new Vec3()) {
    const d = tmpVec().subVectors(world, this.position);
    return this.orientation.rotateVectorInverse(d, out);
  }

  /**
   * Apply an instantaneous impulse at a point — used by the collision solver,
   * where forces over a timestep would be far too stiff to be stable.
   */
  applyImpulseAtPoint(impulse, worldOffset) {
    this.velocity.addScaled(impulse, this.invMass);
    const angImp = tmpVec().crossVectors(worldOffset, impulse);
    const dOmega = this.invInertiaWorld.transformVector(angImp, new Vec3());
    this.angularVelocity.add(dOmega);
    return this;
  }

  /** Effective inverse mass along `dir` for a contact at `worldOffset`. */
  effectiveInvMass(dir, worldOffset) {
    const rxn = new Vec3().crossVectors(worldOffset, dir);
    const i = this.invInertiaWorld.transformVector(rxn, new Vec3());
    const t = new Vec3().crossVectors(i, worldOffset);
    return this.invMass + t.dot(dir);
  }

  /** Semi-implicit Euler integration of the accumulated force and torque. */
  integrate(dt) {
    if (!this.enabled) return;
    this._prevVelocity.copy(this.velocity);

    // Linear
    this.velocity.addScaled(this.force, this.invMass * dt);
    this.velocity.addScaled(this.gravity, dt);
    this.position.addScaled(this.velocity, dt);

    // Angular. The gyroscopic term is intentionally omitted: at racing yaw
    // rates it is negligible and it costs stability at large timesteps.
    const dOmega = this.invInertiaWorld.transformVector(this.torque, tmpVec());
    this.angularVelocity.addScaled(dOmega, dt);
    this.orientation.integrate(this.angularVelocity, dt);

    // Measured acceleration excluding gravity, for camera/HUD g-forces.
    this.acceleration
      .subVectors(this.velocity, this._prevVelocity)
      .scale(1 / Math.max(dt, 1e-6))
      .addScaled(this.gravity, -1);

    this.updateDerived();
  }

  /** Guard against a NaN cascade poisoning the whole race state. */
  sanitize(fallbackPosition) {
    if (!this.position.isFinite() || !this.velocity.isFinite() ||
        !this.angularVelocity.isFinite() ||
        !Number.isFinite(this.orientation.x + this.orientation.y +
                         this.orientation.z + this.orientation.w)) {
      if (fallbackPosition) this.position.copy(fallbackPosition);
      this.velocity.setZero();
      this.angularVelocity.setZero();
      this.orientation.identity();
      this.updateDerived();
      return false;
    }
    return true;
  }

  /** Local-frame velocity: x = lateral, y = vertical, z = longitudinal. */
  getLocalVelocity(out = new Vec3()) {
    return this.orientation.rotateVectorInverse(this.velocity, out);
  }

  get speed() {
    return this.velocity.length();
  }

  /** Signed forward speed — negative when the car is rolling backwards. */
  get forwardSpeed() {
    return this.velocity.dot(this.forward);
  }
}
