import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TEXELS = 4; // per part and spawn: the 3 rows of its pose (a 3x4 matrix), then its tint
const WHITE = new THREE.Color(1, 1, 1);

/** Materials that render identically share a key (same type, scalars and textures). */
function materialKey(m) {
  const key = [m.type, m.side, m.transparent, m.opacity, m.color?.getHex(), m.metalness, m.roughness, m.vertexColors];
  for (const name of Object.keys(m)) if (m[name]?.isTexture) key.push(name, m[name].uuid);
  return key.join('|');
}

/** Plain float copy of an attribute (merging needs identical array types; glTF may quantize). */
function plain(a) {
  if (a.array instanceof Float32Array && !a.normalized && !a.isInterleavedBufferAttribute) return a;
  const get = [a.getX, a.getY, a.getZ, a.getW];
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = get[c].call(a, i);
  return new THREE.BufferAttribute(out, a.itemSize);
}

// vertex shader additions: every vertex of part p in instance (spawn) i is moved by that part's
// pose and tinted by its tint, both read from the poses texture (row i, texels 4p .. 4p + 3)
const PARS = /* glsl */ `
uniform highp sampler2D partPoses;
attribute float part;
vec4 partTexel(int k) { return texelFetch(partPoses, ivec2(int(part) * ${TEXELS} + k, gl_InstanceID), 0); }
mat4 partPose() {
  vec4 r0 = partTexel(0), r1 = partTexel(1), r2 = partTexel(2);
  return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
}`;

/** Makes `material` draw a PartSkin's instances (its poses in `uniform`); every such material shares one program per kind. */
function instanced(material, uniform) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.partPoses = uniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        objectNormal = mat3(partPose()) * objectNormal;
        #ifdef USE_TANGENT
          objectTangent = mat3(partPose()) * objectTangent;
        #endif`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = (partPose() * vec4(transformed, 1.0)).xyz;')
      .replace('#include <color_vertex>', '#include <color_vertex>\n#ifdef USE_COLOR\nvColor.xyz *= partTexel(3).rgb;\n#endif');
  };
  material.customProgramCacheKey = () => 'part-skin';
  return material;
}

/**
 * Every part mesh of one model merged into one geometry per distinct material, and every spawn
 * of the model drawn at once: one instanced draw call per material (plus one for the shadow map),
 * however many spawns there are. Instance i is spawn i; vertex v of part p takes its pose and its
 * tint from a float texture (row i, texels 4p .. 4p + 3: the pose's three rows, then the tint),
 * written by the parts' handles and sent to the GPU once a frame. A hidden part has a zero pose
 * (collapsed to a point). Any WebGL2 browser: no multi-draw extension needed (THREE.BatchedMesh
 * would draw part by part without it, as in Firefox). Every part is drawn from both sides; a
 * material's transparency is kept as its file has it (glTF's BLEND and opacity; MASK cut-outs, in
 * its shadow too).
 *
 * Spawns share the merged vertex data. Released spawns are reused (the lowest first, so the
 * instance count stays small). Loose parts (no model around them) borrow a spawn that does not
 * show that part yet, so dealing a model's parts in turn fills one spawn before the next is needed.
 * `parts` maps a part name to its primitives [{ geometry, material }], in model space.
 */
export class PartSkin {
  constructor(parts, { capacity = 4 } = {}) {
    this.names = [...parts.keys()];
    this.index = new Map(this.names.map((name, i) => [name, i]));
    this.width = TEXELS * Math.max(1, this.names.length);
    this.uniform = { value: null };
    this.capacity = 0;
    this.data = null;
    this._grow(capacity);
    const groups = new Map(); // material key -> { material, items: [{ part, geometry }] }
    for (const [name, primitives] of parts) {
      for (const { geometry, material } of primitives) {
        const key = materialKey(material);
        if (!groups.has(key)) groups.set(key, { material, items: [] });
        groups.get(key).items.push({ part: this.index.get(name), geometry });
      }
    }
    this.object = new THREE.Group();
    this.object.name = 'parts';
    this.object.visible = false; // until a spawn shows
    this.meshes = [...groups.values()].map(({ material, items }) => this._mesh(material, items));
    this.slots = []; // spawn index -> Spawn
    this.free = []; // released spawns, reused lowest first
    this.loose = []; // spawns lending parts to loose bodies
    this.count = 0; // instances drawn: the highest spawn in use + 1
  }

