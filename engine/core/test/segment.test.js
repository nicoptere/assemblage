import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshTopology, Segmenter, segmentMesh } from '../src/segment/index.js';
import { Assembly } from '../src/index.js';

/**
 * A cube of side `s` at `at`, each face cut into n x n quads, as a triangle soup (no shared
 * vertices: the welding finds them), wound outwards unless `inside`.
 */
function cube(at, s, n = 4, inside = false) {
  const P = [], I = [];
  const faces = [[0, 1, 2], [1, 2, 0], [2, 0, 1]]; // (normal axis, u, v), each side twice
  for (const [a, u, v] of faces) {
    for (const side of [0, 1]) {
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const quad = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([x, y]) => {
          const p = [0, 0, 0];
          p[a] = side * s;
          p[u] = (x / n) * s;
          p[v] = (y / n) * s;
          return p.map((c, k) => c + at[k]);
        });
        const base = P.length / 3;
        for (const q of quad) P.push(...q);
        // the quad's normal is u x v along +a (or -a); flip to point out of the cube
        const nx = [0, 0, 0];
        nx[u] = 1;
        const ny = [0, 0, 0];
        ny[v] = 1;
        const cross = [nx[1] * ny[2] - nx[2] * ny[1], nx[2] * ny[0] - nx[0] * ny[2], nx[0] * ny[1] - nx[1] * ny[0]][a];
        const out = (cross > 0) === (side === 1) !== inside;
        I.push(...(out ? [base, base + 1, base + 2, base, base + 2, base + 3] : [base, base + 2, base + 1, base, base + 3, base + 2]));
      }
    }
  }
  return { P, I };
}

const join = (...meshes) => meshes.reduce((m, c) => ({ P: [...m.P, ...c.P], I: [...m.I, ...c.I.map((i) => i + m.P.length / 3)] }), { P: [], I: [] });

test('the topology welds, pairs and orients a soup', () => {
  const { P, I } = join(cube([0, 0, 0], 1), cube([3, 0, 0], 1, 4, true)); // the second one inside out
  const t = new MeshTopology(Float32Array.from(P), Uint32Array.from(I));
  assert.equal(t.vertexCount, 2 * (6 * 16 + 2), 'a 4x4-cut cube has 98 vertices');
  assert.equal(t.shells, 2);
  assert.ok(t.nbr.every((g) => g >= 0), 'closed: every edge has a face across');
  // both turned outwards: the normal of a face on the +x side of each cube points +x
  for (let f = 0; f < t.faceCount; f++) {
    const x = t.centroid[3 * f], local = x >= 2 ? x - 3 : x;
    if (Math.abs(local - 1) < 1e-6) assert.ok(t.normal[3 * f] > 0.99, `face ${f} faces out`);
  }
  // every edge's neighbour is across that very edge, flipped faces included
  assert.ok(t.flipped.some((x) => x), 'some faces were turned');
  for (let h = 0; h < t.nbr.length; h++) {
    const f = (h / 3) | 0, g = t.nbr[h];
    const u = t.F[h], v = t.F[3 * f + ((h % 3) + 1) % 3];
    const k = [0, 1, 2].find((e) => t.F[3 * g + e] === v && t.F[3 * g + ((e + 1) % 3)] === u);
    assert.ok(k !== undefined && t.nbr[3 * g + k] === f, `edge ${h} runs the other way in its neighbour, which points back`);
  }
  // cube edges fold 90°, flat faces 0°, and nothing is concave on a cube
  const angles = new Set([...t.angle].map((a) => Math.round((a * 180) / Math.PI)));
  assert.deepEqual([...angles].sort((a, b) => a - b), [0, 90]);
  assert.ok(t.concave.every((c) => !c));
});

test('separate shells are parts; a small floating bit joins the part under it', () => {
  const big = cube([0, 0, 0], 0.5, 6);
  const other = cube([0.5, 0, 0], 0.4, 6); // touching the first one's +x side
  const rivet = cube([0.2, 0.5, 0.2], 0.02, 1); // a small box sitting on top of the first one
  const { P, I } = join(big, other, rivet);
  const t = new MeshTopology(Float32Array.from(P), Uint32Array.from(I));
  const { labels, count, stats } = new Segmenter(t, { angle: 90, maxShell: 1, minPart: 0.01 }).run(); // a cube's 90° edges hold
  assert.equal(count, 2, 'two parts: the rivet merged');
  assert.equal(stats.floating, 1);
  const rivetFaces = I.length / 3 - rivet.I.length / 3;
  const bigFaces = big.I.length / 3;
  assert.equal(labels[rivetFaces], labels[0], 'the rivet went with the cube under it');
  assert.notEqual(labels[bigFaces], labels[0]);
});

test('groups: parts never cross them; a cube holds at 90° and splits at its edges at 60°', () => {
  const { P, I } = cube([0, 0, 0], 0.5, 6);
  const t = new MeshTopology(Float32Array.from(P), Uint32Array.from(I));
  assert.equal(new Segmenter(t, { maxShell: 1, minPart: 0.01 }).run().count, 1, 'whole at the default 90°');
  assert.equal(new Segmenter(t, { angle: 60, maxShell: 1, minPart: 0.01 }).run().count, 6, 'one part per face at 60°');
  // two groups: the faces whose centre is left of x = 0.25 and the others
  const groups = new Int32Array(t.faceCount).map((_, f) => (t.centroid[3 * f] < 0.25 ? 0 : 1));
  const { labels, count } = new Segmenter(t, { angle: 90, maxShell: 1, minPart: 0.001, groups, traps: false }).run();
  assert.equal(count, 2, 'whole at 90°, but cut in two by the groups');
  for (let f = 0; f < t.faceCount; f++) assert.equal(groups[f], groups[labels.indexOf(labels[f])], 'a part stays in its group');
});

test('segmentMesh bakes solid parts, jointed where they touch', () => {
  const { P, I } = join(cube([0, 0, 0], 0.5, 6), cube([0.5, 0, 0], 0.4, 6));
  const out = segmentMesh(Float32Array.from(P), Uint32Array.from(I), { segment: { angle: 90, maxShell: 1 }, bake: { name: 'cubes' } });
  assert.equal(out.manifest.parts.length, 2);
  assert.equal(out.manifest.joints.length, 1, 'one joint where the cubes touch');
  const j = out.manifest.joints[0];
  assert.ok(Math.abs(j.anchor[0] - 0.5) < 0.02, 'anchored on the shared face');
  assert.ok(Math.abs(Math.abs(j.normal[0]) - 1) < 0.05, 'normal across it');
  assert.ok(Math.abs(j.area - 0.16) < 0.04, `patch about the smaller face (${j.area.toFixed(3)} m²)`);
  const asm = new Assembly(out.manifest, out.buffer);
  const h = asm.parts[0].shape.voxel;
  asm.parts.forEach((p, i) => {
    const side = i === 0 ? 0.5 : 0.4;
    const { mass } = p.shape.massProperties(1000);
    const expected = 1000 * (side + h) ** 3; // grown by half a voxel all round
    assert.ok(Math.abs(mass - expected) / expected < 0.06, `part ${i}: ${mass.toFixed(1)} kg, about ${expected.toFixed(1)}`);
    const S = p.shape.samples;
    for (let k = 0; k < S.length; k += 3) assert.ok(Math.abs(p.shape.distance(S[k], S[k + 1], S[k + 2])) < 0.3 * h, 'samples on the surface');
    assert.ok(p.shape.distance(i === 0 ? 0.25 : 0.7, 0.2, 0.2) < -0.15, 'inside is inside');
  });
});
