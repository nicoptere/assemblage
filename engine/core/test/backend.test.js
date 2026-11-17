import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, RigidBody, BoxShape, PlaneShape, CpuBackend } from '../src/index.js';

/** A pile of boxes dropped on the ground. */
function scene(backend) {
  const world = new World(backend ? { backend } : {});
  world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static', friction: 0.8 }));
  for (let i = 0; i < 6; i++) {
    world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.05, 0.08]), position: [0.05 * (i % 3), 0.15 + 0.12 * i, 0.03 * i], quaternion: [0.1 * i, 0, 0, 1] }));
  }
  return world;
}
const poses = (world) => world.bodies.map((b) => [b.position.x, b.position.y, b.position.z, b.quaternion.w]);

/** Steps like the CPU backend, but only asynchronously, as a GPU backend does. */
class AsyncCpu extends CpuBackend {
  get async() { return true; }
  async stepAsync(world, dt) {
    await null;
    CpuBackend.prototype.step.call(this, world, dt);
  }
  step() { throw new Error('async only'); }
}

test('switching backend between steps keeps the state and the result', async () => {
  const a = scene();
  for (let i = 0; i < 90; i++) a.step(1 / 60);
  const b = scene();
  for (let i = 0; i < 30; i++) b.step(1 / 60);
  await b.setBackend(new CpuBackend());
  for (let i = 0; i < 30; i++) b.step(1 / 60);
  await b.setBackend(new AsyncCpu());
  assert.throws(() => b.step(1 / 60), /asynchronously/);
  for (let i = 0; i < 30; i++) await b.stepAsync(1 / 60);
  assert.equal(b.stats.backend, 'cpu');
  assert.deepEqual(poses(b), poses(a));
});

test('one asynchronous step at a time', async () => {
  const w = scene(new AsyncCpu());
  const first = w.stepAsync(1 / 60);
  const second = w.stepAsync(1 / 60);
  const swap = w.setBackend(new CpuBackend());
  await assert.rejects(second, /already running/);
  await assert.rejects(swap, /step is running/);
  await first;
  assert.equal(w.frame, 1);
});
