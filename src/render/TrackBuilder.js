import * as THREE from 'three';
import { mergeStatic } from './mergeStatic.js';
import { Vec3 } from '../math/Vec3.js';
import { SurfaceType } from '../physics/Surfaces.js';
import { clamp, clamp01, lerp, smoothstep } from '../math/MathUtils.js';

/**
 * ============================================================================
 *  TRACK GEOMETRY
 * ============================================================================
 *
 * Builds the visible circuit from the SAME centreline samples the physics
 * queries. That matters: if the mesh were authored separately it would
 * eventually disagree with the collision surface, and the player would see a
 * kerb where the simulation had asphalt.
 *
 * Everything is generated — there are no model or texture files to load, which
 * keeps the whole game a single JavaScript bundle.
 */

/**
 * Length of circuit each merged mesh covers, in metres. Smaller means more
 * draw calls but tighter culling; larger means the reverse.
 */
const CHUNK_LENGTH = 320;

const COLOURS = {
  asphalt: 0x2c2f36,
  asphaltWorn: 0x3a3e46,
  racingLine: 0x1f2127,
  kerbA: 0xd23b32,
  kerbB: 0xf0f0f0,
  runoff: 0x54585f,
  gravel: 0xb09a72,
  grass: 0x3f6b3a,
  grassDark: 0x355c31,
  lineWhite: 0xe8e8e8,
  pit: 0x35383f,
  barrier: 0xdadada,
  barrierRed: 0xc0392b,
  tyreWall: 0x1a1a1a,
  fence: 0x8a8f98,
  grandstand: 0x4a4f58,
  building: 0x565b64
};

/** Build a mesh from flat position/normal/uv/colour arrays. */
function buildMesh(positions, normals, uvs, indices, material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return new THREE.Mesh(g, material);
}

export class TrackBuilder {
  /**
   * @param {TrackModel} track
   * @param {object} opts { quality: 'low'|'medium'|'high' }
   */
  constructor(track, opts = {}) {
    this.track = track;
    this.quality = opts.quality || 'high';
    this.group = new THREE.Group();
    this.group.name = 'circuit';
    // Step in centreline samples between mesh rings.
    this.step = this.quality === 'low' ? 4 : this.quality === 'medium' ? 3 : 2;
  }

  build() {
    this.group.clear();
    this._buildSurface();
    this._buildKerbs();
    this._buildLineMarkings();
    this._buildRunoffAndGrass();
    this._buildBarriers();
    this._buildPitLane();
    this._buildStartGantry();
    this._buildTrackside();
    this._mergeStatic();
    return this.group;
  }

