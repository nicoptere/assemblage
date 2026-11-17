/**
 * Gather pass: one invocation per (job, sample). A job is one direction of a candidate pair:
 * the samples of S moved into D's shape space (p = M s + t, s shape-local) and tested against
 * D's distance function, exactly as Narrowphase._gather does on the CPU (same box test, same
 * distance functions, same margin). Samples within the margin are appended as (job, sample).
 * Grid values are int16, two per u32 word.
 */
export const GATHER_WGSL = /* wgsl */ `
struct Job {
  m0: vec4f,          // row 0 of M, t.x in w
  m1: vec4f,
  m2: vec4f,
  margin: f32,
  shape: u32,         // D's shape record
  sampleStart: u32,   // S's first sample
  count: u32,         // S's samples in use
}

struct Shape {
  kind: u32, nx: u32, ny: u32, nz: u32,   // kind: 0 grid, 1 plane, 2 sphere, 3 box
  ox: f32, oy: f32, oz: f32, voxel: f32,
  inv: f32, scale: f32, dataOffset: u32, sampleStart: u32,
  p: vec4f,           // plane: normal, offset | sphere: radius | box: half extents
  boxMin: vec4f,      // w > 0: bounded (test the box first)
  boxMax: vec4f,
}

struct Params { total: u32, capacity: u32, groupsX: u32, jobCount: u32 }

@group(0) @binding(0) var<storage, read> jobs: array<Job>;
@group(0) @binding(1) var<storage, read> jobStart: array<u32>;
@group(0) @binding(2) var<storage, read> shapes: array<Shape>;
@group(0) @binding(3) var<storage, read> samples: array<f32>;
@group(0) @binding(4) var<storage, read> sdf: array<u32>;
@group(0) @binding(5) var<storage, read_write> found: array<vec2u>;
@group(0) @binding(6) var<storage, read_write> counter: atomic<u32>;
@group(0) @binding(7) var<uniform> params: Params;

fn value(r: Shape, n: u32) -> f32 {
  let at = r.dataOffset + n;
  let w = sdf[at >> 1u];
  let top = select(w << 16u, w, (at & 1u) == 1u); // the wanted half in the top bits
  return f32(bitcast<i32>(top) >> 16u);           // arithmetic shift: sign-extended
}

fn gridDistance(r: Shape, p: vec3f) -> f32 {
  let u = (p.x - r.ox) * r.inv;
  let v = (p.y - r.oy) * r.inv;
  let w = (p.z - r.oz) * r.inv;
  let cu = clamp(u, 0.0, f32(r.nx - 1u) - 1e-4);
  let cv = clamp(v, 0.0, f32(r.ny - 1u) - 1e-4);
  let cw = clamp(w, 0.0, f32(r.nz - 1u) - 1e-4);
  let outside = length(vec3f(u - cu, v - cv, w - cw)) * r.voxel;
  let i = min(u32(cu), r.nx - 2u);
  let j = min(u32(cv), r.ny - 2u);
  let k = min(u32(cw), r.nz - 2u);
  let fx = cu - f32(i);
  let fy = cv - f32(j);
  let fz = cw - f32(k);
  let sx = r.nx;
  let sxy = r.nx * r.ny;
  let base = i + sx * j + sxy * k;
  let c00 = mix(value(r, base), value(r, base + 1u), fx);
  let c10 = mix(value(r, base + sx), value(r, base + sx + 1u), fx);
  let c01 = mix(value(r, base + sxy), value(r, base + sxy + 1u), fx);
  let c11 = mix(value(r, base + sxy + sx), value(r, base + sxy + sx + 1u), fx);
  return mix(mix(c00, c10, fy), mix(c01, c11, fy), fz) * r.scale + outside;
}

fn boxDistance(h: vec3f, p: vec3f) -> f32 {
  let q = abs(p) - h;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn distanceTo(r: Shape, p: vec3f) -> f32 {
  switch r.kind {
    case 0u: { return gridDistance(r, p); }
    case 1u: { return dot(r.p.xyz, p) - r.p.w; }
    case 2u: { return length(p) - r.p.x; }
    default: { return boxDistance(r.p.xyz, p); }
  }
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = (wid.y * params.groupsX + wid.x) * 64u + lid;
  if (g >= params.total) { return; }
  // the job holding test g: largest j with jobStart[j] <= g
  var lo = 0u;
  var hi = params.jobCount;
  loop {
    if (hi - lo <= 1u) { break; }
    let mid = (lo + hi) / 2u;
    if (jobStart[mid] <= g) { lo = mid; } else { hi = mid; }
  }
  let job = jobs[lo];
  let k = g - jobStart[lo];
  let si = (job.sampleStart + k) * 3u;
  let s = vec3f(samples[si], samples[si + 1u], samples[si + 2u]);
  let p = vec3f(dot(job.m0.xyz, s) + job.m0.w, dot(job.m1.xyz, s) + job.m1.w, dot(job.m2.xyz, s) + job.m2.w);
  let r = shapes[job.shape];
  let m = job.margin;
  if (r.boxMin.w > 0.0 && (any(p < r.boxMin.xyz - vec3f(m)) || any(p > r.boxMax.xyz + vec3f(m)))) { return; }
  if (distanceTo(r, p) >= m) { return; }
  let slot = atomicAdd(&counter, 1u);
  if (slot < params.capacity) { found[slot] = vec2u(lo, k); }
}
`;
