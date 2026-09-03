import * as THREE from 'three';
import { TrackBuilder } from './TrackBuilder.js';
import { CarModel } from './CarModel.js';
import { CameraRig, CameraMode } from './CameraRig.js';
import { SkidMarks, ParticleSystem, CarEffects } from './Effects.js';
import { getCompound } from '../physics/Tire.js';
import { clamp, clamp01, lerp, damp } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  RENDERER
 * ============================================================================
 *
 * Scene, lighting, sky, weather visuals, cars and effects.
 *
 * The renderer never simulates anything — it reads simulation state and draws
 * it. That separation is what lets the same physics run headless on the server.
 */

/** Sky and lighting presets keyed to the weather. */
const SKY = {
  clear: { top: 0x5a8fd0, bottom: 0xbcd4ea, sun: 0xfff4e0, sunIntensity: 2.2, ambient: 0x9db4cc, ambientIntensity: 1.9, fog: 0xb8cee2, fogDensity: 0.00035 },
  overcast: { top: 0x7d8592, bottom: 0xa8b0bb, sun: 0xd8dce2, sunIntensity: 1.0, ambient: 0x9aa4b2, ambientIntensity: 2.2, fog: 0x9aa3ae, fogDensity: 0.0011 },
  storm: { top: 0x424852, bottom: 0x646c78, sun: 0xa8adb6, sunIntensity: 0.55, ambient: 0x6b737e, ambientIntensity: 2.4, fog: 0x666e79, fogDensity: 0.0026 }
};

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.quality = opts.quality || 'high';

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.25));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = this.quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.25, 6000);

    this._buildSky();
    this._buildLights();

    this.skids = new SkidMarks(this.scene);
    this.particles = new ParticleSystem(this.scene);
    this.effects = new CarEffects(this.skids, this.particles);

    this.carModels = new Map();
    this.trackBuilder = null;
    this.cameraRig = null;

    this._rainGroup = null;
    this._weatherBlend = { fogDensity: SKY.clear.fogDensity, sunIntensity: SKY.clear.sunIntensity };
    this._racingLineMesh = null;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  // -------------------------------------------------------------------------
  //  Scene setup
  // -------------------------------------------------------------------------

  _buildSky() {
    // A gradient dome rather than a texture: cheap, and it recolours instantly
    // when the weather changes.
    const geo = new THREE.SphereGeometry(3000, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(SKY.clear.top) },
        bottomColor: { value: new THREE.Color(SKY.clear.bottom) },
        offset: { value: 120 },
        exponent: { value: 0.75 }
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPosition = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, pow(max(h, 0.0), exponent)), 1.0);
        }`
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.scene.fog = new THREE.FogExp2(SKY.clear.fog, SKY.clear.fogDensity);
  }

  _buildLights() {
    this.sun = new THREE.DirectionalLight(SKY.clear.sun, SKY.clear.sunIntensity);
    this.sun.position.set(-380, 620, 260);
    if (this.quality !== 'low') {
      this.sun.castShadow = true;
      const size = this.quality === 'high' ? 2048 : 1024;
      this.sun.shadow.mapSize.set(size, size);
      // Shadow camera follows the player, so a big circuit still gets crisp
      // shadows near the car.
      const d = 90;
      this.sun.shadow.camera.left = -d;
      this.sun.shadow.camera.right = d;
      this.sun.shadow.camera.top = d;
      this.sun.shadow.camera.bottom = -d;
      this.sun.shadow.camera.near = 1;
      this.sun.shadow.camera.far = 1400;
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.03;
    }
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight(
      SKY.clear.ambient, 0x5a6350, SKY.clear.ambientIntensity
    );
    this.scene.add(this.ambient);
  }

  // -------------------------------------------------------------------------
  //  Content
  // -------------------------------------------------------------------------

  buildTrack(track) {
    if (this.trackBuilder) {
      this.scene.remove(this.trackBuilder.group);
      this.trackBuilder.dispose();
    }
    this.track = track;
    this.trackBuilder = new TrackBuilder(track, { quality: this.quality });
    this.scene.add(this.trackBuilder.build());
    this.cameraRig = new CameraRig(this.camera, track);
    // The racing-line guide needs a speed profile for the player's actual car,
    // so it is built later by `buildRacingLineGuide` once that car exists.
    return this.trackBuilder;
  }

  /**
   * The optional racing-line assist: a ribbon coloured by what the driver
   * should be doing — green on the throttle, amber easing off, red braking.
   * The colours come from the speed profile, so the guide is exactly what the
   * AI itself would do, not a hand-drawn hint.
   */
  buildRacingLineGuide(profile) {
    if (this._racingLineMesh) {
      this.scene.remove(this._racingLineMesh);
      this._racingLineMesh.geometry.dispose();
      this._racingLineMesh.material.dispose();
      this._racingLineMesh = null;
    }
    if (!profile || !this.track) return;

    const t = this.track;
    const step = 2;
    const positions = [], colours = [], indices = [];
    let v = 0;
    const width = 0.85;

    for (let i = 0; i < t.sampleCount; i += step) {
      const off = t.lineRacing[i];
      const p0 = t.pointAt(t.dist[i], off - width);
      const p1 = t.pointAt(t.dist[i], off + width);
      positions.push(p0.x, p0.y + 0.03, p0.z, p1.x, p1.y + 0.03, p1.z);

      // Colour from what the profile says happens next.
      const here = profile.speed[i];
      const ahead = profile.speed[(i + Math.round(18 / t.sampleSpacing)) % t.sampleCount];
      const delta = ahead - here;
      let r, g, b;
      if (delta < -1.5) { r = 0.92; g = 0.13; b = 0.10; }        // braking
      else if (delta < -0.2) { r = 0.95; g = 0.62; b = 0.10; }   // easing off
      else if (delta > 1.5) { r = 0.16; g = 0.85; b = 0.30; }    // full throttle
      else { r = 0.22; g = 0.62; b = 0.90; }                     // steady
      colours.push(r, g, b, r, g, b);

      if (v >= 2) indices.push(v - 2, v, v - 1, v, v + 1, v - 1);
      v += 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    geo.setIndex(indices);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.42,
      depthWrite: false, polygonOffset: true,
      polygonOffsetFactor: -6, polygonOffsetUnits: -6
    });
    this._racingLineMesh = new THREE.Mesh(geo, mat);
    this._racingLineMesh.renderOrder = 3;
    this._racingLineMesh.visible = false;
    this.scene.add(this._racingLineMesh);
  }

  setRacingLineVisible(v) {
    if (this._racingLineMesh) this._racingLineMesh.visible = !!v;
  }

  addCar(id, carDef, opts) {
    if (this.carModels.has(id)) return this.carModels.get(id);
    const model = new CarModel(carDef, opts);
    this.scene.add(model.group);
    this.carModels.set(id, model);
    return model;
  }

  removeCar(id) {
    const m = this.carModels.get(id);
    if (!m) return;
    this.scene.remove(m.group);
    m.dispose();
    this.carModels.delete(id);
  }

  clearCars() {
    for (const id of [...this.carModels.keys()]) this.removeCar(id);
  }

  // -------------------------------------------------------------------------
  //  Weather visuals
  // -------------------------------------------------------------------------

  /** Rain as a camera-locked particle volume — cheap and convincing. */
  _ensureRain() {
    if (this._rainGroup) return;
    const count = this.quality === 'low' ? 1200 : 3500;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 90;
      positions[i * 3 + 1] = Math.random() * 46;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 90;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // A soft, vertically stretched sprite. Plain points render as hard squares,
    // and with size attenuation the ones near the camera become huge blocks.
    // This fades them out both at the edges and when very close.
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uOpacity: { value: 0.5 }, uSize: { value: 26.0 } },
      vertexShader: `
        uniform float uSize;
        varying float vFade;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = -mv.z;
          gl_PointSize = clamp(uSize / max(1.0, d) * 8.0, 1.0, 9.0);
          // Drops right on the lens are distracting; fade the nearest away.
          vFade = smoothstep(1.5, 6.0, d) * (1.0 - smoothstep(50.0, 85.0, d));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uOpacity;
        varying float vFade;
        void main() {
          vec2 c = gl_PointCoord - vec2(0.5);
          // Stretch vertically into a streak.
          float r = length(vec2(c.x * 2.6, c.y));
          if (r > 0.5) discard;
          gl_FragColor = vec4(0.78, 0.85, 0.93,
                              (1.0 - r * 2.0) * uOpacity * vFade);
        }`
    });
    this._rainGroup = new THREE.Points(geo, mat);
    this._rainGroup.frustumCulled = false;
    this._rainGroup.visible = false;
    this.scene.add(this._rainGroup);
    this._rainCount = count;
  }

  updateWeather(dt, weather) {
    if (!weather) return;
    const cloud = clamp01(weather.cloudCover ?? 0);
    const rain = clamp01((weather.rainRate ?? 0) / 2.6);

    // Blend between the three sky presets by cloud cover and rain.
    const from = cloud < 0.5 ? SKY.clear : SKY.overcast;
    const to = cloud < 0.5 ? SKY.overcast : SKY.storm;
    const t = cloud < 0.5 ? cloud / 0.5 : (cloud - 0.5) / 0.5;
    const mix = Math.max(t, rain);

    const c1 = new THREE.Color(from.top).lerp(new THREE.Color(to.top), mix);
    const c2 = new THREE.Color(from.bottom).lerp(new THREE.Color(to.bottom), mix);
    this.sky.material.uniforms.topColor.value.copy(c1);
    this.sky.material.uniforms.bottomColor.value.copy(c2);

    const fogColour = new THREE.Color(from.fog).lerp(new THREE.Color(to.fog), mix);
    this.scene.fog.color.copy(fogColour);
    const targetFog = lerp(from.fogDensity, to.fogDensity, mix);
    this._weatherBlend.fogDensity = damp(this._weatherBlend.fogDensity, targetFog, 1.2, dt);
    this.scene.fog.density = this._weatherBlend.fogDensity;

    const targetSun = lerp(from.sunIntensity, to.sunIntensity, mix);
    this._weatherBlend.sunIntensity = damp(this._weatherBlend.sunIntensity, targetSun, 1.2, dt);
    this.sun.intensity = this._weatherBlend.sunIntensity;
    this.sun.color.lerpColors(new THREE.Color(from.sun), new THREE.Color(to.sun), mix);
    this.ambient.intensity = lerp(from.ambientIntensity, to.ambientIntensity, mix);
    this.ambient.color.lerpColors(new THREE.Color(from.ambient), new THREE.Color(to.ambient), mix);

    // A wet surface is darker and shinier.
    const wet = clamp01(weather.wetness ?? 0);
    const road = this.trackBuilder?.group.getObjectByName('road');
    if (road) {
      road.material.roughness = lerp(0.92, 0.28, wet);
      road.material.color.setHex(0x2c2f36).multiplyScalar(lerp(1.0, 0.62, wet));
      road.material.metalness = lerp(0.02, 0.22, wet);
    }

    // Rain volume.
    if (rain > 0.02) {
      this._ensureRain();
      this._rainGroup.visible = true;
      this._rainGroup.material.uniforms.uOpacity.value = 0.22 + rain * 0.34;
      this._rainGroup.material.uniforms.uSize.value = 18 + rain * 16;
      const pos = this._rainGroup.geometry.attributes.position;
      const fall = (16 + rain * 22) * dt;
      const drift = (weather.wind?.x || 0) * dt;
      const driftZ = (weather.wind?.z || 0) * dt;
      for (let i = 0; i < this._rainCount; i++) {
        let y = pos.array[i * 3 + 1] - fall;
        if (y < 0) y += 46;
        pos.array[i * 3 + 1] = y;
        pos.array[i * 3] += drift;
        pos.array[i * 3 + 2] += driftZ;
      }
      pos.needsUpdate = true;
      // Keep the volume centred on the camera.
      this._rainGroup.position.set(
        this.camera.position.x, this.camera.position.y - 22, this.camera.position.z
      );
    } else if (this._rainGroup) {
      this._rainGroup.visible = false;
    }
  }

  // -------------------------------------------------------------------------
  //  Per-frame
  // -------------------------------------------------------------------------

  /**
   * Update one car's visual state from its simulation state.
   * @param {string} id
   * @param {Vehicle|RemoteCarState} source
   * @param {boolean} isLocal whether this is the locally simulated car
   */
  updateCar(dt, id, source, isLocal) {
    const model = this.carModels.get(id);
    if (!model) return;

    if (isLocal) {
      const v = source;
      const wheels = v.wheels.map((w, i) => ({
        compression: w.compression,
        spinAngle: w.spinAngle,
        brakeTemp: v.brakes.temps[i],
        tireTemp: w.tire.surfaceTemp,
        compoundColour: getCompound(w.tire.compoundKey).colour
      }));
      model.update({
        position: v.body.position,
        orientation: v.body.orientation,
        steerAngle: v.steerAngle,
        wheels,
        drs: v.drsActive,
        damage: { frontWing: v.damage.frontWing, rearWing: v.damage.rearWing },
        wetLight: (this._wetness || 0) > 0.2,
        lateralG: v.telemetry.lateralG
      }, dt);
    } else {
      const r = source;
      if (!r.initialised) { model.setVisible(false); return; }
      model.setVisible(true);
      const compoundColour = getCompound(r.compound || 'medium').colour;
      const wheels = [0, 1, 2, 3].map((i) => ({
        compression: r.wheelCompression[i],
        // Remote wheel rotation is integrated locally from the reported angular
        // velocity, so the wheels keep turning smoothly between snapshots.
        spinAngle: (r._spin = r._spin || [0, 0, 0, 0])[i] =
          ((r._spin[i] + r.wheelSpin[i] * dt) % (Math.PI * 2)),
        brakeTemp: null,
        tireTemp: null,
        compoundColour
      }));
      model.update({
        position: r.position,
        orientation: r.orientation,
        steerAngle: r.steerAngle,
        wheels,
        drs: r.drs,
        damage: r.damage ? { frontWing: r.damage.fw, rearWing: r.damage.rw } : null,
        wetLight: (this._wetness || 0) > 0.2,
        lateralG: 0
      }, dt);
    }
  }

  /** Emit effects for a locally simulated car. */
  updateCarEffects(dt, id, vehicle, track) {
    const wheels = vehicle.wheels.map((w) => ({
      contactPoint: w.contactPoint,
      rightDir: w.rightDir,
      width: w.width,
      slip: w.tire.combinedSlip,
      frictionPower: w.tire.frictionPower,
      surfaceType: w.surfaceType,
      onGround: w.onGround,
      waterDepth: w.tire.load > 0 ? (this._waterDepth || 0) : 0,
      speed: vehicle.speed
    }));
    // Bottoming out: how far past the bump stop the floor is.
    let bottomed = 0;
    for (const w of vehicle.wheels) {
      bottomed = Math.max(bottomed, w.compression - w.maxCompression);
    }
    this.effects.update(dt, id, wheels, {
      velocity: vehicle.body.velocity,
      speed: vehicle.speed,
      bottomedOut: bottomed,
      position: vehicle.body.position
    });
  }

  setConditions(wetness, waterDepth) {
    this._wetness = wetness;
    this._waterDepth = waterDepth;
  }

  /** Keep the shadow frustum centred on the point of interest. */
  focusShadows(position) {
    if (!this.sun.castShadow) return;
    this.sun.position.set(position.x - 260, position.y + 430, position.z + 180);
    this.sun.target.position.copy(position);
    this.sun.target.updateMatrixWorld();
  }

  render(dt) {
    this.particles.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Quality tiers, ordered by what actually costs a weak machine frames.
   *
   * Resolution first: every pixel is shaded, so rendering below the display's
   * own scale is the strongest single lever there is. Then shadows, which cost
   * a second pass over the whole scene. Antialiasing last, being the cheapest
   * of the three to give up.
   */
  setQuality(quality) {
    this.quality = quality;
    const dpr = window.devicePixelRatio || 1;
    const scale = quality === 'high' ? Math.min(dpr, 2)
                : quality === 'medium' ? Math.min(dpr, 1.25)
                : Math.min(dpr, 1) * 0.8;
    this.renderer.setPixelRatio(scale);

    const shadows = quality !== 'low';
    this.renderer.shadowMap.enabled = shadows;
    if (this.sun) {
      this.sun.castShadow = shadows;
      if (shadows) {
        const size = quality === 'high' ? 2048 : 1024;
        if (this.sun.shadow.mapSize.x !== size) {
          this.sun.shadow.mapSize.set(size, size);
          // The map has to be thrown away for a new size to take effect.
          this.sun.shadow.map?.dispose();
          this.sun.shadow.map = null;
        }
      }
    }
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.clearCars();
    if (this.trackBuilder) this.trackBuilder.dispose();
    this.skids.dispose();
    this.particles.dispose();
    this.renderer.dispose();
  }
}
