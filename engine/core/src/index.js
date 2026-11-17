// @sdfphys/core: the model (math, shapes, bodies, joints, assemblies, world) and the CPU backend.
// Runs anywhere, Node included. The WebGPU backend is in '@sdfphys/core/webgpu', fitting in '@sdfphys/core/fit'.

export { Vec3 } from './math/Vec3.js';
export { Quat } from './math/Quat.js';
export { Mat3 } from './math/Mat3.js';
export { Aabb } from './math/Aabb.js';

export { Shape, MassAccumulator } from './shapes/Shape.js';
export { SdfGridShape } from './shapes/SdfGridShape.js';
export { SphereShape, BoxShape, PlaneShape } from './shapes/primitives.js';

export { RigidBody } from './body/RigidBody.js';
export { Joint } from './constraints/Joint.js';
export { PointConstraint } from './constraints/PointConstraint.js';

export { World } from './world/World.js';
export { Backend } from './world/Backend.js';
export { CollisionFilter } from './world/CollisionFilter.js';
export { raycast } from './world/raycast.js';
export { Emitter } from './world/Emitter.js';

export { CpuBackend } from './cpu/CpuBackend.js';
export { Broadphase } from './cpu/Broadphase.js';
export { Narrowphase } from './cpu/Narrowphase.js';
export { Contact } from './cpu/Contact.js';
export { SampleTree } from './cpu/SampleTree.js';

export { Assembly, AssemblyInstance, RIG_DEFAULTS } from './assembly/Assembly.js';
