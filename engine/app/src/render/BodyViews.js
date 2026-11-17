import * as THREE from 'three';
import { Vec3 } from '@sdfphys/core';

const origin = new Vec3();

/**
 * Keeps one view per rigid body in sync with the simulation. A view is a Group placed at the
 * body's shape origin (meshes authored in the shape's model space need no offset) that hosts
 * per-body overlays, plus its content: either an Object3D child, or a part drawn elsewhere
 * (see PartSkin) whose matrix is written from the view when it moves. Such parts name the
 * object that draws them (`host`), which is added to the scene once. A body that has not moved
 * since the last sync (a sleeper, a part held in place) costs a comparison.
 */
export class BodyViews {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = 'bodies';
    this.hosts = new THREE.Group();
    this.hosts.name = 'hosts';
    scene.add(this.root, this.hosts);
    this.views = new Map();
  }

  /** `content`: an Object3D, or a part with a `host` and setMatrix / setColor / visible / dispose. */
  add(body, content) {
    const view = new THREE.Group();
    view.name = body.name;
    view.matrixAutoUpdate = false; // set by syncOne, only when the body has moved
    view.userData.pose = new Float64Array(7).fill(NaN); // origin and quaternion last shown
    view.userData.body = body;
    view.userData.content = content;
    if (content.isObject3D) view.add(content);
    else if (content.host.parent !== this.hosts) this.hosts.add(content.host);
    this.root.add(view);
    this.views.set(body, view);
    this.syncOne(body, view);
    return view;
  }

  get(body) {
    return this.views.get(body);
  }

  remove(body) {
    const view = this.views.get(body);
    if (!view) return;
    view.userData.content.dispose?.();
    this.root.remove(view);
    this.views.delete(body);
  }

  clear() {
    for (const view of this.views.values()) view.userData.content.dispose?.();
    this.root.clear();
    this.views.clear();
  }

  /** Moves `body`'s view (and what it shows) to the body's pose; nothing to do if it has not moved (a sleeper). */
  syncOne(body, view) {
    const o = body.getOrigin(origin);
    const q = body.quaternion;
    const last = view.userData.pose;
    if (last[0] === o.x && last[1] === o.y && last[2] === o.z && last[3] === q.x && last[4] === q.y && last[5] === q.z && last[6] === q.w) return;
    last[0] = o.x; last[1] = o.y; last[2] = o.z; last[3] = q.x; last[4] = q.y; last[5] = q.z; last[6] = q.w;
    view.position.set(o.x, o.y, o.z);
    view.quaternion.set(q.x, q.y, q.z, q.w);
    view.updateMatrix();
    view.userData.content.setMatrix?.(view.matrix);
  }

  sync() {
    for (const [body, view] of this.views) this.syncOne(body, view);
  }
}