  /** Takes it out of the scene and frees what it drew with (geometries, materials, their textures, the poses). */
  dispose() {
    this.object.removeFromParent();
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      for (const m of [mesh.material, mesh.customDepthMaterial, mesh.userData.normalMaterial]) {
        for (const value of Object.values(m)) if (value?.isTexture) value.dispose();
        m.dispose();
      }
    }
    this.uniform.value?.dispose();
  }

  /** A spawn: a row of poses, every part hidden. */
  spawn() {
    this.free.sort((a, b) => a.index - b.index);
    const spawn = this.free.shift() ?? new Spawn(this, this.slots.length);
    if (spawn.index === this.slots.length) this.slots.push(spawn);
    if (spawn.index >= this.capacity) this._grow(2 * this.capacity);
    spawn.reset();
    this._count();
    return spawn;
  }

  /** The handle of one loose part, from a spawn that does not show that part yet. */
  loosePart(name) {
    this.loose = this.loose.filter((s) => s.live > 0);
    let spawn = this.loose.find((s) => !s.used.has(name));
    if (!spawn) this.loose.push((spawn = this.spawn()));
    return spawn.part(name);
  }

  /** Writes part `p`'s pose in spawn `i` (a Matrix4's elements, or null: hidden). */
  setPose(i, p, e) {
    const o = (i * this.width + p * TEXELS) * 4;
    const d = this.data;
    if (e) {
      d[o] = e[0]; d[o + 1] = e[4]; d[o + 2] = e[8]; d[o + 3] = e[12];
      d[o + 4] = e[1]; d[o + 5] = e[5]; d[o + 6] = e[9]; d[o + 7] = e[13];
      d[o + 8] = e[2]; d[o + 9] = e[6]; d[o + 10] = e[10]; d[o + 11] = e[14];
    } else d.fill(0, o, o + 12);
    this.uniform.value.needsUpdate = true;
  }

  setTint(i, p, c) {
    const o = (i * this.width + p * TEXELS + 3) * 4;
    this.data[o] = c.r;
    this.data[o + 1] = c.g;
    this.data[o + 2] = c.b;
    this.data[o + 3] = 1;
    this.uniform.value.needsUpdate = true;
  }

  _release(spawn) {
    this.free.push(spawn);
    this._count();
  }

  /** Instances drawn: up to the highest spawn in use (released ones above it are not drawn). */
  _count() {
    const freed = new Set(this.free);
    let n = this.slots.length;
    while (n > 0 && freed.has(this.slots[n - 1])) n--;
    this.count = n;
    for (const mesh of this.meshes) mesh.geometry.instanceCount = n;
    this.object.visible = n > 0;
  }

  /** Room for `capacity` spawns: a bigger poses texture, what was written kept. */
  _grow(capacity) {
    const data = new Float32Array(this.width * capacity * 4);
    if (this.data) data.set(this.data);
    const texture = new THREE.DataTexture(data, this.width, capacity, THREE.RGBAFormat, THREE.FloatType);
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    this.uniform.value?.dispose();
    this.uniform.value = texture;
    this.data = data;
    this.capacity = capacity;
  }

  /**
   * One merged geometry for a material's primitives: the attributes all share, `part` (the part
   * each vertex belongs to) and `color` (the source vertex colours if the material uses them,
   * else white: the tint multiplies it), drawn instanced.
   */
  _mesh(material, items) {
    const sets = items.map(({ geometry }) => Object.keys(geometry.attributes));
    const common = sets[0].filter((name) => name !== 'color' && name !== 'skinIndex' && name !== 'skinWeight' && sets.every((s) => s.includes(name)));
    const indexed = items.every(({ geometry }) => geometry.index);
    const useColor = material.vertexColors && sets.every((s) => s.includes('color'));
    const pieces = items.map(({ part, geometry }) => {
      const src = indexed || !geometry.index ? geometry : geometry.toNonIndexed();
      const g = new THREE.BufferGeometry();
      for (const name of common) g.setAttribute(name, plain(src.getAttribute(name)));
      if (indexed) g.setIndex(src.index);
      const n = g.attributes.position.count;
      g.setAttribute('part', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1));
      const color = new Uint8Array(3 * n).fill(255);
      if (useColor) {
        const c = src.getAttribute('color');
        for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) color[3 * v + k] = Math.round(255 * Math.min(1, [c.getX, c.getY, c.getZ][k].call(c, v)));
      }
      g.setAttribute('color', new THREE.BufferAttribute(color, 3, true));
      geometry.dispose();
      return g;
    });
    const merged = mergeGeometries(pieces);
    if (!merged) throw new Error('PartSkin: part geometries could not be merged');
    const geometry = new THREE.InstancedBufferGeometry();
    for (const [name, attribute] of Object.entries(merged.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(merged.index);
    geometry.instanceCount = 0;
    const shared = instanced(material.clone(), this.uniform);
    shared.vertexColors = true; // carries the per-part tint
    shared.userData.vertexColors = useColor; // whether the model has colours of its own (an export keeps them only then)
    shared.side = THREE.DoubleSide; // open or flipped surfaces (uploads) seen from behind too
    const mesh = new THREE.Mesh(geometry, shared);
    mesh.customDepthMaterial = instanced(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), this.uniform); // three gives it the material's side and cut-outs
    // its normals, for the ambient occlusion (AmbientOcclusionPass)
    mesh.userData.normalMaterial = instanced(new THREE.MeshNormalMaterial({ side: THREE.DoubleSide, blending: THREE.NoBlending }), this.uniform);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // its bounds move with the parts
    this.object.add(mesh);
    return mesh;
  }
}

