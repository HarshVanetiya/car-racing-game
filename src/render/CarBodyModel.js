import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { normaliseForMerge } from './mergeStatic.js';

/**
 * ============================================================================
 *  CAR BODY MODEL
 * ============================================================================
 *
 * Loads the shared car model once and hands out per-car copies.
 *
 * Everything else in this game is generated at runtime, and the procedural car
 * in `CarModel` remains the fallback: if the model cannot be fetched the game
 * still runs and still looks like a race. But the procedural body costs around
 * twenty-five separate meshes per car, and twenty cars of that is most of a
 * frame's draw calls on a modest machine. The model is one mesh per material
 * and 1,030 triangles, which is both better looking and far cheaper.
 *
 * The model's wheels are lifted out and re-used on our own hubs rather than
 * left where they sit: ours have to steer, spin and follow the suspension, but
 * the mesh is the same one the body was drawn with, so the car looks of a
 * piece.
 */

// Resolved against the deployed base path, so the model is found whether the
// game is served from the root or from a project subpath.
const MODEL_URL = `${import.meta.env?.BASE_URL ?? '/'}models/car.glb`;

/**
 * The model is authored in centimetres with a 158.4-unit wheelbase. Scaling by
 * the ratio of our own wheelbase to that puts its body exactly where the
 * simulation puts the car, which is why it needs no hand-tuned offsets.
 */
const MODEL_WHEELBASE = 158.433;

let loadPromise = null;
/** The prepared body, oriented and scaled, ready to clone. Null if it failed. */
let prepared = null;

/**
 * Begin loading the shared model. Safe to call repeatedly; the work happens
 * once. Resolves to null when the model is unavailable, which is not an error:
 * the caller falls back to the procedural body.
 */
export function loadCarBody(wheelbase) {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve) => {
    let loader;
    try {
      loader = new GLTFLoader();
    } catch {
      resolve(null);
      return;
    }
    loader.load(
      MODEL_URL,
      (gltf) => {
        try {
          prepared = prepare(gltf.scene, wheelbase);
          if (!prepared) console.warn('[apex] car model loaded but could not be prepared');
          resolve(prepared);
        } catch (err) {
          // The procedural car still carries the game, but a mistake in here
          // must not look identical to "the file was not there". Silence is
          // how a broken model stays broken.
          console.warn('[apex] car model could not be prepared:', err);
          resolve(null);
        }
      },
      undefined,
      (err) => {
        console.warn('[apex] car model unavailable, using the built-in car:', err?.message || err);
        resolve(null);           // offline, blocked, or missing: use the fallback
      }
    );
  });
  return loadPromise;
}

/** The prepared body if it has already loaded, otherwise null. */
export function carBodyIfReady() {
  return prepared;
}

/**
 * Pull the chassis out of the loaded scene and bake it into a single mesh per
 * material, in our coordinate system: +Z forward, +Y up, and the origin on the
 * road under the centre of the car.
 *
 * The body is found by size rather than by name. The file names its nodes
 * "WheelFront.000" through ".011" — the chassis included — and a loader is
 * free to rewrite names it considers unsafe, so keying off them is fragile.
 * The chassis is simply the biggest thing in the file, and that is true of any
 * car model, which also means dropping in a different one needs no code change.
 */