  /**
   * Collapse the static circuit into one mesh per material.
   *
   * The builders above are written for clarity — a kerb block, a barrier
   * segment, a tree — which leaves the circuit as roughly a thousand separate
   * meshes. None of them ever move, and every one of them costs a draw call
   * twice over (once for the shadow map, once for the scene), which is what
   * puts a mid-range machine on its knees. Merging them by material turns the
   * whole circuit into a handful of draw calls without changing how any of it
   * looks or how the code that builds it is written.
   *
   * Anything whose material or transform changes at runtime — the road, whose
   * shine tracks the weather, and the starting lights — is left alone.
   */
  /**
   * Which slice of the lap a piece of geometry sits in. Chunks are sized so a
   * merged mesh spans a few hundred metres — long enough that merging is
   * worth it, short enough that most of the circuit is off-screen and culled.
   */
  _chunkIndexOf(geometry) {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) return 0;
    const cx = (box.min.x + box.max.x) * 0.5;
    const cz = (box.min.z + box.max.z) * 0.5;
    // Anything far larger than a chunk (the ground plane) is left whole.
    if (box.max.x - box.min.x > CHUNK_LENGTH * 2 ||
        box.max.z - box.min.z > CHUNK_LENGTH * 2) return 'whole';
    const i = this.track.nearestIndex(cx, cz);
    return Math.floor(this.track.dist[i] / CHUNK_LENGTH);
  }

  _mergeStatic() {
    this.meshCount = mergeStatic(this.group, (geometry) => this._chunkIndexOf(geometry));
  }

  /** Ring of points across the track at sample `i`, at a lateral offset. */
  _pointAt(i, lateral, heightOffset = 0) {
    const t = this.track;
    const bank = Math.tan(t.banking[i]) * lateral;
    return new THREE.Vector3(
      t.sx[i] + t.lx[i] * lateral,
      t.sy[i] + bank + heightOffset,
      t.sz[i] + t.lz[i] * lateral
    );
  }

  /**
   * Generic ribbon: a strip between two lateral offsets, following the track.
   * `latFn(i)` returns [innerOffset, outerOffset] so a ribbon can vary in width.
   */
  _ribbon(latFn, material, heightOffset = 0, uvScale = 0.12, closed = true) {
    const t = this.track;
    const n = t.sampleCount;
    const step = this.step;
    const rings = Math.floor(n / step);

    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];

    for (let r = 0; r < rings; r++) {
      const i = (r * step) % n;
      const [a, b] = latFn(i);
      const pa = this._pointAt(i, a, heightOffset);
      const pb = this._pointAt(i, b, heightOffset);
      positions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      // Surface normal from the track's own banking and gradient.
      const nx = -t.gradient[i] * t.tx[i];
      const ny = 1;
      const nz = -t.gradient[i] * t.tz[i];
      const nl = Math.hypot(nx, ny, nz);
      normals.push(nx / nl, ny / nl, nz / nl, nx / nl, ny / nl, nz / nl);
      const u = t.dist[i] * uvScale;
      uvs.push(0, u, 1, u);
    }

    const ringCount = closed ? rings : rings - 1;
    for (let r = 0; r < ringCount; r++) {
      const r0 = r * 2;
      const r1 = ((r + 1) % rings) * 2;
      indices.push(r0, r1, r0 + 1, r1, r1 + 1, r0 + 1);
    }
    return buildMesh(positions, normals, uvs, indices, material);
  }

  _buildSurface() {
    const t = this.track;
    const mat = new THREE.MeshStandardMaterial({
      color: COLOURS.asphalt, roughness: 0.92, metalness: 0.02
    });
    const road = this._ribbon(
      (i) => [-t.width[i] * 0.5, t.width[i] * 0.5], mat, 0.0
    );
    road.name = 'road';
    road.receiveShadow = true;
    this.group.add(road);

    // A subtly darker, glossier strip along the racing line: rubber laid down.
    const lineMat = new THREE.MeshStandardMaterial({
      color: COLOURS.racingLine, roughness: 0.72, metalness: 0.03,
      transparent: true, opacity: 0.55,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });
    const line = this._ribbon(
      (i) => [t.lineRacing[i] - 1.9, t.lineRacing[i] + 1.9], lineMat, 0.004
    );
    line.name = 'racingLineRubber';
    this.group.add(line);
  }

  /**
   * Kerbs, with alternating red and white blocks. Built as two interleaved
   * ribbons so the stripes are real geometry rather than a texture.
   */
  _buildKerbs() {
    const t = this.track;
    const kerbW = t.circuit.KERB_WIDTH;
    const matA = new THREE.MeshStandardMaterial({ color: COLOURS.kerbA, roughness: 0.7 });
    const matB = new THREE.MeshStandardMaterial({ color: COLOURS.kerbB, roughness: 0.7 });

    for (const side of [-1, 1]) {
      for (const [phase, mat] of [[0, matA], [1, matB]]) {
        const positions = [], normals = [], uvs = [], indices = [];
        let vert = 0;
        const blockLength = 3.2;   // metres per stripe
        const samplesPerBlock = Math.max(2, Math.round(blockLength / t.sampleSpacing));

        for (let i = 0; i < t.sampleCount; i += samplesPerBlock) {
          const block = Math.floor(i / samplesPerBlock);
          if (block % 2 !== phase) continue;
          // Only put kerbs where there is actually a corner to kerb.
          const k = t.curvature[i];
          const relevant = Math.abs(k) > 0.0025;
          if (!relevant) continue;

          const iEnd = Math.min(i + samplesPerBlock, t.sampleCount - 1);
          const inner = t.width[i] * 0.5;
          for (const idx of [i, iEnd]) {
            const w = t.width[idx] * 0.5;
            const p0 = this._pointAt(idx, side * w, 0.012);
            const p1 = this._pointAt(idx, side * (w + kerbW), 0.048);
            positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
            normals.push(0, 1, 0, 0, 1, 0);
            uvs.push(0, idx * 0.1, 1, idx * 0.1);
          }
          indices.push(vert, vert + 2, vert + 1, vert + 2, vert + 3, vert + 1);
          vert += 4;
        }
        if (positions.length) {
          const mesh = buildMesh(positions, normals, uvs, indices, mat);
          mesh.name = `kerb-${side}-${phase}`;
          mesh.receiveShadow = true;
          this.group.add(mesh);
        }
      }
    }
  }

  /** White track-edge lines and the start/finish line. */
  _buildLineMarkings() {
    const t = this.track;
    const mat = new THREE.MeshStandardMaterial({
      color: COLOURS.lineWhite, roughness: 0.8,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    for (const side of [-1, 1]) {
      const edge = this._ribbon(
        (i) => {
          const w = t.width[i] * 0.5;
          return side < 0 ? [-w, -w + 0.12] : [w - 0.12, w];
        },
        mat, 0.006
      );
      edge.name = `edgeLine${side}`;
      this.group.add(edge);
    }

    // Start/finish line: a chequered band across the circuit.
    const startW = t.width[0] * 0.5;
    const squares = 16;
    const positions = [], normals = [], uvs = [], indices = [];
    let v = 0;
    for (let s = 0; s < squares; s++) {
      if (s % 2 === 1) continue;
      const l0 = -startW + (s / squares) * startW * 2;
      const l1 = -startW + ((s + 1) / squares) * startW * 2;
      const back = this.track.pointAt(-0.9, l0);
      const back2 = this.track.pointAt(-0.9, l1);
      const fwd = this.track.pointAt(0.9, l0);
      const fwd2 = this.track.pointAt(0.9, l1);
      for (const p of [back, back2, fwd, fwd2]) {
        positions.push(p.x, p.y + 0.008, p.z);
        normals.push(0, 1, 0);
        uvs.push(0, 0);
      }
      indices.push(v, v + 2, v + 1, v + 2, v + 3, v + 1);
      v += 4;
    }
    const startLine = buildMesh(positions, normals, uvs, indices,
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.75 }));
    startLine.name = 'startFinishLine';
    this.group.add(startLine);

    // Grid box markings.
    const gridMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.85 });
    for (const slot of this.track.gridSlots) {
      const box = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.2), gridMat);
      box.rotation.x = -Math.PI / 2;
      box.rotation.z = -slot.heading;
      box.position.copy(slot.position);
      box.position.y += 0.007;
      this.group.add(box);
    }
  }

  /** Runoff, gravel traps and the grass beyond. */
  _buildRunoffAndGrass() {
    const t = this.track;
    const kerbW = t.circuit.KERB_WIDTH;

    const runoffMat = new THREE.MeshStandardMaterial({ color: COLOURS.runoff, roughness: 0.95 });
    const gravelMat = new THREE.MeshStandardMaterial({ color: COLOURS.gravel, roughness: 1.0 });
    const grassMat = new THREE.MeshStandardMaterial({ color: COLOURS.grass, roughness: 1.0 });

    // Split the runoff into contiguous runs of the same surface type so each
    // gets a mesh of the right colour.
    for (const side of [-1, 1]) {
      let runStart = 0;
      let runType = t.runoffType[0];
      const flush = (end) => {
        if (end - runStart < 2) return;
        const mat = runType === SurfaceType.GRAVEL ? gravelMat
                  : runType === SurfaceType.RUNOFF ? runoffMat : grassMat;
        const positions = [], normals = [], uvs = [], indices = [];
        let v = 0;
        for (let i = runStart; i <= end; i += this.step) {
          const idx = Math.min(i, t.sampleCount - 1);
          const inner = t.width[idx] * 0.5 + kerbW;
          const outer = inner + t.runoffWidth[idx];
          const p0 = this._pointAt(idx, side * inner, -0.055);
          const p1 = this._pointAt(idx, side * outer, -0.12);
          positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
          normals.push(0, 1, 0, 0, 1, 0);
          uvs.push(0, idx * 0.05, 1, idx * 0.05);
          v += 2;
        }
        const rings = v / 2;
        for (let r = 0; r < rings - 1; r++) {
          const a = r * 2, b = (r + 1) * 2;
          indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
        if (positions.length) {
          const m = buildMesh(positions, normals, uvs, indices, mat);
          m.receiveShadow = true;
          this.group.add(m);
        }
      };
      for (let i = 1; i < t.sampleCount; i++) {
        if (t.runoffType[i] !== runType) {
          flush(i);
          runStart = i;
          runType = t.runoffType[i];
        }
      }
      flush(t.sampleCount - 1);
    }

    // A large ground plane under everything so the world is not floating.
    const b = t.bounds;
    const w = (b.maxX - b.minX) + 900;
    const h = (b.maxZ - b.minZ) + 900;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h, 12, 12),
      new THREE.MeshStandardMaterial({ color: COLOURS.grassDark, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((b.minX + b.maxX) / 2, -1.2, (b.minZ + b.maxZ) / 2);
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.group.add(ground);
  }

  /** Barriers: steel along the fast sections, tyre walls at the slow corners. */
  _buildBarriers() {
    const t = this.track;
    const steelMat = new THREE.MeshStandardMaterial({
      color: COLOURS.barrier, roughness: 0.45, metalness: 0.65, side: THREE.DoubleSide
    });
    const tyreMat = new THREE.MeshStandardMaterial({
      color: COLOURS.tyreWall, roughness: 0.95, side: THREE.DoubleSide
    });
    const fenceMat = new THREE.MeshStandardMaterial({
      color: COLOURS.fence, roughness: 0.6, metalness: 0.4,
      transparent: true, opacity: 0.22, side: THREE.DoubleSide
    });

    for (const side of [-1, 1]) {
      for (const [type, mat, height] of [[0, steelMat, 1.05], [1, tyreMat, 0.95]]) {
        const positions = [], normals = [], uvs = [], indices = [];
        let v = 0;
        let prevIncluded = false;
        for (let i = 0; i < t.sampleCount; i += this.step) {
          if (t.barrierType[i] !== type) { prevIncluded = false; continue; }
          const off = side > 0 ? t.barrierOffsetR[i] : t.barrierOffsetL[i];
          const base = this._pointAt(i, side * off, -0.10);
          positions.push(base.x, base.y, base.z, base.x, base.y + height, base.z);
          const nx = -side * t.lx[i], nz = -side * t.lz[i];
          normals.push(nx, 0, nz, nx, 0, nz);
          uvs.push(t.dist[i] * 0.08, 0, t.dist[i] * 0.08, 1);
          if (prevIncluded) {
            indices.push(v - 2, v, v - 1, v, v + 1, v - 1);
          }
          v += 2;
          prevIncluded = true;
        }
        if (positions.length) {
          const m = buildMesh(positions, normals, uvs, indices, mat);
          m.name = `barrier-${side}-${type}`;
          this.group.add(m);
        }
      }

      // Catch fencing above the barriers, kept translucent so it never hides
      // the circuit from the chase camera.
      const positions = [], normals = [], uvs = [], indices = [];
      let v = 0;
      const fenceStep = this.step * 3;
      for (let i = 0; i < t.sampleCount; i += fenceStep) {
        const off = (side > 0 ? t.barrierOffsetR[i] : t.barrierOffsetL[i]) + 0.4;
        const base = this._pointAt(i, side * off, 0.9);
        positions.push(base.x, base.y, base.z, base.x, base.y + 3.4, base.z);
        const nx = -side * t.lx[i], nz = -side * t.lz[i];
        normals.push(nx, 0, nz, nx, 0, nz);
        uvs.push(t.dist[i] * 0.2, 0, t.dist[i] * 0.2, 1);
        if (v >= 2) indices.push(v - 2, v, v - 1, v, v + 1, v - 1);
        v += 2;
      }
      const fence = buildMesh(positions, normals, uvs, indices, fenceMat);
      fence.name = `fence-${side}`;
      this.group.add(fence);
    }
  }

  _buildPitLane() {
    const pit = this.track.pit;
    const spline = this.track.pitSpline;
    const mat = new THREE.MeshStandardMaterial({ color: COLOURS.pit, roughness: 0.9 });
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: 0.8 });

    const positions = [], normals = [], uvs = [], indices = [];
    const steps = Math.max(24, Math.round(spline.length / 6));
    let v = 0;
    const c = new Vec3();
    const tan = new Vec3();
    for (let s = 0; s <= steps; s++) {
      const d = (s / steps) * spline.length;
      spline.pointAtDistance(d, c);
      spline.tangentAtDistance(d, tan);
      const lx = tan.z, lz = -tan.x;
      const hw = pit.width * 0.5;
      positions.push(
        c.x - lx * hw, c.y + 0.01, c.z - lz * hw,
        c.x + lx * hw, c.y + 0.01, c.z + lz * hw
      );
      normals.push(0, 1, 0, 0, 1, 0);
      uvs.push(0, d * 0.1, 1, d * 0.1);
      if (v >= 2) indices.push(v - 2, v, v - 1, v, v + 1, v - 1);
      v += 2;
    }
    const lane = buildMesh(positions, normals, uvs, indices, mat);
    lane.name = 'pitLane';
    lane.receiveShadow = true;
    this.group.add(lane);

    // Pit boxes and the garage frontage behind them.
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xcfcfcf, roughness: 0.85 });
    const buildingMat = new THREE.MeshStandardMaterial({ color: COLOURS.building, roughness: 0.8 });
    for (const box of pit.boxes) {
      const marker = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 6.0), boxMat);
      marker.rotation.x = -Math.PI / 2;
      marker.rotation.z = -box.heading;
      marker.position.copy(box.position);
      marker.position.y += 0.02;
      this.group.add(marker);

      // Garages sit on the far side of the pit lane, AWAY from the circuit.
      // The lateral direction here points toward the racing surface, so the
      // offset must follow the sign of the pit lane's own offset — otherwise
      // the buildings end up a few metres from the track, in the driver's view
      // and in the way.
      const garage = new THREE.Mesh(new THREE.BoxGeometry(4.6, 4.4, 7.5), buildingMat);
      garage.position.copy(box.position);
      garage.position.y += 2.2;
      const nx = Math.cos(box.heading), nz = -Math.sin(box.heading);
      const away = Math.sign(pit.offset || -1) * 9.0;
      garage.position.x += nx * away;
      garage.position.z += nz * away;
      garage.rotation.y = box.heading;
      garage.castShadow = true;
      this.group.add(garage);
    }
  }

  /** Start gantry with the five starting lights. */
  _buildStartGantry() {
    const t = this.track;
    const w = t.width[0] * 0.5 + 3;
    const g = new THREE.Group();
    g.name = 'startGantry';

    const postMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6, metalness: 0.4 });
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x1f2228, roughness: 0.6, metalness: 0.4 });

    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.55, 8.2, 0.55), postMat);
      const p = this.track.pointAt(0, side * w);
      post.position.set(p.x, p.y + 4.1, p.z);
      post.castShadow = true;
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 2, 1.1, 0.7), beamMat);
    const c = this.track.pointAt(0, 0);
    beam.position.set(c.x, c.y + 7.6, c.z);
    beam.rotation.y = this.track.headingAtDistance(0);
    beam.castShadow = true;
    g.add(beam);

    // The five lights, exposed so the countdown can switch them on.
    this.startLights = [];
    for (let i = 0; i < 5; i++) {
      const lightGroup = new THREE.Group();
      const off = (i - 2) * 2.0;
      const lp = this.track.pointAt(0, off);
      lightGroup.position.set(lp.x, lp.y + 7.0, lp.z);
      for (let row = 0; row < 2; row++) {
        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(0.32, 12, 10),
          new THREE.MeshStandardMaterial({
            color: 0x220000, emissive: 0x000000, roughness: 0.4
          })
        );
        bulb.position.y = row * -0.75;
        lightGroup.add(bulb);
      }
      // The countdown switches these on, so they must survive the merge.
      lightGroup.userData.dynamic = true;
      this.startLights.push(lightGroup);
      g.add(lightGroup);
    }

    this.group.add(g);
  }

  /** Switch the starting lights on or off. `count` is 0..5. */
  setStartLights(count, allOut = false) {
    if (!this.startLights) return;
    this.startLights.forEach((group, i) => {
      const on = !allOut && i < count;
      group.children.forEach((bulb) => {
        bulb.material.emissive.setHex(on ? 0xd81010 : 0x000000);
        bulb.material.color.setHex(on ? 0xff2a1a : 0x220000);
      });
    });
  }

  /**
   * Trackside furniture: grandstands, marshal posts, advertising and trees.
   * All placed relative to the circuit, and all well clear of the racing
   * surface — they exist for context and speed reference, never as obstacles.
   */
  _buildTrackside() {
    const t = this.track;
    const g = new THREE.Group();
    g.name = 'trackside';

    const standMat = new THREE.MeshStandardMaterial({ color: COLOURS.grandstand, roughness: 0.85 });
    const seatMats = [0x2f6fb5, 0xb54a2f, 0xd6c02f].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 })
    );
    const adMats = [0xd0342c, 0x2c6fd0, 0xe0b020, 0x30a050].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 })
    );
    const treeTrunk = new THREE.MeshStandardMaterial({ color: 0x4a3b2a, roughness: 1 });
    const treeLeaf = new THREE.MeshStandardMaterial({ color: 0x2f5c2a, roughness: 1 });

    // Grandstands at the main straight and the two overtaking spots.
    const standFractions = [0.02, 0.16, 0.49, 0.86, 0.96];
    for (const f of standFractions) {
      for (const side of [-1, 1]) {
        const d = f * t.length;
        const i = Math.floor(d / t.sampleSpacing) % t.sampleCount;
        const off = (side > 0 ? t.barrierOffsetR[i] : t.barrierOffsetL[i]) + 24;
        const p = this._pointAt(i, side * off, 0);
        const heading = Math.atan2(t.tx[i], t.tz[i]);

        const stand = new THREE.Group();
        stand.position.copy(p);
        stand.rotation.y = heading;
        // Raked seating, built as steps.
        const rows = 9;
        for (let r = 0; r < rows; r++) {
          const step = new THREE.Mesh(
            new THREE.BoxGeometry(64, 0.9, 2.0),
            r % 3 === 0 ? standMat : seatMats[(r + Math.round(f * 10)) % seatMats.length]
          );
          step.position.set(0, 1.0 + r * 0.85, -side * (r * 1.9));
          step.castShadow = true;
          stand.add(step);
        }
        const roof = new THREE.Mesh(new THREE.BoxGeometry(66, 0.5, 22), standMat);
        roof.position.set(0, 10.6, -side * 9);
        stand.add(roof);
        g.add(stand);
      }
    }

    // Advertising hoardings along the barriers.
    for (let i = 0; i < t.sampleCount; i += 90) {
      for (const side of [-1, 1]) {
        const off = (side > 0 ? t.barrierOffsetR[i] : t.barrierOffsetL[i]) + 0.15;
        const p = this._pointAt(i, side * off, 0.15);
        const board = new THREE.Mesh(
          new THREE.BoxGeometry(11, 0.95, 0.2),
          adMats[(i / 90) % adMats.length | 0]
        );
        board.position.copy(p);
        board.position.y += 0.55;
        board.rotation.y = Math.atan2(t.tx[i], t.tz[i]);
        g.add(board);
      }
    }

    // Marshal posts at every corner.
    for (const corner of t.corners) {
      const i = Math.floor(corner.startDistance / t.sampleSpacing) % t.sampleCount;
      const side = corner.direction > 0 ? -1 : 1;   // outside of the corner
      const off = (side > 0 ? t.barrierOffsetR[i] : t.barrierOffsetL[i]) + 4;
      const p = this._pointAt(i, side * off, 0);
      const post = new THREE.Group();
      post.position.copy(p);
      const hut = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 2.4, 2.2),
        new THREE.MeshStandardMaterial({ color: 0xe4e4e4, roughness: 0.85 })
      );
      hut.position.y = 1.2;
      hut.castShadow = true;
      post.add(hut);
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(3.0, 0.2, 2.6),
        new THREE.MeshStandardMaterial({ color: 0xd04030, roughness: 0.8 })
      );
      roof.position.y = 2.5;
      post.add(roof);
      post.rotation.y = Math.atan2(t.tx[i], t.tz[i]);
      g.add(post);
    }

    // Trees beyond the runoff, scattered deterministically.
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 4, 6);
    const leafGeo = new THREE.ConeGeometry(3.2, 7, 7);
    for (let i = 0; i < t.sampleCount; i += 16) {
      for (const side of [-1, 1]) {
        if (rnd() > 0.45) continue;
        const off = (side > 0 ? t.barrierOffsetR[i] : t.barrierOffsetL[i]) + 14 + rnd() * 55;
        const p = this._pointAt(i, side * off, -1);
        const scale = 0.75 + rnd() * 0.8;
        const trunk = new THREE.Mesh(trunkGeo, treeTrunk);
        trunk.position.set(p.x, p.y + 2 * scale, p.z);
        trunk.scale.setScalar(scale);
        g.add(trunk);
        const leaves = new THREE.Mesh(leafGeo, treeLeaf);
        leaves.position.set(p.x, p.y + 6.5 * scale, p.z);
        leaves.scale.setScalar(scale);
        leaves.castShadow = true;
        g.add(leaves);
      }
    }

    // Pit building behind the pit lane.
    const pitBuilding = new THREE.Mesh(
      new THREE.BoxGeometry(28, 9, 14),
      new THREE.MeshStandardMaterial({ color: 0x4c515a, roughness: 0.8 })
    );
    const bp = this.track.pointAt(t.pit.exitDistance + 60, t.pit.offset + Math.sign(t.pit.offset || -1) * 24);
    pitBuilding.position.set(bp.x, bp.y + 4.5, bp.z);
    pitBuilding.rotation.y = this.track.headingAtDistance(t.pit.exitDistance + 60);
    pitBuilding.castShadow = true;
    g.add(pitBuilding);

    this.group.add(g);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
    this.group.clear();
  }
}
