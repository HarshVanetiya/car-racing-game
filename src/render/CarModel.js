import * as THREE from 'three';
import { mergeStatic } from './mergeStatic.js';
import { loadCarBody, carBodyIfReady, instantiateCarBody } from './CarBodyModel.js';
import { clamp, clamp01, lerp } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  CAR MODEL
 * ============================================================================
 *
 * A stylised open-wheeler built from primitives — no asset files. The shape is
 * driven by the car's REAL dimensions, so a car with a longer wheelbase looks
 * longer, and the wheels sit exactly where the physics puts their contact
 * patches.
 *
 * The visual state is driven entirely from simulation state each frame:
 * suspension compression moves the wheels, steering turns them, wheel angular
 * velocity spins them, DRS opens the flap, and damage removes bodywork.
 */

const CHASSIS_ROUGHNESS = 0.42;

export class CarModel {
  /**
   * @param {object} carDef the car definition (real dimensions)
   * @param {object} opts { colour, accent, number, name }
   */
  constructor(carDef, opts = {}) {
    this.car = carDef;
    this.colour = new THREE.Color(opts.colour || carDef.colour);
    this.accent = new THREE.Color(opts.accent || carDef.accent || '#ffffff');

    this.group = new THREE.Group();
    this.group.name = `car-${opts.name || carDef.id}`;

    this.bodyGroup = new THREE.Group();
    this.group.add(this.bodyGroup);

    this._materials = [];
    this._build(opts);

    this.wheelMeshes = [];
    this._buildWheels();

    // The parts that move or change colour have to survive the merge below.
    for (const part of [this.frontWing, this.rearWing, this.rainLight, this.helmet]) {
      if (part) part.userData.dynamic = true;
    }
    mergeStatic(this.bodyGroup);

    // Swap in the shared car model when it is available. It is one mesh per
    // material against the procedural body's two dozen, so on a full grid it
    // is the difference between a comfortable frame rate and a bad one — and
    // it simply looks better. If it never arrives, the body built above is
    // what the player sees, and nothing else changes.
    this.usingModel = false;
    const ready = carBodyIfReady();
    if (ready) this._applyModel(ready);
    else loadCarBody(carDef.wheelbase).then((body) => { if (body) this._applyModel(body); });

    // Visual state
    this.drsOpen = 0;
    this.damageState = { frontWing: 1, rearWing: 1 };
  }

