import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshTopology, ConvexHull, pocketOf, TrapSplitter } from '../src/segment/index.js';

/**
 * A bowl: a hemispherical shell of outer radius R and wall t, opening up at y = 0 (outer and inner
 * skins and the rim between them), as a triangle soup.
 */
function bowl(R = 0.3, t = 0.01, rings = 16, segs = 48) {
  const P = [];
  const at = (r, i, j) => {
    const th = ((Math.PI / 2) * i) / rings, ph = (2 * Math.PI * j) / segs;
    return [r * Math.sin(th) * Math.cos(ph), -r * Math.cos(th), r * Math.sin(th) * Math.sin(ph)];
  };
  for (const r of [R, R - t]) {
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = at(r, i, j), b = at(r, i, j + 1), c = at(r, i + 1, j + 1), d = at(r, i + 1, j);
        if (i > 0) P.push(...a, ...b, ...c);
        P.push(...a, ...c, ...d);
      }
    }
  }
  for (let j = 0; j < segs; j++) {
    const a = at(R, rings, j), b = at(R, rings, j + 1), c = at(R - t, rings, j + 1), d = at(R - t, rings, j);
    P.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return new MeshTopology(Float32Array.from(P), Uint32Array.from(P.map((_, i) => i).filter((i) => i % 3 === 0).map((i) => i / 3)));
}

/** A closed box (2 triangles a side) of half sizes (x, y, z). */
function box(x, y, z) {
  const c = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  const I = quads.flatMap(([a, b, cc, d]) => [a, b, cc, a, cc, d]);
  return new MeshTopology(Float32Array.from(c.flat()), Uint32Array.from(I));
}

const all = (topo) => Array.from({ length: topo.faceCount }, (_, f) => f);

test('the convex hull of a point cloud', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cube = [];
  for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) cube.push(x, y, z);
  for (let i = 0; i < 500; i++) cube.push(rand(), rand(), rand());
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) cube.push(i / 4, j / 4, 0); // coplanar with a side
  const h = new ConvexHull(Float64Array.from(cube));
  assert.ok(Math.abs(h.volume - 1) < 1e-9, `the unit cube's volume (${h.volume})`);
  assert.ok(h.contains(0.5, 0.5, 0.5) && !h.contains(1.01, 0.5, 0.5));
  const sphere = [];
  for (let i = 0; i < 3000; i++) {
    const z = 2 * rand() - 1, a = 2 * Math.PI * rand(), r = Math.sqrt(1 - z * z);
    sphere.push(r * Math.cos(a), r * Math.sin(a), z);
  }
  const s = new ConvexHull(Float64Array.from(sphere));
  for (let i = 0; i < sphere.length; i += 3) assert.ok(s.contains(sphere[i], sphere[i + 1], sphere[i + 2], -1e-9), 'every point is in');
  assert.ok(s.volume > 0.97 * (4 / 3) * Math.PI && s.volume < (4 / 3) * Math.PI);
  assert.ok(new ConvexHull(Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])).flat, 'a flat set has no inside');
});

test('a bowl has room for a ball; a box has none', () => {
  const t = bowl();
  const p = pocketOf(t, all(t), () => true, 0.01);
  // the biggest ball in a half-ball of radius 0.29 m is 0.145 m; the grid finds it to about a voxel
  assert.ok(Math.abs(p.radius - 0.145) < 0.015, `ball ${p.radius.toFixed(3)} m`);
  assert.ok(p.centre[1] < -0.1, 'down in the bowl');
  assert.ok(p.wrap > 0.6, `the bowl surrounds it (${p.wrap.toFixed(2)})`);
  const b = box(0.2, 0.1, 0.15);
  assert.equal(pocketOf(b, all(b), () => true, 0.01).radius, 0, 'a box is its own hull');
});

test('a bowl is cut until no piece can trap a ball', () => {
  const t = bowl();
  const labels = new Int32Array(t.faceCount);
  const splitter = new TrapSplitter(t, { radius: 0.06 }, 24); // pockets over 3.6 cm in this 60 cm bowl
  const stats = splitter.run(labels);
  const count = new Set(labels).size;
  assert.equal(stats.traps, 1);
  assert.ok(count >= 2 && count <= 6, `${count} pieces`);
  for (let l = 0; l < count; l++) {
    const faces = all(t).filter((f) => labels[f] === l);
    assert.ok(faces.length >= 24);
    assert.ok(!splitter.traps(splitter.pocket(faces, (g) => labels[g] === l)), `piece ${l} traps nothing`);
  }
});
