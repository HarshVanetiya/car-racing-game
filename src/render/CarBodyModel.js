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
 * The model's own wheels are discarded: ours have to steer, spin and move with
 * the suspension, so `CarModel` builds those itself.
 */

const MODEL_URL = 'models/car.glb';

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
          resolve(prepared);
        } catch {
          resolve(null);
        }
      },
      undefined,
      () => resolve(null)          // offline, blocked, or missing: use the fallback
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

  // The chassis is the largest part; anything sharing its node is chassis too.
  const largest = parts.reduce((a, b) => (b.volume > a.volume ? b : a));
  const chassisParent = largest.object.parent;
  const chassis = parts.filter((p) => p.object.parent === chassisParent);
  if (chassis.length === 0) return null;

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

  // The shell is whichever material covers the most of the car, and the
  // largest of the rest is the trim. Those are the two the team colours go on.
  const byArea = [...buckets.values()].sort((a, b) => b.tris - a.tris);
  const shellName = byArea[0]?.name;
  const trimName = byArea.find((b) => b.name !== shellName && !isGlass(b.name))?.name;

  const group = new THREE.Group();
  group.name = 'car-body-model';
  const tintable = [];

  for (const bucket of buckets.values()) {
    const geometry = bucket.geoms.length === 1
      ? bucket.geoms[0]
      : mergeGeometries(bucket.geoms, false);
    if (!geometry) continue;

    const glass = isGlass(bucket.name);
    const material = new THREE.MeshStandardMaterial({
      color: bucket.material?.color ? bucket.material.color.clone() : new THREE.Color(0xcccccc),
      roughness: glass ? 0.1 : 0.32,
      metalness: glass ? 0.0 : 0.62,
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
    else if (bucket.name === trimName) tintable.push({ name: mesh.name, role: 'trim' });
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
  outer.scale.setScalar(wheelbase / MODEL_WHEELBASE);
  outer.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(outer);
  outer.position.x -= (box.min.x + box.max.x) * 0.5;
  outer.position.z -= (box.min.z + box.max.z) * 0.5;
  outer.position.y -= box.min.y;
  outer.updateMatrixWorld(true);

  const size = new THREE.Box3().setFromObject(outer).getSize(new THREE.Vector3());
  return { group: outer, tintable, size };
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

function isGlass(name) {
  return /glass|window|screen/i.test(name || '');
}

/**
 * A copy of the prepared body, tinted to a car's colours. Materials are cloned
 * per car so one team's paint never bleeds into another's.
 */
export function instantiateCarBody(source, colour, accent) {
  const group = source.group.clone(true);
  const shell = new THREE.Color(colour);
  const trim = new THREE.Color(accent);
  const roles = new Map(source.tintable.map((t) => [t.name, t.role]));

  group.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    o.castShadow = true;
    o.receiveShadow = true;
    const role = roles.get(o.name);
    if (role === 'shell') o.material.color.copy(shell);
    else if (role === 'trim') o.material.color.copy(trim);
  });
  return group;
}
