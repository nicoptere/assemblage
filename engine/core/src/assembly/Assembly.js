import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { RigidBody } from '../body/RigidBody.js';
import { Joint } from '../constraints/Joint.js';
import { SdfGridShape } from '../shapes/SdfGridShape.js';
import { CollisionFilter } from '../world/CollisionFilter.js';

export const ARTICULATION_REACH = 0.03; // m: parts this close to an articulation's anchor (past its radius) do not collide across it
export const RIG_DEFAULTS = Object.freeze({
  density: 1000, // kg/m^3
  friction: 0.7,
  restitution: 0.05,
  weldCompliance: 0, // rad/(N m) for 'fixed' joints (0 = rigid weld)
  articulationCompliance: 2e-4, // rad/(N m) drive softness of 'ball' joints (Infinity = limp ragdoll)
  jointStrength: 2e6, // Pa: break force = strength x contact patch area
  minBreakForce: 400, // N, floor for tiny patches and bridges (survive handling, not impacts)
  minBreakArm: 0.03, // m, floor for the lever that turns break force into break torque
  settleTime: 0.5, // s after spawn during which joints are unbreakable and their loads are measured
  loadSafety: 2, // joints always hold at least this multiple of the load measured while settling
  breakable: true,
});

/**
 * A baked assembly (physbake output): one SDF shape per part plus joint specs from contact
 * patches. Shapes are shared by every spawned instance.
 */
export class Assembly {
  constructor(manifest, buffer) {
    if (manifest.format !== 'sdfphys-assembly') throw new Error(`Unknown assembly format: ${manifest.format}`);
    this.manifest = manifest;
    this.name = manifest.name;
    this.parts = manifest.parts.map((p) => ({ ...p, shape: SdfGridShape.fromBaked(p, buffer) }));
    this.joints = manifest.joints;
  }

  /**
   * Loads manifest.json and its binary from a URL (browser or any fetch implementation); a binary
   * named *.gz is gzipped (see gunzip). `manifest`: the manifest at `url`, read already.
   */
  static async load(url, { fetch: fetchFn = globalThis.fetch, manifest: read = null } = {}) {
    const manifest = read ?? (await (await fetchFn(url)).json());
    const base = new URL(url, globalThis.location?.href ?? 'file:///');
    const buffer = await (await fetchFn(new URL(manifest.data, base).href)).arrayBuffer();
    return new Assembly(manifest, manifest.data.endsWith('.gz') ? await Assembly.gunzip(buffer) : buffer);
  }

  /**
   * Inflates gzipped bytes (DecompressionStream), unless they are not gzipped any more: a server
   * may send a .gz file with "Content-Encoding: gzip" (Vite's does), and the browser inflates it.
   */
  static async gunzip(buffer) {
    const b = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
    if (b[0] !== 0x1f || b[1] !== 0x8b) return buffer;
    return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }

  get bounds() {
    return this.manifest.bounds;
  }

  /** Creates the bodies and joints in `world`, placing the model origin at `position`. */
  spawn(world, { position = [0, 0, 0], quaternion = [0, 0, 0, 1], ...options } = {}) {
    const rig = { ...RIG_DEFAULTS, ...options };
    const q = Quat.from(quaternion);
    const offset = Vec3.from(position);

    const bodies = this.parts.map((part) => world.addBody(Assembly._body(part, rig, offset, q)));

    const joints = this.joints.map((spec) => {
      const anchor = Vec3.from(spec.anchor).applyQuat(q).add(offset);
      const axis = Vec3.from(spec.normal).applyQuat(q);
      const joint = new Joint(bodies[spec.a], bodies[spec.b], {
        kind: spec.kind === 'fixed' ? 'fixed' : 'ball',
        anchor,
        axis,
        angularCompliance: spec.kind === 'fixed' ? rig.weldCompliance : rig.articulationCompliance,
        userData: { spec },
      });
      return world.addJoint(joint);
    });

    const instance = new AssemblyInstance(this, world, bodies, joints, rig);
    world.ignoreOverlaps(bodies);
    return instance;
  }

  /**
   * The parts whose surface comes within `reach` (plus the joint's own radius) of articulation
   * `index`'s anchor: those that would rub as the joint turns (AssemblyInstance does not let them
   * collide while it holds). Parts are in model space, as the anchor. Cached.
   */
  nearJoint(index, reach = ARTICULATION_REACH) {
    this._near ??= new Map();
    if (!this._near.has(index)) {
      const spec = this.joints[index];
      const [x, y, z] = spec.anchor;
      const r = reach + (spec.radius ?? 0);
      this._near.set(index, this.parts.flatMap((p, i) => (p.shape.distance(x, y, z) <= r ? [i] : [])));
    }
    return this._near.get(index);
  }

  /** One part as a free body (no joints), with its centre of mass at `position`. */
  spawnPart(world, index, { position = [0, 0, 0], quaternion = [0, 0, 0, 1], ...options } = {}) {
    const body = Assembly._body(this.parts[index], { ...RIG_DEFAULTS, ...options }, new Vec3(), Quat.from(quaternion));
    body.setOrigin(Vec3.from(position).sub(body.com.clone().applyQuat(body.quaternion)));
    return world.addBody(body);
  }

  /** A part's body, its shape origin (the model origin) at `origin`. */
  static _body(part, rig, origin, quaternion) {
    return new RigidBody({
      shape: part.shape,
      position: origin,
      quaternion,
      density: rig.density,
      friction: rig.friction,
      restitution: rig.restitution,
      name: part.name,
      userData: { part },
    });
  }
}

