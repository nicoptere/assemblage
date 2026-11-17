// Splits the mechs into parts again and bakes them, in place (public/models/<name>/), then shrinks them for the web
// (optimize-models.mjs), and prints a recap: parts before and after, traps cut, joints, mass, whether each stands.
//   npm run resegment-models -w app -- [options] [mecha_01 …]          (default: every model of index.json)
//     --angle 90            creases sharper than this split a semantic part (Segmenter, stage 1)
//     --trap-size 0.25      a part at least this long (share of the mech's size)...
//     --trap-radius 0.035   ...that can hold a ball this big (share of the mech's size) inside its hull...
//     --trap-wrap 0.33      ...and surrounds it this much (share of directions) is cut (TrapSplitter, stage 4)...
//     --trap-pieces 6       ...into at most this many pieces
//     --no-traps            leave traps whole
//     --max-parts N         merge the smallest parts until there are no more than N (default: no limit)
//     --dry                 segment and count only: nothing baked, nothing written
//     --no-check            skip the standing test
//     --source <folder>     the source mechs, one GLB per mech (<name>.glb), one node per semantic part
//                           (default: models/ at the root of the repository)
// Each semantic part is split along its creases (the semantic parts as `groups`: no new part spans two of them), the
// parts baked as the browser bakes uploads (bakeAssembly: closed by caps, distance grids at the old voxel size, samples,
// a fixed joint wherever two touch), and the mech's rig kept:
//   parts      role, chain, level and side of the semantic part they come from (named part_###_<ROLE>; `semantic`: its name)
//   joints     between two pieces of one semantic part: welded where they touch; between two semantic parts that
//              were welded: where their pieces touch; that had an articulation (ball): that joint as it was, between
//              the piece of each nearest its anchor; that had no joint: none
// The rig (the semantic parts and their joints, from the manifest the hybrid pipeline's bake wrote) is kept in
// app/rigs/<name>.json, taken from the model's manifest the first time, so that it can be run again and again.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshTopology, Segmenter, bakeAssembly, TRAP_DEFAULTS } from '@sdfphys/core/segment';
import { Assembly, World, RigidBody, PlaneShape, Vec3 } from '@sdfphys/core';

const app = fileURLToPath(new URL('../', import.meta.url));
const models = `${app}public/models/`;
const rigs = `${app}rigs/`;
const { values: cli, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    angle: { type: 'string', default: '90' },
    'trap-size': { type: 'string', default: String(TRAP_DEFAULTS.size) },
    'trap-radius': { type: 'string', default: String(TRAP_DEFAULTS.radius) },
    'trap-wrap': { type: 'string', default: String(TRAP_DEFAULTS.wrap) },
    'trap-pieces': { type: 'string', default: String(TRAP_DEFAULTS.pieces) },
    'no-traps': { type: 'boolean', default: false },
    'max-parts': { type: 'string' },
    dry: { type: 'boolean', default: false },
    'no-check': { type: 'boolean', default: false },
    source: { type: 'string', default: fileURLToPath(new URL('../../../models/', import.meta.url)) },
  },
});
const settings = {
  angle: Number(cli.angle),
  maxParts: cli['max-parts'] ? Number(cli['max-parts']) : Infinity,
  traps: cli['no-traps'] ? false : { size: Number(cli['trap-size']), radius: Number(cli['trap-radius']), wrap: Number(cli['trap-wrap']), pieces: Number(cli['trap-pieces']) },
};
const names = positionals.length ? positionals : JSON.parse(await readFile(`${models}index.json`, 'utf8'));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const rows = [];
for (const name of names) rows.push(await rebuild(name));
recap(rows);

