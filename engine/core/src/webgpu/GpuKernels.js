import { STRUCTS, BUFFER_TYPES, LIBS } from './kernels/lib.wgsl.js';

const INDEX_STRIDE = 256; // dynamic uniform offsets are 256-byte aligned

/**
 * Compute kernels from small specs: { uses: { buffer: 'read' | 'read_write' | 'uniform' }, lib: [...],
 * fns, code, indexed, constants, optional }. Each kernel is its own shader module declaring only
 * the buffers it uses (and those of its libraries), bound in that order from binding 1; binding 0
 * is the Params uniform. An `indexed` kernel also reads `idx` (group 1), a slot of the index
 * uniform chosen per dispatch by dynamic offset: the substep, or a joint colour's range.
 * `constants`: values of the shader's override constants, functions of the device limits. An
 * `optional` kernel needing more storage buffers than the device allows is left out (see has).
 */
export class GpuKernels {
  constructor(device, buffers, specs) {
    this.device = device;
    this.buffers = buffers;
    this.indexLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } }],
    });
    this.kernels = new Map();
    for (const [name, spec] of Object.entries(specs)) {
      const kernel = this._compile(name, spec);
      if (kernel) this.kernels.set(name, kernel);
    }
    this._indexGroup = null;
  }

  static source(name, spec) {
    const libs = ['math', ...(spec.lib ?? [])];
    const uses = {};
    for (const l of libs) Object.assign(uses, LIBS[l].uses);
    Object.assign(uses, spec.uses);
    const names = Object.keys(uses);
    const decls = names.map((b, i) => {
      const type = BUFFER_TYPES[b];
      if (!type) throw new Error(`kernel ${name}: unknown buffer '${b}'`);
      const access = uses[b];
      const t = typeof type === 'string' ? type : type[access];
      return access === 'uniform' ? `@group(0) @binding(${i + 1}) var<uniform> ${b}: ${t};` : `@group(0) @binding(${i + 1}) var<storage, ${access}> ${b}: ${t};`;
    });
    const code = [
      STRUCTS,
      '@group(0) @binding(0) var<uniform> params: Params;',
      spec.indexed ? '@group(1) @binding(0) var<uniform> idx: Index;' : '',
      ...decls,
      ...libs.map((l) => LIBS[l].code),
      spec.fns ?? '',
      spec.code,
    ].join('\n');
    return { code, names, uses };
  }

  _compile(name, spec) {
    const { device } = this;
    const { code, names, uses } = GpuKernels.source(name, spec);
    const limit = device.limits.maxStorageBuffersPerShaderStage;
    const storage = names.filter((b) => uses[b] !== 'uniform').length;
    if (storage > limit) {
      if (spec.optional) return null;
      throw new Error(`kernel ${name}: ${storage} storage buffers, this GPU allows ${limit}`);
    }
    const layout = device.createBindGroupLayout({
      label: name,
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ...names.map((b, i) => ({ binding: i + 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: { read: 'read-only-storage', read_write: 'storage', uniform: 'uniform' }[uses[b]] } })),
      ],
    });
    const module = device.createShaderModule({ label: name, code });
    const pipeline = device.createComputePipeline({
      label: name,
      layout: device.createPipelineLayout({ bindGroupLayouts: spec.indexed ? [layout, this.indexLayout] : [layout] }),
      compute: { module, entryPoint: 'main', constants: Object.fromEntries(Object.entries(spec.constants ?? {}).map(([k, f]) => [k, f(device.limits)])) },
    });
    return { name, names, layout, module, pipeline, indexed: !!spec.indexed, group: null, version: -1 };
  }

  /** Whether kernel `name` exists on this device (optional kernels may not). */
  has(name) {
    return this.kernels.has(name);
  }

  /** Shader compilation errors of every kernel, as "kernel line:col message" strings. */
  async errors() {
    const out = [];
    for (const k of this.kernels.values()) {
      const info = await k.module.getCompilationInfo();
      for (const m of info.messages) if (m.type === 'error') out.push(`${k.name} ${m.lineNum}:${m.linePos} ${m.message}`);
    }
    return out;
  }

  _group(k) {
    const { buffers } = this;
    if (k.version === buffers.version) return k.group;
    k.group = this.device.createBindGroup({
      label: k.name,
      layout: k.layout,
      entries: [{ binding: 0, resource: { buffer: buffers.get('params') } }, ...k.names.map((b, i) => ({ binding: i + 1, resource: { buffer: buffers.get(b) } }))],
    });
    k.version = buffers.version;
    return k.group;
  }

  _bind(pass, name, index) {
    const k = this.kernels.get(name);
    if (!k) throw new Error(`no kernel '${name}'`);
    pass.setPipeline(k.pipeline);
    pass.setBindGroup(0, this._group(k));
    if (k.indexed) {
      if (!this._indexGroup || this._indexVersion !== this.buffers.version) {
        this._indexGroup = this.device.createBindGroup({
          layout: this.indexLayout,
          entries: [{ binding: 0, resource: { buffer: this.buffers.get('index'), size: 16 } }],
        });
        this._indexVersion = this.buffers.version;
      }
      pass.setBindGroup(1, this._indexGroup, [index * INDEX_STRIDE]);
    }
  }

  /** Dispatches `groups` workgroups (split in rows of 65535), or an explicit [x, y]. */
  dispatch(pass, name, groups, index = 0) {
    if (Array.isArray(groups) ? groups[0] * groups[1] === 0 : groups === 0) return;
    this._bind(pass, name, index);
    if (Array.isArray(groups)) pass.dispatchWorkgroups(groups[0], groups[1]);
    else pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
  }

  /** Dispatches with sizes the GPU wrote into `args` at word `offset`. */
  dispatchIndirect(pass, name, offset, index = 0) {
    this._bind(pass, name, index);
    pass.dispatchWorkgroupsIndirect(this.buffers.get('args'), offset * 4);
  }

  static get INDEX_STRIDE() {
    return INDEX_STRIDE;
  }
}
