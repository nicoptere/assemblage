import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, RigidBody, BoxShape, SphereShape, PlaneShape } from '../src/index.js';

/** Largest distance from any sample to its nearest sample among the first k. */
function coverage(s, k) {
  let worst = 0;
  for (let i = 0; i < s.length; i += 3) {
    let near = Infinity;
    for (let j = 0; j < k * 3; j += 3) near = Math.min(near, Math.hypot(s[i] - s[j], s[i + 1] - s[j + 1], s[i + 2] - s[j + 2]));
    worst = Math.max(worst, near);
  }
  return worst;
}

test('samples are in farthest-point order, so every prefix is evenly spread', () => {
  const shape = new SphereShape(0.1, { sampleCount: 400 });
  const s = shape.samples;
  const radii = [25, 50, 100, 200, 400].map((k) => coverage(s, k));
  for (let i = 1; i < radii.length; i++) assert.ok(radii[i] < radii[i - 1], `coverage shrinks with more samples: ${radii.map((r) => (r * 1000).toFixed(1))} mm`);
  // ideal spacing on a sphere of radius r with k points is about r * sqrt(4 pi / k)
  assert.ok(radii[1] < 1.5 * 0.1 * Math.sqrt((4 * Math.PI) / 50), `50 samples cover the sphere evenly (${(radii[1] * 1000).toFixed(1)} mm)`);
  assert.equal(shape.samplesFor(0.25).length / 3, 100);
  assert.equal(shape.samplesFor(0).length / 3, 4, 'never fewer than MIN_SAMPLES');
});

test('a world at lower sample precision collides with fewer samples, and still rests', () => {
  const world = new World({ samplePrecision: 0.25 });
  world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static' }));
  const box = world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1], { samplesPerEdge: 8 }), position: [0, 0.2, 0] }));
  const full = box.shape.sampleCount;
  assert.equal(box.localSamples.length / 3, Math.ceil(full / 4));
  for (let t = 0; t < 2; t += 1 / 60) world.step(1 / 60);
  assert.ok(Math.abs(box.position.y - 0.1) < 0.005, `rests on the ground (y ${box.position.y.toFixed(4)})`);
  world.samplePrecision = 1;
  assert.equal(box.localSamples.length / 3, full, 'back to every sample');
  assert.ok(!box.sleeping, 'changing precision wakes bodies');
});

test('a fast part stops at a wall instead of sinking in', () => {
  for (const speed of [5, 15, 40]) {
    const world = new World({ gravity: [0, 0, 0] });
    world.addBody(new RigidBody({ shape: new PlaneShape([-1, 0, 0], -1), type: 'static' })); // wall at x = 1
    const box = world.addBody(new RigidBody({ shape: new BoxShape([0.05, 0.05, 0.05]), position: [0, 0, 0], velocity: [speed, 0, 0] }));
    let deepest = 0;
    for (let t = 0; t < 0.5; t += 1 / 60) {
      world.step(1 / 60);
      deepest = Math.max(deepest, box.position.x + 0.05 - 1);
    }
    assert.ok(deepest < 0.005, `${speed} m/s: sank ${(deepest * 1000).toFixed(1)} mm into the wall`);
  }
});

test('a contact records how fast its bodies were closing when the step began', () => {
  const world = new World();
  world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static' }));
  const box = world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1]), position: [0, 0.6, 0] }));
  let fastest = 0, speedBefore = 0;
  for (let t = 0; t < 1; t += 1 / 60) {
    const v = -box.velocity.y;
    world.step(1 / 60);
    for (const c of world.contacts) if (c.approach > fastest) { fastest = c.approach; speedBefore = v; }
  }
  // free fall from 0.5 m: about 3.1 m/s at impact
  assert.ok(Math.abs(fastest - speedBefore) < 0.05 && fastest > 2.8, `impact at ${fastest.toFixed(2)} m/s (body fell at ${speedBefore.toFixed(2)})`);
  world.step(1 / 60);
  assert.ok(Math.max(...world.contacts.map((c) => c.approach)) < 0.3, 'resting contacts close slowly');
});
