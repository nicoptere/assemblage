import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Vec3, Quat, Mat3, World, RigidBody, Joint, PointConstraint,
  SphereShape, BoxShape, PlaneShape, SdfGridShape,
} from '../src/index.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (±${eps})`);

function groundWorld(opts) {
  const world = new World(opts);
  world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static', friction: 0.8 }));
  return world;
}

function run(world, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) world.step(dt);
}

/** Bakes an analytic shape into a grid, like the preprocessor does for meshes. */
function gridFrom(shape, voxel, pad = 3) {
  const { min, max } = shape.localAabb;
  const origin = [min.x - pad * voxel, min.y - pad * voxel, min.z - pad * voxel];
  const dims = [max.x - min.x, max.y - min.y, max.z - min.z].map((e) => Math.ceil(e / voxel) + 1 + 2 * pad);
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  let n = 0;
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++)
      for (let i = 0; i < dims[0]; i++)
        data[n++] = shape.distance(origin[0] + i * voxel, origin[1] + j * voxel, origin[2] + k * voxel);
  return new SdfGridShape({ origin, dims, voxel, data, samples: shape.samples });
}

test('quaternion rotation and rotation vector round-trip', () => {
  const q = new Quat().setFromAxisAngle(new Vec3(0, 0, 1), Math.PI / 2);
  const v = new Vec3(1, 0, 0).applyQuat(q);
  near(v.x, 0, 1e-9, 'x');
  near(v.y, 1, 1e-9, 'y');
  v.applyQuatInverse(q);
  near(v.x, 1, 1e-9, 'inverse');
  const r = q.toRotationVector(new Vec3());
  near(r.z, Math.PI / 2, 1e-9, 'rotation vector');
  const m = new Mat3([2, 1, 0, 1, 3, 0, 0, 0, 4]);
  const out = m.clone().invert().mulVec(m.mulVec(new Vec3(1, 2, 3), new Vec3()), new Vec3());
  near(out.y, 2, 1e-9, 'inverse matrix');
});

test('grid shape reproduces an analytic sphere: distance and mass', () => {
  const sphere = new SphereShape(0.1);
  const grid = gridFrom(sphere, 0.005);
  near(grid.distance(0.13, 0, 0), 0.03, 0.002, 'outside distance');
  near(grid.distance(0, 0.05, 0), -0.05, 0.002, 'inside distance');
  const g = new Vec3();
  grid.distance(0.07, 0.07, 0, g);
  near(g.x, Math.SQRT1_2, 0.05, 'gradient');
  const a = sphere.massProperties(1000);
  const b = grid.massProperties(1000);
  near(b.mass, a.mass, a.mass * 0.03, 'mass');
  near(b.inertia.e[0], a.inertia.e[0], a.inertia.e[0] * 0.06, 'inertia');
  near(b.com.length(), 0, 1e-4, 'centre of mass');
});

test('a box comes to rest on the ground', () => {
  const world = groundWorld();
  const box = world.addBody(new RigidBody({ shape: new BoxShape([0.2, 0.1, 0.15]), position: [0, 0.5, 0] }));
  run(world, 3);
  near(box.position.y, 0.1, 0.006, 'rest height');
  assert.ok(box.velocity.length() < 0.02, `resting speed ${box.velocity.length()}`);
});

test('a stack of three grid boxes stays upright', () => {
  const world = groundWorld();
  const shape = gridFrom(new BoxShape([0.15, 0.1, 0.15]), 0.01);
  const boxes = [0, 1, 2].map((i) => world.addBody(new RigidBody({ shape, position: [0.01 * i, 0.105 + i * 0.205, 0] })));
  run(world, 4);
  near(boxes[2].position.y, 0.5, 0.02, 'top box height');
  near(boxes[2].position.x, 0.02, 0.02, 'top box drift');
});

test('ball joint pendulum swings with the expected period', () => {
  const world = new World({ gravity: [0, -9.81, 0] });
  const anchor = world.addBody(new RigidBody({ shape: new SphereShape(0.01), type: 'static', position: [0, 1, 0] }));
  const bob = world.addBody(new RigidBody({ shape: new SphereShape(0.02), position: [0.5, 1, 0] }));
  world.addJoint(new Joint(anchor, bob, { kind: 'ball', anchor: [0, 1, 0], angularCompliance: Infinity }));
  // time the first crossing of the bottom (quarter period for small damping; large amplitude ~ +18%)
  let t = 0;
  while (bob.position.x > 0 && t < 3) {
    world.step(1 / 120);
    t += 1 / 120;
  }
  const quarter = (Math.PI / 2) * Math.sqrt(0.5 / 9.81);
  near(t, quarter * 1.18, 0.05, 'quarter period');
  near(bob.position.distanceTo(new Vec3(0, 1, 0)), 0.5, 1e-3, 'rod length');
});