/** One mech: segmented, baked, its rig mapped onto the new parts, written and shrunk, then stood up. Returns its recap row. */
async function rebuild(name) {
  const t0 = Date.now();
  const dir = `${models}${name}/`;
  const old = JSON.parse(await readFile(`${dir}manifest.json`, 'utf8'));
  const rig = await rigOf(name, old);
  const src = await readSource(`${cli.source.replace(/\/$/, '')}/${name}.glb`, rig);
  const { labels, count, stats } = new Segmenter(src.topo, { ...settings, groups: src.groups }).run();
  const groupOfPart = new Int32Array(count);
  labels.forEach((l, f) => { if (l >= 0) groupOfPart[l] = src.groups[f]; });
  const row = { name, semantic: rig.parts.length, before: old.parts.length, parts: count, traps: stats.traps, largest: stats.largest };
  console.log(`${name}: ${rig.parts.length} semantic parts -> ${count} parts${trapNote(stats.traps)}`);
  if (cli.dry) return { ...row, seconds: (Date.now() - t0) / 1000 };

  const baked = bakeAssembly(src.topo, labels, count, { name, voxel: rig.voxel / src.topo.size });
  const manifest = baked.manifest;
  manifest.parts.forEach((p, i) => {
    const { name: semantic, role, chain, level, side } = rig.parts[groupOfPart[i]];
    Object.assign(p, { name: `part_${String(i).padStart(3, '0')}_${role}`, role, chain, level, side, semantic });
  });
  manifest.joints = mapJoints(rig, manifest, baked.buffer, groupOfPart);
  Object.assign(manifest, { format: old.format, version: old.version, unit: old.unit, scale: old.scale, data: 'shapes.bin', render: old.render });

  writeRenderModel(src, labels, count, manifest);
  await io.write(`${dir}model.glb`, src.doc);
  await writeFile(`${dir}shapes.bin`, Buffer.from(baked.buffer));
  await writeFile(`${dir}manifest.json`, JSON.stringify(manifest));
  execFileSync('node', [`${app}scripts/optimize-models.mjs`, name], { stdio: 'ignore' });

  const assembly = new Assembly(manifest, baked.buffer);
  const kinds = manifest.joints.reduce((m, j) => ({ ...m, [j.kind]: (m[j.kind] ?? 0) + 1 }), {});
  const mass = assembly.parts.reduce((m, p) => m + p.shape.massProperties(1000).mass, 0);
  const stand = cli['no-check'] ? null : standing(assembly);
  return { ...row, welds: kinds.fixed ?? 0, balls: kinds.ball ?? 0, mass, stand, seconds: (Date.now() - t0) / 1000 };
}