  /**
   * Replace the procedural body with the loaded model.
   *
   * The model has no separable wings, so the two parts the simulation animates
   * — the DRS flap and the wet-weather light — are carried across and placed
   * from the model's own measurements rather than hard-coded offsets.
   */
  _applyModel(source) {
    if (this.usingModel || !source) return;
    const body = instantiateCarBody(source, this.colour);

    // Sit the model on the road: the physics origin is the centre of mass,
    // which is `cogHeight` above the surface.
    body.position.y = -this.car.cogHeight;
    this.group.add(body);
    this.modelBody = body;

    const size = source.size;
    const halfLen = size.z * 0.5;

    // Re-home the animated parts onto the model.
    if (this.drsFlap) {
      body.add(this.drsFlap);
      this.drsFlap.position.set(0, size.y * 0.92, -halfLen + 0.16);
      this.drsFlap.userData.dynamic = true;
    }
    if (this.rainLight) {
      body.add(this.rainLight);
      this.rainLight.position.set(0, size.y * 0.34, -halfLen + 0.06);
      this.rainLight.userData.dynamic = true;
    }

    // Put the model's own wheels on our hubs, sized to each corner. The tyre
    // the physics is using is not the same size front and rear, and a wheel
    // that does not match its contact patch looks wrong in the way people
    // notice without being able to say why.
    if (source.wheel) this._applyModelWheels(source.wheel);

    // Everything else the procedural body drew is now redundant. Drop it
    // rather than hiding it: a hidden mesh still costs a matrix update every
    // frame, and on a full grid that is twenty cars' worth of dead weight.
    this.group.remove(this.bodyGroup);
    this.bodyGroup.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of materials) {
        const i = this._materials.indexOf(m);
        if (i >= 0) this._materials.splice(i, 1);
        m.dispose();
      }
    });
    this.bodyGroup.clear();
    this.frontWing = null;
    this.rearWing = null;
    this.helmet = null;

    this.usingModel = true;
  }

  _mat(color, opts = {}) {
    const m = new THREE.MeshStandardMaterial({
      color, roughness: opts.roughness ?? CHASSIS_ROUGHNESS,
      metalness: opts.metalness ?? 0.25, ...opts
    });
    this._materials.push(m);
    return m;
  }

  _build(opts) {
    const car = this.car;
    const bodyMat = this._mat(this.colour);
    const darkMat = this._mat(0x14161a, { roughness: 0.6, metalness: 0.1 });
    const accentMat = this._mat(this.accent, { roughness: 0.35 });
    const carbonMat = this._mat(0x1b1d22, { roughness: 0.35, metalness: 0.5 });

    const halfLen = car.bodyLength * 0.5;
    const g = this.bodyGroup;

    // --- Survival cell / monocoque ------------------------------------------
    const tub = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.42, 2.9), bodyMat);
    tub.position.set(0, -0.02, 0.15);
    tub.castShadow = true;
    g.add(tub);

    // Nose tapering to the front wing.
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.34, 1.9, 8), bodyMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, -0.06, halfLen - 1.25);
    nose.castShadow = true;
    g.add(nose);

    // --- Front wing ---------------------------------------------------------
    this.frontWing = new THREE.Group();
    const fwMain = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.06, 0.62), carbonMat);
    fwMain.position.y = -0.20;
    this.frontWing.add(fwMain);
    const fwFlap = new THREE.Mesh(new THREE.BoxGeometry(1.80, 0.05, 0.34), accentMat);
    fwFlap.position.set(0, -0.11, -0.22);
    fwFlap.rotation.x = -0.22;
    this.frontWing.add(fwFlap);
    for (const side of [-1, 1]) {
      const endplate = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.72), bodyMat);
      endplate.position.set(side * 0.92, -0.10, -0.02);
      this.frontWing.add(endplate);
    }
    this.frontWing.position.set(0, 0, halfLen - 0.28);
    g.add(this.frontWing);

    // --- Sidepods -----------------------------------------------------------
    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.42, 1.9), bodyMat);
      pod.position.set(side * 0.62, -0.04, -0.35);
      pod.castShadow = true;
      g.add(pod);
      // Inlet
      const inlet = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.30, 0.12), darkMat);
      inlet.position.set(side * 0.62, 0.0, 0.62);
      g.add(inlet);
      // Bargeboard
      const bb = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.30, 0.85), carbonMat);
      bb.position.set(side * 0.50, -0.16, 0.85);
      g.add(bb);
    }

    // --- Floor --------------------------------------------------------------
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.05, 3.9), carbonMat);
    floor.position.set(0, -0.25, -0.15);
    g.add(floor);

    // --- Cockpit ------------------------------------------------------------
    const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.26, 1.0), darkMat);
    cockpit.position.set(0, 0.2, 0.55);
    g.add(cockpit);
    // Halo
    const haloMat = this._mat(0x0d0f12, { roughness: 0.4, metalness: 0.6 });
    const haloRing = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.045, 8, 20, Math.PI), haloMat);
    haloRing.rotation.x = Math.PI / 2;
    haloRing.rotation.z = Math.PI;
    haloRing.position.set(0, 0.42, 0.52);
    g.add(haloRing);
    const haloPost = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.30, 0.07), haloMat);
    haloPost.position.set(0, 0.30, 0.98);
    g.add(haloPost);
    // Driver helmet — a visible reference for how much the car is moving.
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), accentMat);
    helmet.position.set(0, 0.30, 0.42);
    this.helmet = helmet;
    g.add(helmet);

    // --- Airbox and engine cover -------------------------------------------
    const airbox = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.55, 8), bodyMat);
    airbox.rotation.x = -Math.PI / 2;
    airbox.position.set(0, 0.36, 0.02);
    g.add(airbox);
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.36, 1.7), bodyMat);
    cover.position.set(0, 0.10, -0.95);
    cover.castShadow = true;
    g.add(cover);
    const shark = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.30, 1.5), bodyMat);
    shark.position.set(0, 0.34, -1.05);
    g.add(shark);

    // --- Rear wing ----------------------------------------------------------
    this.rearWing = new THREE.Group();
    const rwMain = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.05, 0.36), carbonMat);
    rwMain.position.y = 0.22;
    this.rearWing.add(rwMain);
    // The DRS flap, rotated when the system is deployed.
    this.drsFlap = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.04, 0.26), accentMat);
    this.drsFlap.position.set(0, 0.36, -0.10);
    this.rearWing.add(this.drsFlap);
    for (const side of [-1, 1]) {
      const ep = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.52, 0.46), bodyMat);
      ep.position.set(side * 0.53, 0.28, -0.02);
      this.rearWing.add(ep);
    }
    this.rearWing.position.set(0, 0.18, -halfLen + 0.42);
    this.rearWing.castShadow = true;
    g.add(this.rearWing);

    // Diffuser
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.22, 0.55), carbonMat);
    diffuser.position.set(0, -0.18, -halfLen + 0.60);
    diffuser.rotation.x = 0.28;
    g.add(diffuser);

    // Rain light — lit in the wet, as required by the rules.
    this.rainLight = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.12, 0.06),
      this._mat(0x400000, { emissive: 0x000000, roughness: 0.3 })
    );
    this.rainLight.position.set(0, -0.05, -halfLen + 0.35);
    g.add(this.rainLight);

    // Number panel
    if (opts.number) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.22, 0.30), accentMat);
      panel.position.set(0.40, 0.10, 0.10);
      g.add(panel);
    }
  }

  /**
   * Swap the procedural tyres for the model's, keeping everything the
   * simulation needs to show through them: the compound band on the sidewall
   * and the brake disc that glows when a corner is being overworked.
   */
  _applyModelWheels(wheel) {
    const car = this.car;
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const w = this.wheelMeshes[i];
      const front = w.front;
      const radius = front ? car.wheelRadiusFront : car.wheelRadiusRear;
      const width = front ? car.tireWidthFront : car.tireWidthRear;

      const mesh = new THREE.Mesh(wheel.geometry, this.tyreMat);
      const radial = radius / Math.max(wheel.radius, 1e-4);
      const axial = width / Math.max(wheel.width, 1e-4);
      // The axle runs along X, so width scales on that axis alone.
      mesh.scale.set(axial * (i % 2 === 0 ? -1 : 1), radial, radial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      // Drop the procedural tyre, rim and spoke; keep the rest.
      for (const child of [...w.spinner.children]) {
        if (child.userData.keep) continue;
        w.spinner.remove(child);
        if (child.geometry) child.geometry.dispose();
      }
      w.spinner.add(mesh);
    }
  }

  _buildWheels() {
    const car = this.car;
    const tyreMat = new THREE.MeshStandardMaterial({
      color: 0x14161a, roughness: 0.95, metalness: 0.0
    });
    this._materials.push(tyreMat);
    this.tyreMat = tyreMat;
    // A coloured sidewall band, so compound is readable at a glance.
    this.sidewallMats = [];

    const halfFront = car.trackFront * 0.5;
    const halfRear = car.trackRear * 0.5;
    const a = car.wheelbase * (1 - car.frontWeightBias);
    const b = car.wheelbase * car.frontWeightBias;

    const specs = [
      { x: -halfFront, z: a, r: car.wheelRadiusFront, w: car.tireWidthFront, front: true },
      { x: halfFront, z: a, r: car.wheelRadiusFront, w: car.tireWidthFront, front: true },
      { x: -halfRear, z: -b, r: car.wheelRadiusRear, w: car.tireWidthRear, front: false },
      { x: halfRear, z: -b, r: car.wheelRadiusRear, w: car.tireWidthRear, front: false }
    ];

    for (const spec of specs) {
      // Steering pivot -> spin axis, so the two rotations do not fight.
      const pivot = new THREE.Group();
      pivot.position.set(spec.x, -car.cogHeight + spec.r, spec.z);

      const spinner = new THREE.Group();
      const tyre = new THREE.Mesh(
        new THREE.CylinderGeometry(spec.r, spec.r, spec.w, 18, 1),
        tyreMat
      );
      tyre.rotation.z = Math.PI / 2;
      tyre.castShadow = true;
      spinner.add(tyre);

      const sidewallMat = new THREE.MeshStandardMaterial({
        color: 0xf2c53d, roughness: 0.7, emissive: 0x000000
      });
      this.sidewallMats.push(sidewallMat);
      this._materials.push(sidewallMat);
      for (const s of [-1, 1]) {
        const band = new THREE.Mesh(
          new THREE.TorusGeometry(spec.r * 0.82, 0.022, 6, 18), sidewallMat
        );
        band.rotation.y = Math.PI / 2;
        band.position.x = s * spec.w * 0.48;
        // The compound colour has to survive the model swap: it is the only
        // way to see at a glance what everyone is running.
        band.userData.keep = true;
        spinner.add(band);
      }

      const rim = new THREE.Mesh(
        new THREE.CylinderGeometry(spec.r * 0.62, spec.r * 0.62, spec.w * 0.9, 10),
        new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.3, metalness: 0.85 })
      );
      rim.rotation.z = Math.PI / 2;
      spinner.add(rim);
      // A spoke, so the wheel visibly rotates.
      const spoke = new THREE.Mesh(
        new THREE.BoxGeometry(spec.w * 0.95, spec.r * 1.1, 0.05),
        new THREE.MeshStandardMaterial({ color: 0x6a707a, roughness: 0.4, metalness: 0.7 })
      );
      spinner.add(spoke);

      // Brake disc, which glows when it is hot.
      const discMat = new THREE.MeshStandardMaterial({
        color: 0x2a2a2a, emissive: 0x000000, roughness: 0.5
      });
      this._materials.push(discMat);
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(spec.r * 0.55, spec.r * 0.55, 0.05, 14), discMat
      );
      disc.rotation.z = Math.PI / 2;
      pivot.add(disc);

      pivot.add(spinner);
      this.group.add(pivot);
      this.wheelMeshes.push({
        pivot, spinner, disc, discMat, sidewallMat,
        front: spec.front, restY: pivot.position.y
      });
    }
  }

  /**
   * Drive the model from simulation state.
   *
   * @param {object} state {
   *   position, orientation, steerAngle, wheels: [{compression, spinAngle,
   *   temp}], drs, damage, compound, wetLight
   * }
   */
  update(state, dt) {
    this.group.position.copy(state.position);
    this.group.quaternion.set(
      state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w
    );

    // --- Wheels -------------------------------------------------------------
    for (let i = 0; i < 4; i++) {
      const w = this.wheelMeshes[i];
      const s = state.wheels?.[i];
      if (!s) continue;
      // Suspension compression raises the wheel relative to the body.
      w.pivot.position.y = w.restY + (s.compression || 0);
      if (w.front) w.pivot.rotation.y = state.steerAngle || 0;
      w.spinner.rotation.x = s.spinAngle || 0;

      // Brake glow: a real, readable cue that a corner is being overworked.
      if (s.brakeTemp != null) {
        const heat = clamp01((s.brakeTemp - 420) / 480);
        w.discMat.emissive.setRGB(heat * 0.95, heat * heat * 0.28, 0);
      }
      // Tire compound colour on the sidewall.
      if (s.compoundColour) w.sidewallMat.color.set(s.compoundColour);
      // Overheating tires glow faintly.
      if (s.tireTemp != null) {
        const over = clamp01((s.tireTemp - 125) / 70);
        w.sidewallMat.emissive.setRGB(over * 0.5, over * 0.08, 0);
      }
    }

    // --- DRS ----------------------------------------------------------------
    const drsTarget = state.drs ? 1 : 0;
    this.drsOpen += (drsTarget - this.drsOpen) * Math.min(1, dt * 8);
    this.drsFlap.rotation.x = -this.drsOpen * 1.15;

    // --- Damage -------------------------------------------------------------
    // Wing damage is shown by the wings themselves, which only the procedural
    // body has as separate pieces. On the model the damage still reads through
    // the debris, the handling and the HUD.
    if (state.damage && !this.usingModel) {
      const fw = state.damage.frontWing ?? 1;
      const rw = state.damage.rearWing ?? 1;
      // A destroyed wing is gone; a damaged one hangs askew.
      this.frontWing.visible = fw > 0.05;
      this.frontWing.rotation.z = (1 - fw) * 0.35;
      this.frontWing.position.y = -(1 - fw) * 0.08;
      this.rearWing.visible = rw > 0.05;
      this.rearWing.rotation.z = (1 - rw) * 0.22;
    }

    // --- Rain light ---------------------------------------------------------
    if (state.wetLight) {
      this.rainLight.material.emissive.setHex(0xcc1010);
      this.rainLight.material.color.setHex(0xff3020);
    } else {
      this.rainLight.material.emissive.setHex(0x000000);
      this.rainLight.material.color.setHex(0x400000);
    }

    // Driver's head leans with lateral load — a small thing that makes the
    // g-forces legible from outside the car.
    if (this.helmet && !this.usingModel && state.lateralG != null) {
      this.helmet.position.x = clamp(-state.lateralG * 0.035, -0.09, 0.09);
    }
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this._materials) m.dispose();
  }
}
