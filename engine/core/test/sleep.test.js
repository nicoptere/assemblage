import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { World, RigidBody, Joint, BoxShape, SphereShape, PlaneShape, Vec3 } from '../src/index.js';
import { loadAssemblyFromDisk } from './helpers.js';

function groundWorld(opts) {
  const world = new World(opts);
  world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static', friction: 0.8 }));
  return world;
}

function run(world, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) world.step(dt);
}

const box = (y, size = 0.2) => new RigidBody({ shape: new BoxShape([size / 2, size / 2, size / 2]), position: [0, y, 0] });

test('a resting box falls asleep, keeps its place, and an impulse wakes it', () => {
  const world = groundWorld();
  const b = world.addBody(box(0.15));
  run(world, 2);
  assert.ok(b.sleeping, 'asleep after coming to rest');
  assert.equal(world.stats.sleeping, 1);
  const y = b.position.y;
  run(world, 1);
  assert.equal(b.position.y, y, 'a sleeper does not move');
  b.applyImpulse([0, 0, 8], b.position.clone().add(new Vec3(0, 0.05, 0)));
  assert.ok(!b.sleeping, 'impulse wakes it');
  run(world, 0.2);
  assert.ok(Math.abs(b.position.z) > 0.01, 'and it moves');
});

test('sleeping can be turned off', () => {
  const world = groundWorld({ allowSleep: false });
  const b = world.addBody(box(0.15));
  run(world, 2);
  assert.ok(!b.sleeping);
  world.allowSleep = true;
  run(world, 1);
  assert.ok(b.sleeping, 'sleeps once allowed');
  world.allowSleep = false;
  assert.ok(!b.sleeping, 'turning it off wakes everything');
});

test('a ball hitting a sleeping box wakes it', () => {
  const world = groundWorld();
  const b = world.addBody(box(0.15));
  run(world, 2);
  assert.ok(b.sleeping);
  world.addBody(new RigidBody({ shape: new SphereShape(0.04), position: [-1, 0.12, 0], velocity: [8, 0, 0], density: 7800, ccd: true }));
  run(world, 0.5);
  assert.ok(b.position.x > 0.02, `pushed along: x ${b.position.x.toFixed(3)}`);
});

test('removing the support wakes what rests on it', () => {
  const world = groundWorld();
  const bottom = world.addBody(box(0.101));
  const top = world.addBody(box(0.302));
  run(world, 2);
  assert.ok(bottom.sleeping && top.sleeping, 'stack asleep');
  const y = top.position.y;
  world.removeBody(bottom);
  assert.ok(!top.sleeping, 'woken by the removal');
  run(world, 1);
  assert.ok(top.position.y < y - 0.15, 'and falls');
});

test('jointed bodies sleep and wake as one island', () => {
  const world = groundWorld();
  const a = world.addBody(box(0.101));
  const b = world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1]), position: [0.2, 0.101, 0] }));
  const weld = world.addJoint(new Joint(a, b, { kind: 'fixed', anchor: [0.1, 0.101, 0] }));
  run(world, 2);
  assert.ok(a.sleeping && b.sleeping);
  assert.deepEqual(new Set(a.island), new Set([a, b]));
  b.wake();
  assert.ok(!a.sleeping, 'waking one wakes its island');
  run(world, 2);
  assert.ok(a.sleeping, 'asleep again');
  world.removeJoint(weld);
  assert.ok(!a.sleeping && !b.sleeping, 'removing a joint wakes both sides');
});

const DIR = process.env.ASSEMBLY_DIR ?? fileURLToPath(new URL('../../app/public/models/mecha_01', import.meta.url));
const assembly = loadAssemblyFromDisk(DIR);

test('a standing mecha falls asleep and costs almost nothing, a broken joint wakes it', { skip: !assembly }, () => {
  const world = groundWorld();
  const mecha = assembly.spawn(world, { position: [0, 0.005 - assembly.bounds.min[1], 0] });
  const timed = (n) => {
    let ms = 0;
    for (let i = 0; i < n; i++) {
      world.step(1 / 60);
      ms += world.stats.stepMs;
    }
    return ms / n;
  };
  run(world, 0.3);
  const awakeMs = timed(30);
  run(world, 1.2);
  assert.ok(mecha.bodies.every((b) => b.sleeping), 'every part asleep');
  const before = mecha.centreOfMass(new Vec3());
  const asleepMs = timed(30);
  console.log(`  step ${awakeMs.toFixed(2)} ms awake, ${asleepMs.toFixed(2)} ms asleep`);
  assert.ok(asleepMs < 0.25 * awakeMs, 'sleeping step is cheap');
  world.removeJoint(mecha.joints[0]);
  assert.ok(mecha.bodies.every((b) => !b.sleeping), 'removing a joint wakes the whole model');
  run(world, 1);
  const after = mecha.centreOfMass(new Vec3());
  assert.ok(Math.abs(after.y - before.y) < 0.03, 'and it still stands after waking');
});

test('a body creeping into a sleeper leaves it asleep; one moving fast wakes it', () => {
  const world = groundWorld();
  const sleeper = world.addBody(box(0.101));
  run(world, 2);
  assert.ok(sleeper.sleeping);
  // a box sliding slowly into its side (under wakeSpeed): the sleeper stays an immovable obstacle
  const slow = world.addBody(new RigidBody({ shape: new BoxShape([0.05, 0.05, 0.05]), position: [-0.4, 0.051, 0], velocity: [0.3, 0, 0], friction: 0 }));
  run(world, 1.5);
  assert.ok(sleeper.sleeping, 'a slow push does not wake it');
  assert.ok(slow.position.x < -0.149, `the slow box stopped at its side: x ${slow.position.x.toFixed(3)}`);
  world.addBody(new RigidBody({ shape: new SphereShape(0.03), position: [0.6, 0.1, 0], velocity: [-4, 0, 0], density: 7800, ccd: true }));
  run(world, 0.4);
  assert.ok(!sleeper.sleeping || sleeper.position.x < -0.005, 'a fast one does');
});

test('rest damping stops a slow creep; sliding faster than restSpeed is left alone', () => {
  const slide = (restDamping, speed) => {
    const world = new World({ restDamping, allowSleep: false });
    world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static', friction: 0 }));
    const b = world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1]), position: [0, 0.1, 0], velocity: [speed, 0, 0], friction: 0 }));
    run(world, 1);
    return b.velocity.x;
  };
  assert.ok(slide(5, 0.1) < 0.02, `a 10 cm/s creep is all but stopped in a second (${slide(5, 0.1).toFixed(3)} m/s)`);
  assert.ok(slide(0, 0.1) > 0.09, 'without rest damping it goes on');
  assert.ok(slide(5, 1) > 0.95, 'a 1 m/s slide keeps its speed');
});

test('past maxAwake, the calmest islands are put to sleep at once', () => {
  const world = groundWorld({ maxAwake: 3, sleepTime: 100 }); // nothing would sleep on its own
  const boxes = [];
  for (let i = 0; i < 8; i++) boxes.push(world.addBody(new RigidBody({ shape: new BoxShape([0.05, 0.05, 0.05]), position: [0.3 * i, 0.051, 0] })));
  run(world, 0.5);
  const awake = boxes.filter((b) => !b.sleeping).length;
  assert.ok(awake <= 3, `at most 3 awake (${awake})`);
  const fast = world.addBody(new RigidBody({ shape: new BoxShape([0.05, 0.05, 0.05]), position: [0, 1, 2], velocity: [0, 3, 0] }));
  run(world, 0.1);
  assert.ok(!fast.sleeping, 'a body still moving is never put to sleep');
});
