import { BufferAttribute } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Assembly } from '@sdfphys/core';
import { PartSkin } from '../render/PartSkin.js';
import { ByteProgress } from './ByteProgress.js';

/**
 * A baked assembly plus its render model. Physics comes from manifest.json + shapes.bin (SDFs),
 * looks come from the GLB: each part's textured mesh rides on its body, so render geometry and
 * collision geometry stay fully decoupled. The parts are merged into one skinned mesh (see
 * PartSkin), so each spawn draws in one call per material.
 */
export class AssemblyModel {
  /**
   * Loads the model in `baseUrl`: the manifest, then its shapes and its GLB together; `progress`
   * (a ByteProgress) is told how their bytes come.
   */
  static async load(baseUrl, progress = new ByteProgress()) {
    const url = new URL('manifest.json', new URL(baseUrl, window.location.href)).href;
    const manifest = await (await fetch(url)).json();
    const [assembly, parts] = await Promise.all([
      Assembly.load(url, { fetch: progress.fetch, manifest }),
      manifest.render ? AssemblyModel._loadRender(new URL(manifest.render.url, url).href, manifest.scale ?? 1, progress) : new Map(),
    ]);
    return new AssemblyModel(assembly, new PartSkin(parts));
  }

  static async _loadRender(url, scale, progress) {
    const report = progress.track();
    let gltf;
    try {
      gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url, (e) => report(e.loaded, e.lengthComputable ? e.total : 0));
    } finally {
      report.done();
    }
    gltf.scene.updateMatrixWorld(true);
    const byName = new Map();
    gltf.scene.traverse((o) => {
      if (o.isMesh) {
        // bake node transforms so every part mesh is in model space (quantized attributes as floats first)
        const geometry = AssemblyModel._floats(o.geometry.clone()).applyMatrix4(o.matrixWorld);
        if (scale !== 1) geometry.scale(scale, scale, scale);
        const key = AssemblyModel._partName(o, gltf.scene);
        const list = byName.get(key) ?? [];
        list.push({ geometry, material: o.material });
        byName.set(key, list);
      }
    });
    return byName;
  }

  /**
   * `geometry` with its quantized position and normal (KHR_mesh_quantization: integers, maybe
   * normalized) as floats, which a baked transform can move anywhere.
   */
  static _floats(geometry) {
    for (const name of ['position', 'normal']) {
      const a = geometry.getAttribute(name);
      if (!a || a.array instanceof Float32Array) continue;
      const f = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) f[i * a.itemSize + k] = a.getComponent(i, k);
      geometry.setAttribute(name, new BufferAttribute(f, a.itemSize));
    }
    return geometry;
  }

  /** Name of the glTF node that owns a mesh (meshes with several primitives sit under a group). */
  static _partName(mesh, root) {
    const parent = mesh.parent;
    return parent && parent !== root && parent.name && mesh.name.startsWith(parent.name) ? parent.name : mesh.name;
  }

  constructor(assembly, skin) {
    this.assembly = assembly;
    this.skin = skin;
  }

  /** Frees its drawing (PartSkin.dispose): once none of its bodies is left in the scene. */
  dispose() {
    this.skin.dispose();
  }

  get name() {
    return this.assembly.name;
  }

  /**
   * Spawns the bodies and attaches the part meshes to them. `at` is where the model's lowest
   * point goes (default: standing on the ground at the origin).
   */
  spawn(world, views, { at = [0, 0, 0], quaternion = [0, 0, 0, 1], ...rig } = {}) {
    const lift = 0.002 - this.assembly.bounds.min[1];
    const position = [at[0], at[1] + lift, at[2]];
    const instance = this.assembly.spawn(world, { position, quaternion, ...rig });
    const skin = this.skin.spawn();
    for (const body of instance.bodies) views.add(body, skin.part(body.name));
    return instance;
  }

  /** Spawns part `index` as a loose body (no joints), its centre of mass at `position`. */
  spawnPart(world, views, index, pose) {
    const body = this.assembly.spawnPart(world, index, pose);
    views.add(body, this.skin.loosePart(body.name));
    return body;
  }
}
