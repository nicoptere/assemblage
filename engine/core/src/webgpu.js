// @sdfphys/core/webgpu: everything in @sdfphys/core plus the WebGPU engine (browsers with WebGPU).
//   const backend = new WebGPUBackend();  await backend.init();
//   const world = new World({ backend });  ...  await world.stepAsync(dt);   (queues the step, never waits)
export * from './index.js';
export { WebGPUBackend } from './webgpu/WebGPUBackend.js';
export { GpuProfiler } from './webgpu/GpuProfiler.js';
