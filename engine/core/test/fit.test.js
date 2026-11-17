import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RigidBody, BoxShape } from '../src/index.js';
import { TargetVolume, partStencil, ShapeFit } from '../src/fit/index.js';

/** UV sphere of radius r as { V, F } (closed). */
function sphere(r, n = 24) {
  const V = [], F = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const t = (Math.PI * i) / n, p = (2 * Math.PI * j) / n;
    V.push(r * Math.sin(t) * Math.cos(p), r * Math.cos(t), r * Math.sin(t) * Math.sin(p));
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i * (n + 1) + j, b = a + n + 1;
    F.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { V: Float64Array.from(V), F: Int32Array.from(F) };
}

/** A flat square sheet of side s (open). */
function sheet(s) {
  return { V: Float64Array.from([-s / 2, 0, -s / 2, s / 2, 0, -s / 2, s / 2, 0, s / 2, -s / 2, 0, s / 2]), F: Int32Array.from([0, 1, 2, 0, 2, 3]) };
}

test('a closed mesh becomes a solid (grown by half the shell), an open sheet a shell', () => {
  const ball = new TargetVolume(sphere(0.5), { voxel: 0.02, shell: 0.04 });
  const expected = (4 / 3) * Math.PI * 0.52 ** 3;
  assert.ok(Math.abs(ball.volume - expected) / expected < 0.1, `sphere volume ${ball.volume.toFixed(3)} vs ${expected.toFixed(3)}`);
  const plate = new TargetVolume(sheet(1), { voxel: 0.02, shell: 0.1 });
  assert.ok(Math.abs(plate.volume - 0.1) / 0.1 < 0.25, `sheet thickened to the shell: ${plate.volume.toFixed(3)} m3`);
  // mixed orientation does not matter: flip half the triangles
  const m = sphere(0.5);
  for (let f = 0; f < m.F.length; f += 6) [m.F[f + 1], m.F[f + 2]] = [m.F[f + 2], m.F[f + 1]];
  assert.equal(new TargetVolume(m, { voxel: 0.02, shell: 0.04 }).count, ball.count);
});

test('scaleForVolume sizes the target to a volume', () => {
  const scale = TargetVolume.scaleForVolume(sphere(0.5), 0.2, { shell: 0.04, voxel: 0.02 });
  const t = new TargetVolume(sphere(0.5), { scale, voxel: 0.02, shell: 0.04 });
  assert.ok(Math.abs(t.volume - 0.2) / 0.2 < 0.1, `volume ${t.volume.toFixed(3)} m3 for 0.2`);
});

test('parts are fitted inside the target and fill it', () => {
  const target = new TargetVolume(sphere(0.18), { voxel: 0.02, shell: 0.04, centre: [0, 1, 0] });
  const bodies = Array.from({ length: 40 }, (_, i) => new RigidBody({ shape: new BoxShape([0.05 + 0.01 * (i % 4), 0.04, 0.03 + 0.01 * (i % 3)]) }));
  const stencils = bodies.map((b) => partStencil(b.shape, b.com, target.voxel));
  const { placements, stats } = new ShapeFit(target, { seed: 3 }).fit(stencils);
  assert.ok(placements.length >= 20, `${placements.length} of 40 placed`);
  assert.ok(stats.iou > 0.5, `IoU ${stats.iou.toFixed(2)}`);
  for (const p of placements) {
    const d = Math.hypot(p.position[0], p.position[1] - 1, p.position[2]);
    assert.ok(d < 0.2, `part centre inside the sphere (${d.toFixed(3)} m from its centre)`);
    assert.ok(p.gain >= 0.4);
  }
  // deterministic for a seed
  const again = new ShapeFit(target, { seed: 3 }).fit(stencils);
  assert.deepEqual(again.placements.map((p) => p.index), placements.map((p) => p.index));
});

test('a big target is hollowed to a shell that holds a given volume', () => {
  const t = new TargetVolume(sphere(0.5), { voxel: 0.02, shell: 0.04 });
  const solid = t.volume;
  const c = [Math.round(-t.lo[0] / t.voxel), Math.round(-t.lo[1] / t.voxel), Math.round(-t.lo[2] / t.voxel)];
  const at = (i) => (c[2] * t.ny + c[1]) * t.nx + i;
  let edge = c[0];
  while (t.inside[at(edge + 1)]) edge++; // outermost solid node along +x
  t.hollow(0.1 * solid);
  // whole layers of voxels: at least the volume asked for, at most about one layer (4 pi r^2 h) more
  const layer = 4 * Math.PI * 0.52 ** 2 * 0.02;
  assert.ok(t.volume >= 0.1 * solid && t.volume <= 0.1 * solid + 1.2 * layer, `shell holds ${t.volume.toFixed(3)} for ${(0.1 * solid).toFixed(3)} m3`);
  // never thinner than minThickness: a 6 cm skin of a 0.52 m ball holds ~4 pi r^2 t = 0.2 m3
  const thick = new TargetVolume(sphere(0.5), { voxel: 0.02, shell: 0.04 }).hollow(0.1 * solid, 0.06);
  assert.ok(thick.volume > 0.15, `a 6 cm shell at least (${thick.volume.toFixed(3)} m3)`);
  // the outermost layer is kept, the centre is gone
  assert.equal(t.inside[at(c[0])], 0, 'centre emptied');
  assert.equal(t.inside[at(edge)], 1, 'surface kept');
});

test('a placed target matches its settings, and the fit streams placements', () => {
  const mesh = sphere(1);
  const volume = 0.004; // m^3 of parts
  const place = { volume, size: 2, voxel: 0.02, shell: 0.06, yaw: 0.3, floor: 0.5, minThickness: 0.04 };
  const a = TargetVolume.place(mesh, place);
  const b = TargetVolume.place(mesh, place);
  assert.equal(a.count, b.count, 'same settings, same target');
  const lowest = Math.min(...Array.from({ length: a.vertices.length / 3 }, (_, i) => a.vertices[i * 3 + 1]));
  assert.ok(Math.abs(lowest - (0.5 + 0.03)) < 0.01, `stands on the floor (${lowest})`);
  assert.ok(a.volume >= volume * 0.9 && a.volume < 2 * volume * 1.2, `hollowed to about the parts (${a.volume})`);
  const skin = a.surface();
  assert.ok(skin.length > 0 && skin.length / 3 <= a.count);
  const parts = Array.from({ length: 6 }, () => partStencil(new BoxShape([0.04, 0.03, 0.02]), { x: 0, y: 0, z: 0 }, 0.02));
  const fit = new ShapeFit(a, { orientations: 8, minGain: 0 });
  const seen = [];
  const it = fit.run(parts);
  let r = it.next();
  while (!r.done) {
    if (r.value.placement) seen.push(r.value.placement.index);
    r = it.next();
  }
  assert.deepEqual(seen, r.value.placements.map((p) => p.index));
});
