import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { RigidBody, BoxShape, SphereShape, PlaneShape, Quat, Vec3, Narrowphase, SampleTree } from '../src/index.js';
import { loadAssemblyFromDisk } from './helpers.js';

test('the tree partitions the samples into leaves and every node bounds its samples', () => {
  const shape = new BoxShape([0.3, 0.1, 0.2], { samplesPerEdge: 8 });
  const s = shape.samples;
  const tree = new SampleTree(s, 12);
  assert.deepEqual([...tree.members].sort((a, b) => a - b), Array.from({ length: s.length / 3 }, (_, i) => i));
  const inLeaves = [];
  for (let c = 0; c < tree.count; c++) {
    if (tree.isLeaf(c)) {
      assert.ok(tree.to[c] - tree.from[c] <= 12);
      for (let m = tree.from[c]; m < tree.to[c]; m++) inLeaves.push(tree.members[m]);
    } else {
      // children tile the parent's range: first child starts at the parent, last ends at it
      assert.equal(tree.from[c + 1], tree.from[c]);
      assert.equal(tree.to[tree.skip[c + 1]], tree.to[c]);
    }
    for (let m = tree.from[c]; m < tree.to[c]; m++) {
      const i = tree.members[m] * 3;
      const d = Math.hypot(s[i] - tree.centres[c * 3], s[i + 1] - tree.centres[c * 3 + 1], s[i + 2] - tree.centres[c * 3 + 2]);
      assert.ok(d <= tree.radii[c] + 1e-9);
    }
  }
  assert.equal(inLeaves.length, s.length / 3, 'every sample in exactly one leaf');
});

/** Every sample of S within `margin` of D's surface, by brute force (the narrowphase's own test). */
function bruteForce(S, D, margin) {
  const out = [];
  const p = new Vec3();
  const box = D.shape.infinite ? null : D.shape.localAabb;
  const s = S.localSamples;
  for (let i = 0; i < s.length; i += 3) {
    p.set(s[i], s[i + 1], s[i + 2]).applyQuat(S.quaternion).add(S.position);
    p.sub(D.position).applyQuatInverse(D.quaternion).add(D.com);
    if (box && (p.x < box.min.x - margin || p.x > box.max.x + margin || p.y < box.min.y - margin ||
      p.y > box.max.y + margin || p.z < box.min.z - margin || p.z > box.max.z + margin)) continue;
    if (D.shape.distance(p.x, p.y, p.z) < margin) out.push(`${s[i]},${s[i + 1]},${s[i + 2]}`);
  }
  return out.sort();
}

function culled(np, S, D) {
  S.rotation.setFromQuat(S.quaternion);
  D.rotation.setFromQuat(D.quaternion);
  if (S.localSamples.length / 3 > np._cap) np._grow(S.localSamples.length / 3);
  np._n = np._nt = np._ns = 0;
  np._gather(S, D, np.margin, 0);
  const s = S.localSamples;
  return Array.from(np._idx.subarray(0, np._n), (i) => `${s[i * 3]},${s[i * 3 + 1]},${s[i * 3 + 2]}`).sort();
}

const DIR = process.env.ASSEMBLY_DIR ?? fileURLToPath(new URL('../../app/public/models/mecha_01', import.meta.url));
const assembly = loadAssemblyFromDisk(DIR);

test('tree culling finds exactly the samples a full scan finds', () => {
  const np = new Narrowphase({ margin: 0.004 });
  const shapes = [new SphereShape(0.1), new BoxShape([0.12, 0.05, 0.08], { samplesPerEdge: 10 })];
  if (assembly) shapes.push(...assembly.parts.slice(0, 6).map((p) => p.shape));
  const bodies = shapes.map((shape) => new RigidBody({ shape }));
  const ground = new RigidBody({ shape: new PlaneShape(), type: 'static' });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let pairs = 0, found = 0;
  for (let trial = 0; trial < 1500; trial++) {
    const a = bodies[trial % bodies.length];
    const b = bodies[(trial * 7 + 3) % bodies.length];
    if (a === b) continue;
    for (const [body, spread] of [[a, 0], [b, 0.15]]) {
      body.position.set((rnd() - 0.5) * spread, 0.05 + (rnd() - 0.5) * spread, (rnd() - 0.5) * spread);
      body.quaternion.copy(new Quat().setFromAxisAngle(new Vec3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), rnd() * 6.3));
    }
    for (const [S, D] of [[a, b], [b, a], [a, ground]]) {
      const expected = bruteForce(S, D, np.margin);
      assert.deepEqual(culled(np, S, D), expected);
      pairs++;
      found += expected.length;
    }
  }
  assert.ok(found > 100, `poses produce contacts (${found} over ${pairs} pairs)`);
});

test('closest: gap and point of two boxes, overlap negative, null beyond reach', () => {
  const np = new Narrowphase();
  const box = (x) => new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1], { samplesPerEdge: 8 }), position: [x, 0, 0] });
  const a = box(0);
  const near = np.closest(a, box(0.215), 0.05); // faces 1.5 cm apart
  assert.ok(near && Math.abs(near.gap - 0.015) < 0.003, `gap ${near?.gap}`);
  assert.ok(near.point.x > 0.09 && near.point.x < 0.125, `point on a facing face, x ${near.point.x}`);
  const over = np.closest(a, box(0.19), 0.05); // 1 cm overlap
  assert.ok(over.gap < -0.005, `overlap ${over.gap}`);
  assert.equal(np.closest(a, box(0.4), 0.05), null);
});
