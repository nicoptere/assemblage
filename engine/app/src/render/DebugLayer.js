import * as THREE from 'three';
import { Vec3 } from '@sdfphys/core';

const KIND_COLORS = { fixed: new THREE.Color(0x8a93a6), ball: new THREE.Color(0xffa23e), hinge: new THREE.Color(0x4fd1c5) };
const SLEEP_TINT = new THREE.Color(0x6f9dff);
const NO_TINT = new THREE.Color(1, 1, 1);

/** Points drawn in a body's shape space (samples, SDF shell) — attached to the body's view. */
function shapePoints(positions, color, size) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color, size, sizeAttenuation: true, depthTest: false }));
}

/** Grid nodes on the zero level set (|phi| < voxel / 2): shows what the physics actually sees. */
function sdfShell(shape) {
  if (!shape.data) return new Float32Array(0);
  const out = [];
  const { nx, ny, nz, voxel } = shape;
  let n = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, n++) {
        if (Math.abs(shape.data[n] * shape.scale) < voxel * 0.5) out.push(shape.ox + i * voxel, shape.oy + j * voxel, shape.oz + k * voxel);
      }
  return new Float32Array(out);
}

/** World-space overlay that is rebuilt every frame (contacts, joint anchors). */
class DynamicPoints {
  constructor(scene, capacity, size) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size, vertexColors: true, depthTest: false }));
    this.points.renderOrder = 10;
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
  }

  write(items, fill) {
    const n = Math.min(items.length, this.capacity);
    for (let i = 0; i < n; i++) fill(items[i], i, this.positions, this.colors);
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}

/** Debug views of the physics state: samples, SDF shells, contacts, joints, sleepers, render toggle. */
export class DebugLayer {
  constructor(scene, views) {
    this.views = views;
    this.flags = { samples: false, sdf: false, contacts: false, joints: false, sleeping: false, meshes: true };
    this.shells = new WeakMap();
    this.contacts = new DynamicPoints(scene, 4096, 0.012);
    this.joints = new DynamicPoints(scene, 1024, 0.02);
    this._p = new Vec3();
  }

  set(flag, on) {
    this.flags[flag] = on;
    this.contacts.points.visible = this.flags.contacts;
    this.joints.points.visible = this.flags.joints;
    this.refreshViews();
    this._tintSleepers();
  }

  /** (Re)applies per-body overlays and mesh visibility; call after views change. */
  refreshViews() {
    for (const [body, view] of this.views.views) {
      view.userData.content.visible = this.flags.meshes;
      this._overlay(view, 'samples', this.flags.samples, () => shapePoints(body.shape.samples, 0x55e0ff, 0.008));
      // samples in use are a prefix of the shape's (see Shape.samplesFor)
      view.userData.samples?.geometry.setDrawRange(0, body.localSamples.length / 3);
      this._overlay(view, 'sdf', this.flags.sdf, () => {
        if (!this.shells.has(body.shape)) this.shells.set(body.shape, sdfShell(body.shape));
        return shapePoints(this.shells.get(body.shape), 0xff5c8a, 0.004);
      });
    }
  }

  _overlay(view, key, on, make) {
    let o = view.userData[key];
    if (on && !o) {
      o = view.userData[key] = make();
      o.renderOrder = 5;
      view.add(o);
    }
    if (o) o.visible = on;
  }

  /** Tints sleeping bodies blue (skinned parts only); only touches views whose state changed. */
  _tintSleepers() {
    for (const [body, view] of this.views.views) {
      const asleep = this.flags.sleeping && body.sleeping;
      if ((view.userData.asleep ?? false) === asleep) continue;
      view.userData.asleep = asleep;
      view.userData.content.setColor?.(asleep ? SLEEP_TINT : NO_TINT);
    }
  }

  update(world) {
    if (this.flags.sleeping) this._tintSleepers();
    if (this.flags.contacts) {
      const p = this._p;
      this.contacts.write(world.contacts, (c, i, pos, col) => {
        c.worldPoint(p);
        pos.set([p.x, p.y, p.z], i * 3);
        const active = c.lambdaN > 0;
        col.set(active ? [1, 0.25, 0.3] : [0.35, 0.6, 1], i * 3);
      });
    }
    if (this.flags.joints) {
      const p = this._p;
      this.joints.write(world.joints, (j, i, pos, col) => {
        j.worldAnchorA(p);
        pos.set([p.x, p.y, p.z], i * 3);
        const c = KIND_COLORS[j.kind];
        col.set([c.r, c.g, c.b], i * 3);
      });
    }
  }
}