/**
 * A spawned assembly. Joint strength is `jointStrength x patch area`, but never less than
 * `loadSafety` times the load each joint carried while the model settled under its own weight
 * (measured for `settleTime` after spawn, joints unbreakable meanwhile). So any model that can
 * stand keeps standing, and only extra loads (impacts, drags, drops) break joints. A model spawned
 * in the air measures ~no load and gets the plain strength, so its landing can break it.
 */
export class AssemblyInstance {
  constructor(assembly, world, bodies, joints, rig = RIG_DEFAULTS) {
    this.assembly = assembly;
    this.world = world;
    this.bodies = bodies;
    this.joints = joints;
    this.weldPairs = new Map(); // pair key -> [a, b] excluded because they share a weld cluster
    this.strength = {
      pascal: rig.breakable ? rig.jointStrength : Infinity,
      minBreakForce: rig.minBreakForce ?? RIG_DEFAULTS.minBreakForce,
      minBreakArm: rig.minBreakArm ?? RIG_DEFAULTS.minBreakArm,
      safety: rig.loadSafety ?? RIG_DEFAULTS.loadSafety,
    };
    this.loadForce = new Float64Array(joints.length);
    this.loadTorque = new Float64Array(joints.length);
    this.settled = false;
    for (const j of joints) j.breakForce = j.breakTorque = Infinity;
    const until = world.time + (rig.settleTime ?? RIG_DEFAULTS.settleTime);

    this._updateWeldFilter();
    const offRemoved = world.on('jointRemoved', ({ joint }) => {
      if (this.joints.includes(joint)) this._updateWeldFilter();
    });
    const offStep = world.on('step', () => {
      if (this.settled) return;
      this.joints.forEach((j, i) => {
        this.loadForce[i] = Math.max(this.loadForce[i], j.force);
        this.loadTorque[i] = Math.max(this.loadTorque[i], j.torque);
      });
      if (world.time >= until) {
        this.settled = true;
        this._applyStrength();
      }
    });
    this._off = () => { offRemoved(); offStep(); };
  }

  get intactJoints() {
    return this.joints.filter((j) => !j.removed);
  }

  /**
   * Parts welded together (directly or through other welds) cannot move relative to each other,
   * so collisions between them are pointless and fight the welds (jitter). Exclude every pair of a
   * weld cluster, and, across an intact articulation, the pairs of parts on either side that come
   * close to its anchor (Assembly.nearJoint: the pieces of a knee would rub and jam it as it
   * turns); when a weld or an articulation breaks, the pairs resume once separated.
   */
  _updateWeldFilter() {
    const index = new Map(this.bodies.map((b, i) => [b, i]));
    const parent = this.bodies.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const j of this.intactJoints) if (j.kind === 'fixed') parent[find(index.get(j.bodyA))] = find(index.get(j.bodyB));
    const clusters = new Map();
    this.bodies.forEach((b, i) => {
      const r = find(i);
      if (!clusters.has(r)) clusters.set(r, []);
      clusters.get(r).push(b);
    });
    const next = new Map();
    const pair = (a, b) => next.set(CollisionFilter.key(a, b), [a, b]);
    for (const members of clusters.values()) {
      for (let i = 0; i < members.length; i++) {
        for (let k = i + 1; k < members.length; k++) pair(members[i], members[k]);
      }
    }
    this.joints.forEach((j, n) => {
      if (j.removed || j.kind === 'fixed') return;
      const near = this.assembly.nearJoint(n);
      const ra = find(index.get(j.bodyA)), rb = find(index.get(j.bodyB));
      const sideA = near.filter((i) => find(i) === ra), sideB = near.filter((i) => find(i) === rb);
      for (const a of sideA) for (const b of sideB) pair(this.bodies[a], this.bodies[b]);
    });
    const filter = this.world.filter;
    for (const [key, [a, b]] of this.weldPairs) {
      if (next.has(key)) continue;
      filter.unignore(a, b);
      filter.ignoreUntilSeparated(a, b);
    }
    for (const [key, [a, b]] of next) if (!this.weldPairs.has(key)) filter.ignore(a, b);
    this.weldPairs = next;
  }

  setArticulationCompliance(alpha) {
    for (const j of this.joints) if (j.kind === 'ball') j.angularCompliance = alpha;
  }

  /** Sets the base strength (Pa, Infinity = unbreakable); applied once the model has settled. */
  setJointStrength(pascal) {
    this.strength.pascal = pascal;
    if (this.settled) this._applyStrength();
  }

  _applyStrength() {
    const { pascal, minBreakForce, minBreakArm, safety } = this.strength;
    this.joints.forEach((j, i) => {
      const { area, radius } = j.userData.spec;
      const base = Math.max(minBreakForce, pascal * area);
      j.breakForce = Math.max(base, safety * this.loadForce[i]);
      j.breakTorque = Math.max(base * Math.max(minBreakArm, radius), safety * this.loadTorque[i]);
    });
  }

  /** Wakes every part (after changing the rig, so the new settings take effect). */
  wake() {
    for (const b of this.bodies) b.wake();
  }

  /** Total mass and centre of mass of the parts. */
  centreOfMass(out = new Vec3()) {
    let m = 0;
    out.set(0, 0, 0);
    for (const b of this.bodies) {
      out.addScaled(b.position, b.mass);
      m += b.mass;
    }
    return out.scale(1 / m);
  }

  remove() {
    this._off();
    for (const b of this.bodies) this.world.removeBody(b);
  }
}