/** The rig of the semantic parts (names, roles, joints, voxel): app/rigs/<name>.json, made from the model's manifest the first time. */
async function rigOf(name, manifest) {
  const file = `${rigs}${name}.json`;
  if (!(await access(file).then(() => true, () => false))) {
    await mkdir(rigs, { recursive: true });
    const parts = manifest.parts.map(({ name: n, role, chain, level, side }) => ({ name: n, role, chain, level, side }));
    await writeFile(file, `${JSON.stringify({ name, voxel: manifest.parts[0].sdf.voxel, parts, joints: manifest.joints }, null, 1)}\n`);
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

/** The source GLB as one mesh: its topology, the semantic part (group) of every face, and where each face came from. */
async function readSource(file, rig) {
  const doc = await io.read(file);
  const groupOf = new Map(rig.parts.map((p, i) => [p.name, i]));
  const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh());
  const prims = []; // { group, prim }
  for (const node of nodes) {
    if (!groupOf.has(node.getName())) throw new Error(`${file}: ${node.getName()} is not in the rig`);
    for (const prim of node.getMesh().listPrimitives()) prims.push({ group: groupOf.get(node.getName()), prim });
  }
  const P = [], I = [], groups = [], faceOf = []; // faceOf: [prim index, triangle]
  prims.forEach(({ group, prim }, k) => {
    const pos = prim.getAttribute('POSITION');
    const base = P.length / 3;
    for (let i = 0; i < pos.getCount(); i++) P.push(...pos.getElement(i, []));
    const idx = prim.getIndices();
    for (let t = 0; t < idx.getCount() / 3; t++) {
      for (let c = 0; c < 3; c++) I.push(base + idx.getScalar(3 * t + c));
      groups.push(group);
      faceOf.push([k, t]);
    }
  });
  const topo = new MeshTopology(Float32Array.from(P), Uint32Array.from(I));
  return { doc, nodes, prims, faceOf, topo, groups: Int32Array.from(groups) };
}

/**
 * The rig's joints between the new parts: the welds the bake found inside a semantic part and between welded
 * semantic parts, and each articulation between the pieces nearest its anchor on either side. a < b, normals from a to b.
 */
function mapJoints(rig, manifest, buffer, groupOfPart) {
  const assembly = new Assembly({ ...manifest, joints: [] }, buffer);
  const nearest = (group, [x, y, z]) => {
    let best = -1, bestD = Infinity;
    assembly.parts.forEach((p, i) => {
      if (groupOfPart[i] !== group) return;
      const d = Math.abs(p.shape.distance(x, y, z));
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };
  const between = new Map(); // "A,B" (semantic parts, A < B) -> the rig's joints between them
  for (const j of rig.joints) {
    const key = `${Math.min(j.a, j.b)},${Math.max(j.a, j.b)}`;
    if (!between.has(key)) between.set(key, []);
    between.get(key).push(j);
  }
  const joints = [];
  const welded = new Set(); // "A,B" with a weld kept between their pieces
  for (const j of manifest.joints) {
    const A = groupOfPart[j.a], B = groupOfPart[j.b];
    if (A === B) { joints.push(j); continue; }
    const key = `${Math.min(A, B)},${Math.max(A, B)}`;
    if (!(between.get(key) ?? []).some((r) => r.kind === 'fixed')) continue; // an articulation, or no joint
    joints.push(j);
    welded.add(key);
  }
  for (const [key, list] of between) {
    for (const r of list) {
      if (r.kind === 'fixed' && welded.has(key)) continue;
      const a = nearest(r.a, r.anchor), b = nearest(r.b, r.anchor);
      if (a >= 0 && b >= 0) joints.push({ ...r, a, b });
    }
  }
  return joints.map((j) => (j.a < j.b ? j : { ...j, a: j.b, b: j.a, normal: j.normal.map((v) => -v) }));
}

/** The render model, in the source document: one node per part, its triangles out of the source primitive, every attribute kept. */
function writeRenderModel({ doc, nodes, prims, faceOf }, labels, count, manifest) {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const buffer = doc.getRoot().listBuffers()[0];
  const byPart = Array.from({ length: count }, () => []);
  labels.forEach((l, f) => { if (l >= 0) byPart[l].push(faceOf[f]); });
  byPart.forEach((faces, i) => {
    const { prim } = prims[faces[0][0]];
    const idx = prim.getIndices();
    const remap = new Map();
    const tris = [];
    for (const [, t] of faces) {
      for (let c = 0; c < 3; c++) {
        const v = idx.getScalar(3 * t + c);
        if (!remap.has(v)) remap.set(v, remap.size);
        tris.push(remap.get(v));
      }
    }
    const part = doc.createPrimitive().setMaterial(prim.getMaterial()).setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(tris)).setBuffer(buffer));
    for (const semantic of prim.listSemantics()) {
      const a = prim.getAttribute(semantic);
      const size = a.getElementSize();
      const data = new Float32Array(remap.size * size);
      for (const [v, n] of remap) data.set(a.getElement(v, []), n * size);
      part.setAttribute(semantic, doc.createAccessor().setType(a.getType()).setArray(data).setBuffer(buffer));
    }
    const partName = manifest.parts[i].name;
    scene.addChild(doc.createNode(partName).setMesh(doc.createMesh(partName).addPrimitive(part)));
  });
  for (const n of nodes) {
    n.getMesh().listPrimitives().forEach((p) => p.dispose());
    n.getMesh().dispose();
    n.dispose();
  }
}

/**
 * The mech dropped 5 mm onto the ground and left 4 s with its default rig, in a world set up as the app's (10 substeps,
 * sample precision 0.2, awake cap 100): how far its centre of mass sank, joints broken.
 */
function standing(assembly) {
  const world = new World({ substeps: 10, samplePrecision: 0.2, maxAwake: 100 });
  world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static', friction: 0.9 }));
  const mech = assembly.spawn(world, { position: [0, 0.005 - assembly.bounds.min[1], 0] });
  const start = mech.centreOfMass(new Vec3());
  for (let s = 0; s < 240; s++) world.step(1 / 60);
  const end = mech.centreOfMass(new Vec3());
  return { drop: start.y - end.y, broken: mech.joints.filter((j) => j.removed).length };
}

function trapNote(traps) {
  if (!traps) return '';
  if (!traps.traps) return ', no traps';
  return `, ${traps.traps} trap${traps.traps > 1 ? 's' : ''} cut ${traps.cuts} time${traps.cuts > 1 ? 's' : ''}${traps.left ? ` (${traps.left} left)` : ''}`;
}

/** The batch's table, totals, and the command that makes it again. */
function recap(list) {
  const columns = [
    ['model', (r) => r.name],
    ['semantic', (r) => r.semantic],
    ['parts', (r) => `${r.before} -> ${r.parts}`],
    ['traps cut', (r) => (r.traps ? `${r.traps.traps}${r.traps.left ? ` (${r.traps.left} left)` : ''}` : '-')],
    ['largest', (r) => `${(100 * r.largest).toFixed(1)}%`],
  ];
  if (!cli.dry) {
    columns.push(
      ['joints (weld + ball)', (r) => `${r.welds} + ${r.balls}`],
      ['mass', (r) => `${r.mass.toFixed(1)} kg`],
    );
    if (!cli['no-check']) columns.push(['standing (4 s)', (r) => (r.stand.drop < 0.05 ? `settles ${(1000 * r.stand.drop).toFixed(0)} mm` : `falls ${(1000 * r.stand.drop).toFixed(0)} mm`) + (r.stand.broken ? `, ${r.stand.broken} broken` : '')]);
  }
  columns.push(['time', (r) => `${r.seconds.toFixed(1)} s`]);
  const cells = list.map((r) => columns.map(([, f]) => String(f(r))));
  const widths = columns.map(([h], c) => Math.max(h.length, ...cells.map((row) => row[c].length)));
  const line = (row) => `| ${row.map((v, c) => v.padEnd(widths[c])).join(' | ')} |`;
  console.log(`\n${line(columns.map(([h]) => h))}\n|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const row of cells) console.log(line(row));
  const sum = (f) => list.reduce((s, r) => s + f(r), 0);
  console.log(`\n${list.length} models: ${sum((r) => r.before)} -> ${sum((r) => r.parts)} parts${cli.dry ? ' (dry run: nothing written)' : ''}`);
  const flags = [`--angle ${settings.angle}`];
  if (settings.traps) flags.push(`--trap-size ${settings.traps.size}`, `--trap-radius ${settings.traps.radius}`, `--trap-wrap ${settings.traps.wrap}`, `--trap-pieces ${settings.traps.pieces}`);
  else flags.push('--no-traps');
  if (Number.isFinite(settings.maxParts)) flags.push(`--max-parts ${settings.maxParts}`);
  console.log(`\nagain:  npm run resegment-models -w app -- ${flags.join(' ')}${positionals.length ? ` ${positionals.join(' ')}` : ''}`);
  console.log('try:    --dry to only count the parts (nothing written), --no-traps, other angles or trap sizes; name models to do only those');
  console.log('undo:   git checkout -- app/public/models');
}