/** One spawned model: a row of the poses texture, and the parts handed out of it. */
class Spawn {
  constructor(owner, index) {
    this.owner = owner;
    this.index = index;
    this.used = new Set(); // part names handed out
    this.live = 0;
  }

  reset() {
    this.live = 0;
    this.used.clear();
    for (let p = 0; p < this.owner.names.length; p++) {
      this.owner.setPose(this.index, p, null);
      this.owner.setTint(this.index, p, WHITE);
    }
  }

  /** The handle BodyViews moves, tints, hides and disposes for one part. */
  part(name) {
    if (this.used.has(name)) throw new Error(`PartSkin: part ${name} is already shown by this spawn`);
    this.used.add(name);
    this.live++;
    return new SkinnedPart(this, this.owner.index.get(name));
  }

  release() {
    if (--this.live > 0) return;
    this.owner._release(this);
  }
}

/** One part of a spawned model. */
class SkinnedPart {
  constructor(spawn, index) {
    this.spawn = spawn;
    this.owner = spawn.owner;
    this.host = spawn.owner.object; // shared by every spawn of the model, added to the scene once
    this.index = index;
    this.matrix = new THREE.Matrix4();
    this._visible = true;
    this._disposed = false;
  }

  setMatrix(matrix) {
    this.matrix.copy(matrix);
    if (this.index !== undefined && this._visible) this.owner.setPose(this.spawn.index, this.index, matrix.elements);
  }

  setColor(color) {
    if (this.index !== undefined) this.owner.setTint(this.spawn.index, this.index, color);
  }

  get visible() {
    return this._visible;
  }

  set visible(on) {
    this._visible = on;
    if (this.index !== undefined) this.owner.setPose(this.spawn.index, this.index, on ? this.matrix.elements : null);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.index !== undefined) this.owner.setPose(this.spawn.index, this.index, null);
    this.spawn.release();
  }
}
