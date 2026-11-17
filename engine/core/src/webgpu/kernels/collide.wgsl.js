/**
 * Collision kernels, once per step (see WebGPUBackend for the order):
 *   commands  CPU state writes: teleports, velocity changes and settings (see GpuBodies)
 *   bounds    swept world boxes (as RigidBody.updateBounds), per-step counters and per-body words reset
 *   pairs     every finite pair (i < j): filter (motion, groups, excluded keys), box overlap, sleepers to
 *             wake; appends the pair with its margin, the two sample frames and a contact cell size
 *   planes    every finite body against every half-space (with its sweep shortfall and how far it
 *             can be shoved, as the CPU broadphase)
 *   plan      indirect dispatch sizes from the pair count
 *   gather    one workgroup per pair direction: each sample of S in D's shape space, box test,
 *             distance; a sample within the margin competes for one of the pair's SLOTS, chosen by
 *             hashing its cell (in b's shape space): the deepest sample of each slot wins (atomicMin
 *             on distance bits | side | sample). This replaces the CPU's farthest-point reduction:
 *             contacts stay spread over the patch, the deepest point of each part of it kept.
 *   build     one thread per pair slot: the winning sample becomes a contact (arms, normal, material)
 *             and counts towards both bodies' contact lists
 *   plan2     dispatch sizes from the contact count
 *   scan      contact list offsets per body (prefix sum, one workgroup)
 *   scatter   contact list entries (contact * 2 + side), for the per-body averaging of the solver
 */

const PAIR_FNS = /* wgsl */ `
fn canCollide(pa: Props, pb: Props) -> bool {
  if (!(has(pa.flags, F_DYNAMIC) || has(pb.flags, F_DYNAMIC))) { return false; }
  if (!(moving(pa) || moving(pb))) { return false; }
  return (pa.group & pb.mask) != 0u && (pb.group & pa.mask) != 0u;
}

fn excluded(i: u32, j: u32) -> bool {
  let key = (min(i, j) << 16u) | max(i, j);
  var lo = 0u;
  var hi = params.excludedCount;
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi) / 2u;
    let k = excludedKeys[mid];
    if (k == key) { return true; }
    if (k < key) { lo = mid + 1u; } else { hi = mid; }
  }
  return false;
}

fn frameRows(M: mat3x3f, t: vec3f) -> array<vec4f, 3> {
  return array<vec4f, 3>(vec4f(M[0].x, M[1].x, M[2].x, t.x), vec4f(M[0].y, M[1].y, M[2].y, t.y), vec4f(M[0].z, M[1].z, M[2].z, t.z));
}

fn pushedOf(i: u32) -> f32 { return bitcast<f32>(atomicLoad(&atom[aPushed(i)])); }

fn appendPair(i: u32, j: u32, pa: Props, pb: Props, half: bool) {
  let idx = atomicAdd(&atom[C_PAIRS], 1u);
  if (idx >= params.pairCap) {
    atomicOr(&atom[C_OVERFLOW], 1u);
    return;
  }
  let sa = state[i];
  let sb = state[j];
  let speed = length(sa.vel - sb.vel) + length(sa.ang) * pa.radius + select(length(sb.ang) * pb.radius, 0.0, half);
  let sweep = speed * params.dt;
  var margin = params.margin;
  if (half) {
    margin += sweep + pushedOf(i) + pushedOf(j);
  } else if (has(pa.flags | pb.flags, F_CCD)) {
    margin += sweep;
  } else {
    margin += min(sweep, params.maxSweep);
  }
  let Ra = rotation(sa.quat);
  let Rb = rotation(sb.quat);
  let M0 = transpose(Rb) * Ra;
  let t0 = transpose(Rb) * (sa.pos - sb.pos) + pb.com - M0 * pa.com;
  let M1 = transpose(Ra) * Rb;
  let t1 = transpose(Ra) * (sb.pos - sa.pos) + pa.com - M1 * pb.com;
  let m = frameRows(M0, t0);
  let n = frameRows(M1, t1);
  let small = select(min(pa.radius, pb.radius), pa.radius, half);
  pairs[idx] = Pair(i, j, margin, clamp(0.4 * small, 0.008, 0.25), m[0], m[1], m[2], n[0], n[1], n[2]);
  for (var k = 0u; k < SLOTS; k++) { atomicStore(&slots[idx * SLOTS + k], EMPTY); }
}
`;