test('a welded cantilever holds its pose, a weak weld breaks', () => {
  for (const strength of [Infinity, 5]) {
    const world = new World();
    const wall = world.addBody(new RigidBody({ shape: new BoxShape([0.05, 0.05, 0.05]), type: 'static' }));
    const beam = world.addBody(new RigidBody({ shape: new BoxShape([0.25, 0.03, 0.03]), position: [0.3, 0, 0] }));
    const joint = world.addJoint(new Joint(wall, beam, { kind: 'fixed', anchor: [0.05, 0, 0], breakForce: strength, breakTorque: strength }));
    let broke = false;
    world.on('jointBreak', () => { broke = true; });
    run(world, 1);
    if (strength === Infinity) {
      assert.equal(broke, false);
      near(beam.position.y, 0, 0.002, 'cantilever sag');
      assert.ok(joint.torque > 0, 'torque readout');
    } else {
      assert.equal(broke, true, 'weak weld should break');
      assert.ok(beam.position.y < -0.5, 'beam falls');
    }
  }
});

test('drag constraint pulls a body to the target', () => {
  const world = groundWorld();
  const box = world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1]), position: [0, 0.1, 0] }));
  const drag = world.addConstraint(new PointConstraint(box, [0, 0.2, 0], { compliance: 1e-5 }));
  drag.target.set(0.3, 0.6, 0);
  run(world, 2);
  near(drag.worldPoint(new Vec3()).distanceTo(drag.target), 0, 0.02, 'grab point at target');
});

test('raycast finds the nearest surface by sphere tracing', () => {
  const world = groundWorld();
  world.addBody(new RigidBody({ shape: gridFrom(new SphereShape(0.2), 0.01), position: [0, 1, 0], type: 'static' }));
  const hit = world.raycast([0, 1, 2], [0, 0, -1]);
  assert.ok(hit, 'hit');
  near(hit.point.z, 0.2, 0.005, 'hit point');
  near(hit.normal.z, 1, 0.05, 'hit normal');
  const down = world.raycast([3, 1, 0], [0, -1, 0]);
  near(down.point.y, 0, 1e-3, 'ground hit');
});

test('a fast ball does not tunnel through a thin wall', () => {
  const world = new World({ gravity: [0, 0, 0] });
  world.addBody(new RigidBody({ shape: gridFrom(new BoxShape([0.01, 0.5, 0.5]), 0.004), type: 'static' }));
  const ball = world.addBody(new RigidBody({ shape: new SphereShape(0.03), position: [-0.5, 0, 0], velocity: [40, 0, 0], density: 7800, ccd: true }));
  run(world, 0.3);
  assert.ok(ball.position.x < 0, `ball went through: x = ${ball.position.x}`);
});

test('connected gives the bodies joined to one, through dynamic bodies only', () => {
  const world = groundWorld();
  const ground = world.bodies[0];
  const box = (x) => world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1]), position: [x, 0.5, 0] }));
  const [a, b, c, d] = [box(0), box(0.3), box(0.6), box(0.9)];
  world.addJoint(new Joint(a, b, { kind: 'fixed', anchor: [0.15, 0.5, 0] }));
  world.addJoint(new Joint(b, c, { kind: 'fixed', anchor: [0.45, 0.5, 0] }));
  world.addJoint(new Joint(c, ground, { kind: 'fixed', anchor: [0.6, 0.5, 0] })); // an anchor
  world.addJoint(new Joint(d, ground, { kind: 'fixed', anchor: [0.9, 0.5, 0] })); // links nothing
  assert.deepEqual(new Set(world.connected(a)), new Set([a, b, c]));
  assert.deepEqual(world.connected(d), [d]);
});

test('a weld to a static body follows its moved target (setTargetB): position and turn', () => {
  const world = groundWorld();
  const ground = world.bodies[0];
  const box = world.addBody(new RigidBody({ shape: new BoxShape([0.1, 0.1, 0.1]), position: [0, 1, 0] }));
  const joint = world.addJoint(new Joint(box, ground, { kind: 'fixed', anchor: [0, 1, 0] }));
  const turn = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 0.6);
  for (let i = 1; i <= 30; i++) {
    joint.setTargetB(new Vec3(0.01 * i, 1 + 0.005 * i, 0), turn);
    world.step(1 / 60);
  }
  run(world, 0.2);
  near(box.position.x, 0.3, 0.005, 'x');
  near(box.position.y, 1.15, 0.005, 'y');
  const q = box.quaternion;
  near(Math.abs(q.x * turn.x + q.y * turn.y + q.z * turn.z + q.w * turn.w), 1, 1e-4, 'turned');
  assert.ok(joint.moved, 'flagged for the GPU engine');
});
