import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, RigidBody, PlaneShape, BoxShape } from '../src/index.js';

test('a kinematic wall moved by its velocity pushes what it meets, and stops where it is put', () => {
  const world = new World();
  world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static', friction: 0.5 }));
  const box = world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1]), position: [0, 0.1, 0] }));
  const wall = world.addBody(new RigidBody({ shape: new BoxShape([0.5, 1, 1]), type: 'kinematic', position: [-1.1, 1, 0] }));
  for (let i = 0; i < 30; i++) world.step(1 / 60); // the box settles
  let fastest = 0;
  wall.velocity.set(0.6, 0, 0); // 1 s: its face from x = -0.6 to 0
  for (let i = 0; i < 60; i++) {
    world.step(1 / 60);
    fastest = Math.max(fastest, box.velocity.length());
  }
  wall.velocity.set(0, 0, 0);
  for (let i = 0; i < 30; i++) world.step(1 / 60);
  assert.ok(Math.abs(wall.position.x + 0.5) < 1e-6, `the wall's face at 0 (${(wall.position.x + 0.5).toFixed(4)})`);
  assert.ok(box.position.x > 0.09, `pushed ahead of it (${box.position.x.toFixed(3)})`);
  assert.ok(fastest < 1.5, `without being flung (${fastest.toFixed(2)} m/s)`);
});