const PAIR_USES = { props: 'read', state: 'read', bounds: 'read', atom: 'read_write', pairs: 'read_write', slots: 'read_write', excludedKeys: 'read' };

/** The sample frame of a pair direction: side 0 moves a's samples into b's shape space, side 1 b's into a's. */
const FRAME_FNS = /* wgsl */ `
fn moveSample(pr: Pair, side: u32, s: vec3f) -> vec3f {
  if (side == 0u) { return vec3f(dot(pr.m0.xyz, s) + pr.m0.w, dot(pr.m1.xyz, s) + pr.m1.w, dot(pr.m2.xyz, s) + pr.m2.w); }
  return vec3f(dot(pr.n0.xyz, s) + pr.n0.w, dot(pr.n1.xyz, s) + pr.n1.w, dot(pr.n2.xyz, s) + pr.n2.w);
}
`;

const ARGS_FNS = /* wgsl */ `
fn setArgs(o: u32, groups: u32) {
  args[o] = min(groups, ROW);
  args[o + 1u] = (groups + ROW - 1u) / ROW;
  args[o + 2u] = 1u;
}
`;

export const ARGS = { gather: 0, build: 4, contacts: 8, words: 12 }; // word offsets of the indirect dispatch sizes

export const COLLIDE = {
  commands: {
    uses: { commands: 'read', state: 'read_write', prev: 'read_write' },
    code: /* wgsl */ `
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = index(wid, lid);
  if (i >= params.commandCount) { return; }
  let c = commands[i];
  let b = c.body;
  if (c.kind == 0u) {
    state[b] = State(c.pos, 0.0, c.quat, c.vel, 0.0, c.ang, 0.0);
    prev[b] = Prev(c.pos, 0.0, c.quat, c.vel, 0.0, c.ang, 0.0);
  } else if (c.kind == 1u) {
    state[b].vel += c.vel;
    state[b].ang += c.ang;
  } else {
    state[b].vel = c.vel;
    state[b].ang = c.ang;
  }
}`,
  },

  bounds: {
    uses: { props: 'read', state: 'read', bounds: 'read_write', atom: 'read_write' },
    code: /* wgsl */ `
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = index(wid, lid);
  if (i == 0u) { for (var k = 0u; k < 4u; k++) { atomicStore(&atom[k], 0u); } }
  if (i >= params.bodyCount) { return; }
  atomicStore(&atom[aPushed(i)], 0u);
  atomicStore(&atom[aWake(i)], 0u);
  atomicStore(&atom[aCount(i)], 0u);
  let p = props[i];
  if (!has(p.flags, F_ACTIVE) || has(p.flags, F_INFINITE)) { return; }
  let s = state[i];
  let R = rotation(s.quat);
  let centre = s.pos + R * (0.5 * (p.boxMin + p.boxMax) - p.com);
  let ext = mat3x3f(abs(R[0]), abs(R[1]), abs(R[2])) * (0.5 * (p.boxMax - p.boxMin));
  var lo = centre - ext;
  var hi = centre + ext;
  var sweep = 0.0;
  var shortfall = 0.0;
  if (has(p.flags, F_STATIC)) {
    lo -= vec3f(params.margin);
    hi += vec3f(params.margin);
  } else {
    let limit = select(params.maxSweep, 1e30, has(p.flags, F_CCD));
    var t = s.vel * params.dt;
    let l = length(t);
    let spin = length(s.ang) * p.radius * params.dt;
    if (l > limit) { t *= limit / l; }
    lo += min(t, vec3f(0.0));
    hi += max(t, vec3f(0.0));
    let e = params.margin + min(spin, limit);
    lo -= vec3f(e);
    hi += vec3f(e);
    sweep = l + spin;
    shortfall = max(0.0, l - limit) + max(0.0, spin - limit);
  }
  bounds[i] = Bounds(lo, sweep, hi, shortfall);
}`,
  },

  pairs: {
    uses: PAIR_USES,
    fns: PAIR_FNS,
    code: /* wgsl */ `
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let j = g.y;
  if (j <= i || j >= params.bodyCount) { return; }
  let pa = props[i];
  let pb = props[j];
  if (!has(pa.flags & pb.flags, F_ACTIVE) || has(pa.flags | pb.flags, F_INFINITE)) { return; }
  if (!canCollide(pa, pb)) { return; }
  let ba = bounds[i];
  let bb = bounds[j];
  if (any(ba.lo > bb.hi) || any(bb.lo > ba.hi)) { return; }
  if (excluded(i, j)) { return; }
  // a sleeper touched by a body that really moves (or a moving kinematic) must wake
  let sla = has(pa.flags, F_SLEEPING);
  if (sla != has(pb.flags, F_SLEEPING)) {
    let oi = select(i, j, sla); // the awake one
    let oflags = props[oi].flags;
    let os = state[oi];
    if (has(oflags, F_MOVED) || (has(oflags, F_KINEMATIC) && length(os.vel) + length(os.ang) > 0.0)) {
      atomicStore(&atom[aWake(select(j, i, sla))], 1u);
    }
  }
  atomicMax(&atom[aPushed(i)], bitcast<u32>(bb.sweep));
  atomicMax(&atom[aPushed(j)], bitcast<u32>(ba.sweep));
  appendPair(i, j, pa, pb, false);
}`,
  },

  planes: {
    uses: { ...PAIR_USES, shapes: 'read' },
    fns: PAIR_FNS,
    code: /* wgsl */ `
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = index(wid, lid);
  if (i >= params.bodyCount) { return; }
  let pa = props[i];
  if (!has(pa.flags, F_ACTIVE) || has(pa.flags, F_INFINITE)) { return; }
  let ba = bounds[i];
  let reach = params.margin + ba.shortfall + pushedOf(i);
  for (var k = 0u; k < params.planeCount; k++) {
    let j = params.planes[k / 4u][k % 4u];
    let pb = props[j];
    if (!has(pb.flags, F_ACTIVE) || !canCollide(pa, pb)) { continue; }
    let plane = shapes[pb.shape].p; // half-spaces sit at the identity pose, as on the CPU
    let corner = select(ba.hi, ba.lo, plane.xyz > vec3f(0.0));
    if (dot(plane.xyz, corner) - plane.w > reach) { continue; }
    if (excluded(i, j)) { continue; }
    appendPair(i, j, pa, pb, true);
  }
}`,
  },

  plan: {
    uses: { atom: 'read', args: 'read_write' },
    fns: ARGS_FNS,
    code: /* wgsl */ `
@compute @workgroup_size(1) fn main() {
  let n = min(atom[C_PAIRS], params.pairCap);
  setArgs(${ARGS.gather}u, n * 2u);
  setArgs(${ARGS.build}u, (n * SLOTS + 63u) / 64u);
}`,
  },

  gather: {
    uses: { pairs: 'read', props: 'read', slots: 'read_write', atom: 'read' },
    lib: ['shape'],
    fns: FRAME_FNS,
    code: /* wgsl */ `
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let job = wid.x + wid.y * ROW;
  let n = min(atom[C_PAIRS], params.pairCap);
  if (job >= 2u * n) { return; }
  let pi = job >> 1u;
  let side = job & 1u;
  let pr = pairs[pi];
  let S = select(pr.a, pr.b, side == 1u);
  let D = select(pr.b, pr.a, side == 1u);
  let ps = props[S];
  let count = min(ps.sampleCount, 8192u);
  let r = shapes[props[D].shape];
  for (var k = lid; k < count; k += 64u) {
    let s = sample(ps.sampleStart + k);
    let p = moveSample(pr, side, s);
    if (outsideBox(r, p, pr.margin)) { continue; }
    let d = distanceTo(r, p);
    if (d >= pr.margin) { continue; }
    let c = vec3i(floor(select(p, s, side == 1u) / pr.cell)); // in b's shape space for both sides
    let h = ((u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (u32(c.z) * 83492791u)) % SLOTS;
    atomicMin(&slots[pi * SLOTS + h], (orderable(d) & 0xffffc000u) | (side << 13u) | k);
  }
}`,
  },

  build: {
    uses: { pairs: 'read', slots: 'read', props: 'read', contacts: 'read_write', atom: 'read_write' },
    lib: ['shape'],
    fns: FRAME_FNS,
    code: /* wgsl */ `
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let t = index(wid, lid);
  let n = min(atomicLoad(&atom[C_PAIRS]), params.pairCap);
  if (t >= n * SLOTS) { return; }
  let key = slots[t];
  if (key == EMPTY) { return; }
  let pr = pairs[t / SLOTS];
  let side = (key >> 13u) & 1u;
  let S = select(pr.a, pr.b, side == 1u);
  let D = select(pr.b, pr.a, side == 1u);
  let ps = props[S];
  let pd = props[D];
  let s = sample(ps.sampleStart + (key & 0x1fffu));
  let p = moveSample(pr, side, s);
  let f = field(shapes[pd.shape], p, true);
  let c = atomicAdd(&atom[C_CONTACTS], 1u);
  if (c >= params.contactCap) {
    atomicOr(&atom[C_OVERFLOW], 2u);
    return;
  }
  contacts[c] = Contact(S, D, sqrt(ps.friction * pd.friction), max(ps.restitution, pd.restitution),
    s - ps.com, max(ps.rolling, pd.rolling), p - f.w * f.xyz - pd.com, -1.0, f.xyz, 0.0, 0.0, 0.0, 0.0, 0.0);
  if (ps.invMass > 0.0) { atomicAdd(&atom[aCount(S)], 1u); }
  if (pd.invMass > 0.0) { atomicAdd(&atom[aCount(D)], 1u); }
}`,
  },

  plan2: {
    uses: { atom: 'read', args: 'read_write' },
    fns: ARGS_FNS,
    code: /* wgsl */ `
@compute @workgroup_size(1) fn main() {
  setArgs(${ARGS.contacts}u, (min(atom[C_CONTACTS], params.contactCap) + 63u) / 64u);
}`,
  },

  scan: {
    uses: { atom: 'read_write' },
    code: /* wgsl */ `
var<workgroup> partial: array<u32, 256>;

@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) lid: u32) {
  let n = params.bodyCount;
  let chunk = (n + 255u) / 256u;
  let lo = min(lid * chunk, n);
  let hi = min(lo + chunk, n);
  var sum = 0u;
  for (var i = lo; i < hi; i++) { sum += atomicLoad(&atom[aCount(i)]); }
  partial[lid] = sum;
  workgroupBarrier();
  for (var o = 1u; o < 256u; o <<= 1u) {
    var v = 0u;
    if (lid >= o) { v = partial[lid - o]; }
    workgroupBarrier();
    partial[lid] += v;
    workgroupBarrier();
  }
  var run = 0u;
  if (lid > 0u) { run = partial[lid - 1u]; }
  for (var i = lo; i < hi; i++) {
    let c = atomicLoad(&atom[aCount(i)]);
    atomicStore(&atom[aStart(i)], run);
    atomicStore(&atom[aCursor(i)], run);
    run += c;
  }
  if (lid == 255u) { atomicStore(&atom[aStart(n)], partial[255]); }
}`,
  },

  scatter: {
    uses: { contacts: 'read', props: 'read', atom: 'read_write', csr: 'read_write' },
    code: /* wgsl */ `
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let c = index(wid, lid);
  if (c >= min(atomicLoad(&atom[C_CONTACTS]), params.contactCap)) { return; }
  let ct = contacts[c];
  if (props[ct.s].invMass > 0.0) { csr[atomicAdd(&atom[aCursor(ct.s)], 1u)] = c * 2u; }
  if (props[ct.d].invMass > 0.0) { csr[atomicAdd(&atom[aCursor(ct.d)], 1u)] = c * 2u + 1u; }
}`,
  },
};
