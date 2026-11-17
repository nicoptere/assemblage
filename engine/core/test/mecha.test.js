import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { World, RigidBody, PlaneShape, SphereShape, Vec3, Quat } from '../src/index.js';
import { loadAssemblyFromDisk } from './helpers.js';

const DIR = process.env.ASSEMBLY_DIR ?? fileURLToPath(new URL('../../app/public/models/mecha_01', import.meta.url));
const assembly = loadAssemblyFromDisk(DIR);

function scene(options = {}) {
  const world = new World();
  world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static', friction: 0.9 }));
  const lift = 0.005 - assembly.bounds.min[1];
  const mecha = assembly.spawn(world, { position: [0, lift, 0], ...options });
  return { world, mecha };
}

function simulate(world, seconds, dt = 1 / 60) {
  let worst = 0;
  for (let t = 0; t < seconds; t += dt) {
    world.step(dt);
    worst = Math.max(worst, world.stats.stepMs);
  }
  return worst;
}

/** Lowest surface sample of any body (AABBs include grid padding, samples are the true surface). */
function lowestPoint(bodies) {
  const p = new Vec3();
  let low = Infinity;
  for (const b of bodies) {
    const s = b.localSamples;
    for (let i = 0; i < s.length; i += 3) low = Math.min(low, p.set(s[i], s[i + 1], s[i + 2]).applyQuat(b.quaternion).add(b.position).y);
  }
  return low;
}

test('mecha_01 stands on its legs', { skip: !assembly && `no baked assembly in ${DIR}` }, () => {
  const { world, mecha } = scene();
  const mass = mecha.bodies.reduce((m, b) => m + b.mass, 0);
  const start = mecha.centreOfMass(new Vec3());
  const worst = simulate(world, 4);
  const end = mecha.centreOfMass(new Vec3());
  const speed = Math.max(...mecha.bodies.map((b) => b.velocity.length()));
  console.log(`  mass ${mass.toFixed(1)} kg, ${mecha.bodies.length} parts, ${mecha.joints.length} joints; ` +
    `COM drop ${((start.y - end.y) * 1000).toFixed(1)} mm, drift ${(Math.hypot(end.x - start.x, end.z - start.z) * 1000).toFixed(1)} mm; ` +
    `max speed ${speed.toFixed(3)} m/s; worst step ${worst.toFixed(1)} ms; broken ${mecha.joints.filter((j) => j.broken).length}`);
  assert.equal(mecha.joints.filter((j) => j.broken).length, 0, 'no joint breaks while standing');
  assert.ok(start.y - end.y < 0.03, 'centre of mass stays up');
  assert.ok(speed < 0.05, 'comes to rest');
  assert.ok(lowestPoint(mecha.bodies) > -0.008, 'nothing sinks into the ground');
});

test('mecha_01 collapses like a ragdoll with limp articulations', { skip: !assembly }, () => {
  const { world, mecha } = scene({ articulationCompliance: Infinity, breakable: false });
  const start = mecha.centreOfMass(new Vec3());
  const balls = mecha.joints.filter((j) => j.kind !== 'fixed');
  const relative = (j) => new Quat().multiplyQuats(j.bodyA.quaternion.clone().conjugate(), j.bodyB.quaternion);
  const rest = balls.map(relative);
  simulate(world, 4);
  const end = mecha.centreOfMass(new Vec3());
  // how far each articulation turned: the limbs go slack (one leg's articulations close a loop and lock it, so the
  // body leans on that one and sinks only a few cm)
  const turned = balls.filter((j, i) => {
    const q = relative(j), r = rest[i];
    return 2 * Math.acos(Math.min(1, Math.abs(q.x * r.x + q.y * r.y + q.z * r.z + q.w * r.w))) > (20 * Math.PI) / 180;
  }).length;
  console.log(`  limp: COM drop ${((start.y - end.y) * 1000).toFixed(1)} mm, ${turned} of ${balls.length} articulations turned over 20°, lowest ${(lowestPoint(mecha.bodies) * 1000).toFixed(1)} mm`);
  assert.ok(start.y - end.y > 0.02, 'sinks');
  assert.ok(turned >= balls.length / 3, 'the limbs go slack');
  assert.ok(lowestPoint(mecha.bodies) > -0.01, 'pile stays above ground');
});

test('a heavy ball knocks parts off', { skip: !assembly }, () => {
  const { world, mecha } = scene();
  simulate(world, 1);
  const target = mecha.bodies.reduce((a, b) => (b.position.y > a.position.y ? b : a));
  const from = new Vec3(0, target.position.y, 2);
  const dir = new Vec3().subVectors(target.position, from).normalize();
  const ball = world.addBody(new RigidBody({ shape: new SphereShape(0.05), position: from, velocity: dir.scale(30), density: 7800, ccd: true }));
  let breaks = 0;
  world.on('jointBreak', () => breaks++);
  simulate(world, 1.5);
  console.log(`  ball ${ball.mass.toFixed(1)} kg @ 30 m/s: ${breaks} joints broke`);
  assert.ok(breaks > 0, 'impact breaks joints');
  assert.ok(lowestPoint(mecha.bodies) > -0.01, 'debris stays above ground');
});
