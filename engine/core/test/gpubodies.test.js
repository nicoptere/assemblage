import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, RigidBody, BoxShape, PlaneShape, Vec3 } from '../src/index.js';
import { GpuBodies } from '../src/webgpu/GpuBodies.js';
import { COMMAND, WORDS, FLAG } from '../src/webgpu/kernels/lib.wgsl.js';

/** GpuBodies against stub buffers: what it would send to the GPU, without a GPU. */
function setup() {
  const sent = new Map();
  const buffers = { ensure: () => ({}), write: (name, data, offset = 0) => sent.set(name, { data: data.buffer ? data : new Uint8Array(data), offset }) };
  let shapes = 0;
  const slots = new Map();
  const shapeStore = { slot: (s) => slots.get(s) ?? slots.set(s, { index: shapes++, sampleStart: 0 }).get(s), upload() {} };
  const gpu = new GpuBodies(null, buffers, shapeStore);
  const world = new World();
  world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static' }));
  const box = world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1]), position: [0, 1, 0], velocity: [1, 0, 0] }));
  return { gpu, world, box, sent };
}

/** The commands of the last sync: [{ slot, kind, pos, vel }]. */
function commands(sent, n) {
  const { data } = sent.get('commands');
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + n * WORDS.command * 4);
  const u = new Uint32Array(buf);
  const f = new Float32Array(buf);
  return Array.from({ length: n }, (_, i) => {
    const o = i * WORDS.command;
    return { slot: u[o], kind: u[o + 1], pos: [...f.subarray(o + 4, o + 7)], vel: [...f.subarray(o + 12, o + 15)] };
  });
}

/** A read-back of step `step` in which the GPU moved the box to y and gave it velocity v. */
function readBack(gpu, world, step, y, v) {
  const data = new Float32Array(gpu.count * WORDS.state);
  const s = gpu.slotOf.get(world.bodies[1]) * WORDS.state;
  data.set([0, y, 0, 0, 0, 0, 0, 1, v, 0, 0, 0, 0, 0, 0, 0], s);
  gpu.applyState(data, gpu.count, step, step + 1, world.contactMargin);
}

test('a new body is sent whole (teleport) with its props', () => {
  const { gpu, world, box, sent } = setup();
  const n = gpu.sync(world, 1);
  assert.equal(n, 2);
  const c = commands(sent, n).find((x) => x.slot === gpu.slotOf.get(box));
  assert.equal(c.kind, COMMAND.teleport);
  assert.deepEqual(c.pos.map((x) => +x.toFixed(4)), [0, 1, 0]);
  assert.deepEqual(c.vel, [1, 0, 0]);
  assert.equal(gpu.pu[gpu.slotOf.get(box) * WORDS.props + 1] & FLAG.dynamic, FLAG.dynamic);
  assert.equal(gpu.sync(world, 2), 0, 'nothing changed: nothing sent');
});

test('a velocity change is sent as a difference, a stop as an absolute zero', () => {
  const { gpu, world, box, sent } = setup();
  gpu.sync(world, 1);
  box.velocity.y += 3; // a blast
  let [c] = commands(sent, gpu.sync(world, 2));
  assert.equal(c.kind, COMMAND.addVelocity);
  assert.deepEqual(c.vel, [0, 3, 0]);
  box.velocity.set(0, 0, 0);
  box.angularVelocity.set(0, 0, 0);
  [c] = commands(sent, gpu.sync(world, 3));
  assert.equal(c.kind, COMMAND.setVelocity);
  assert.deepEqual(c.vel, [0, 0, 0]);
});

test('read-backs update the bodies but keep what the app changed meanwhile', () => {
  const { gpu, world, box, sent } = setup();
  gpu.sync(world, 1);
  readBack(gpu, world, 1, 0.8, 2);
  assert.equal(+box.position.y.toFixed(4), 0.8);
  assert.equal(box.velocity.x, 2);
  box.velocity.x += 5; // the app pushes it, then an older read-back lands before the next step
  readBack(gpu, world, 1, 0.7, 2.5);
  assert.equal(box.velocity.x, 2.5, 'the mirror shows the GPU state');
  const [c] = commands(sent, gpu.sync(world, 2));
  assert.equal(c.kind, COMMAND.addVelocity);
  assert.deepEqual(c.vel, [5, 0, 0], 'the push still goes to the GPU');
});

test('a teleport wins over read-backs taken before it', () => {
  const { gpu, world, box } = setup();
  gpu.sync(world, 1);
  box.setOrigin(new Vec3(3, 2, 1));
  gpu.sync(world, 5);
  readBack(gpu, world, 4, 0.5, 0); // the GPU state of step 4 predates the teleport
  assert.equal(+box.position.x.toFixed(4), 3);
  readBack(gpu, world, 5, 1.9, 0);
  assert.equal(+box.position.y.toFixed(4), 1.9);
});

test('slots are freed and reused; jointed pairs become sorted slot keys', () => {
  const { gpu, world, box } = setup();
  const other = world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1]), position: [0.5, 1, 0] }));
  world.filter.ignore(box, other);
  gpu.sync(world, 1);
  assert.equal(gpu.excludedCount, 1);
  const slot = gpu.slotOf.get(box);
  world.removeBody(box);
  gpu.sync(world, 2);
  assert.equal(gpu.pu[slot * WORDS.props + 1], 0, 'inactive');
  assert.equal(gpu.excludedCount, 0);
  const again = world.addBody(new RigidBody({ shape: new BoxShape([0.2, 0.1, 0.1]), position: [0, 2, 0] }));
  gpu.sync(world, 3);
  assert.equal(gpu.slotOf.get(again), slot);
});