function prepare(scene, wheelbase) {
  scene.updateMatrixWorld(true);

  // Every node that directly holds geometry, with its world-space size.
  const parts = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    o.updateWorldMatrix(true, false);
    const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) return;
    const size = new THREE.Vector3().subVectors(box.max, box.min);
    parts.push({ object: o, geometry, box, volume: size.x * size.y * size.z });
  });
  if (parts.length === 0) return null;

  // Everything below is in model units until this is applied.
  const scale = wheelbase / MODEL_WHEELBASE;

  // The chassis is the largest part; anything sharing its node is chassis too.
  const largest = parts.reduce((a, b) => (b.volume > a.volume ? b : a));
  const chassisParent = largest.object.parent;
  const chassis = parts.filter((p) => p.object.parent === chassisParent);
  if (chassis.length === 0) return null;

  // Everything else is the model's wheels. We do not use them where they sit —
  // ours have to steer, spin and follow the suspension — but one of them, cut
  // free and centred on its own axle, is a far better wheel than the cylinder
  // we would otherwise build, and it matches the body it came with.
  const wheel = extractWheel(parts.filter((p) => p.object.parent !== chassisParent), scale);

  // Merge the chassis by material.
  const buckets = new Map();
  for (const part of chassis) {
    const name = part.object.material?.name || 'body';
    let bucket = buckets.get(name);
    if (!bucket) { bucket = { name, material: part.object.material, geoms: [], tris: 0 }; buckets.set(name, bucket); }
    const g = normaliseForMerge(part.geometry);
    if (!g) continue;
    bucket.geoms.push(g);
    bucket.tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  }
  if (buckets.size === 0) return null;

  // Only the bodywork takes the team colour: it is whichever material covers
  // most of the car. The rest is structure — floor, nose underside, mirrors —
  // and painting that too was what turned the model's black panels into large
  // white ones, because a car's accent colour is often white.
  const byArea = [...buckets.values()].sort((a, b) => b.tris - a.tris);
  const shellName = byArea[0]?.name;

  const group = new THREE.Group();
  group.name = 'car-body-model';
  const tintable = [];

  for (const bucket of buckets.values()) {
    const geometry = bucket.geoms.length === 1
      ? bucket.geoms[0]
      : mergeGeometries(bucket.geoms, false);
    if (!geometry) continue;

    const glass = isGlass(bucket.name);
    const painted = bucket.name === shellName;
    // Only the painted bodywork gets a metallic finish. Applying it to
    // everything turns the model's black trim into light grey: a black
    // metal with nothing to reflect renders as flat lit surface, which is
    // why the nose and floor came out looking silver.
    const material = new THREE.MeshStandardMaterial({
      color: bucket.material?.color ? bucket.material.color.clone() : new THREE.Color(0xcccccc),
      roughness: glass ? 0.1 : painted ? 0.30 : 0.62,
      metalness: glass ? 0.0 : painted ? 0.55 : 0.05,
      transparent: glass,
      opacity: glass ? 0.55 : 1
    });
    material.name = bucket.name;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `body-${bucket.name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (bucket.name === shellName) tintable.push({ name: mesh.name, role: 'shell' });
  }
  if (group.children.length === 0) return null;

  // Face the car the way the simulation does. Which way a model points is a
  // property of the file, not something to hard-code, so it is measured: a
  // racing car sits low at the nose and carries a tall wing at the back, so
  // the taller end is the rear, and the model is turned to put it at -Z.
  const outer = new THREE.Group();
  outer.name = 'car-body-model';
  if (facesBackwards(group)) group.rotation.y = Math.PI;
  outer.add(group);

  // Scale to our car, then sit it on the road, centred.
  outer.scale.setScalar(scale);
  outer.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(outer);
  outer.position.x -= (box.min.x + box.max.x) * 0.5;
  outer.position.z -= (box.min.z + box.max.z) * 0.5;
  outer.position.y -= box.min.y;
  outer.updateMatrixWorld(true);

  const size = new THREE.Box3().setFromObject(outer).getSize(new THREE.Vector3());
  return { group: outer, tintable, size, wheel };
}

/**
 * True when the model faces the wrong way and needs turning through 180.
 *
 * Measured rather than assumed, by comparing how tall the body stands over the
 * outermost tenth at each end. A racing car is low at the nose and carries a
 * tall wing at the back, so the taller end is the rear; our cars travel toward
 * +Z, so the rear belongs at -Z.
 *
 * Height is the discriminator rather than width because a formula car is wide
 * at BOTH ends — front wing and rear wing — which makes width tell you nothing.
 */
function facesBackwards(group) {
  const box = new THREE.Box3().setFromObject(group);
  const span = box.max.z - box.min.z;
  if (span <= 0) return false;
  const band = span * 0.12;
  const floor = box.min.y;

  let heightAtNegZ = 0, heightAtPosZ = 0;
  const v = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.updateWorldMatrix(true, false);
    const pos = o.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.z <= box.min.z + band) heightAtNegZ = Math.max(heightAtNegZ, v.y - floor);
      else if (v.z >= box.max.z - band) heightAtPosZ = Math.max(heightAtPosZ, v.y - floor);
    }
  });
  // Tall end is the rear. If it is at +Z, the car is pointing backwards.
  return heightAtPosZ > heightAtNegZ;
}

/**
 * One wheel from the model, merged, centred on its axle and scaled to our car.
 *
 * Returns the mesh plus the radius it ended up with, so the caller can size it
 * to each corner: front and rear tyres are not the same size, and a wheel that
 * does not match the contact patch the physics is using looks wrong in exactly
 * the way people notice.
 */
function extractWheel(parts, scale) {
  if (parts.length === 0) return null;

  // All four are the same wheel in different places; take the group belonging
  // to one of them.
  const parent = parts[0].object.parent;
  const mine = parts.filter((p) => p.object.parent === parent);

  const geometries = [];
  for (const part of mine) {
    const g = normaliseForMerge(part.geometry);
    if (g) geometries.push(g);
  }
  if (geometries.length === 0) return null;

  const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
  if (!geometry) return null;

  // Centre it on its own axle and bring it into our units.
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const centre = new THREE.Vector3(
    (box.min.x + box.max.x) * 0.5,
    (box.min.y + box.max.y) * 0.5,
    (box.min.z + box.max.z) * 0.5
  );
  geometry.translate(-centre.x, -centre.y, -centre.z);
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  const sized = geometry.boundingBox;
  return {
    geometry,
    // The axle runs along X, so the tyre's radius is its half-height.
    radius: (sized.max.y - sized.min.y) * 0.5,
    width: sized.max.x - sized.min.x
  };
}

function isGlass(name) {
  return /glass|window|screen/i.test(name || '');
}

/**
 * A copy of the prepared body, tinted to a car's colours. Materials are cloned
 * per car so one team's paint never bleeds into another's.
 */
export function instantiateCarBody(source, colour) {
  const group = source.group.clone(true);
  const shell = new THREE.Color(colour);
  const roles = new Map(source.tintable.map((t) => [t.name, t.role]));

  group.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    o.castShadow = true;
    o.receiveShadow = true;
    if (roles.get(o.name) === 'shell') o.material.color.copy(shell);
  });
  return group;
}
