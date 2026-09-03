import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * ============================================================================
 *  STATIC GEOMETRY MERGING
 * ============================================================================
 *
 * The builders in this folder are written for clarity — a kerb block, a
 * barrier segment, a wing endplate — which leaves the scene holding thousands
 * of tiny meshes. None of them move relative to their parent, and every one
 * costs a draw call twice over: once for the shadow map, once for the scene.
 * That is what puts a modest machine on its knees, and a machine that cannot
 * hold a frame rate makes the controls feel broken however good the physics is.
 *
 * Merging by material collapses them without changing how anything looks or
 * how the code that builds it is written. Anything whose material or transform
 * changes at runtime is marked `userData.dynamic` and left alone.
 */

/**
 * Merge the static meshes under `root` in place.
 *
 * @param {THREE.Object3D} root
 * @param {(geometry: THREE.BufferGeometry) => string|number} [keyFor]
 *        Optional extra bucketing, so merged meshes can be kept spatially
 *        local and stay cullable.
 * @returns {number} how many objects the root ended up with
 */
export function mergeStatic(root, keyFor = null) {
  const buckets = new Map();
  const held = [];

  // Walk the tree, but never descend into a subtree marked dynamic: those keep
  // their structure because something addresses them at runtime.
  const walk = (object) => {
    for (const child of [...object.children]) {
      if (child.userData.dynamic) { held.push(child); continue; }
      if (child.isMesh) {
        child.updateWorldMatrix(true, false);
        const geometry = normaliseForMerge(child.geometry.clone().applyMatrix4(child.matrixWorld));
        if (!geometry) { held.push(child); continue; }
        // Material and shadow flags decide what CAN share a draw call.
        const extra = keyFor ? keyFor(geometry) : '';
        const key = `${child.material.uuid}|${child.castShadow ? 1 : 0}|` +
                    `${child.receiveShadow ? 1 : 0}|${extra}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            material: child.material, cast: child.castShadow,
            receive: child.receiveShadow, name: child.name, geoms: []
          };
          buckets.set(key, bucket);
        }
        bucket.geoms.push(geometry);
      } else {
        walk(child);
      }
    }
  };
  walk(root);

  const merged = [];
  for (const bucket of buckets.values()) {
    if (bucket.geoms.length === 0) continue;
    const geometry = bucket.geoms.length === 1
      ? bucket.geoms[0]
      : mergeGeometries(bucket.geoms, false);
    if (!geometry) continue;
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, bucket.material);
    mesh.castShadow = bucket.cast;
    mesh.receiveShadow = bucket.receive;
    // Keep the name so lookups by name still work.
    if (bucket.name) mesh.name = bucket.name;
    merged.push(mesh);
  }

  // Anything held back keeps the world transform it already had.
  for (const object of held) {
    object.updateWorldMatrix(true, false);
    object.matrix.copy(object.matrixWorld);
    object.matrix.decompose(object.position, object.quaternion, object.scale);
  }

  root.clear();
  for (const mesh of merged) root.add(mesh);
  for (const object of held) root.add(object);
  return merged.length + held.length;
}

/**
 * Reduce a geometry to the attributes a merge can combine: position, normal
 * and uv, with an index. A stray attribute on one geometry fails the whole
 * batch, so they are dropped here rather than discovered at merge time.
 */
export function normaliseForMerge(geometry) {
  const pos = geometry.getAttribute('position');
  if (!pos) return null;

  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  if (!geometry.getAttribute('uv')) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  }
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') {
      geometry.deleteAttribute(name);
    }
  }
  if (!geometry.index) {
    const count = pos.count;
    const index = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) index[i] = i;
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }
  geometry.clearGroups();
  return geometry;
}
