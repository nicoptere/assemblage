/**
 * WGSL shared by the kernels: the data layout (structs, bit flags, the `atom` word map) and the
 * helper libraries a kernel can pull in (`lib`). Kernels are assembled by GpuKernels from these
 * pieces, declaring only the buffers they use (WebGPU caps storage buffers per shader at 8).
 */

export const SLOTS = 24; // contact slots per pair: candidates are hashed by cell, the deepest per slot wins
export const MAX_SUBSTEPS = 64;
export const MAX_ITERATIONS = 4; // contact position passes per substep
export const MAX_COLORS = 256; // joint colours: a body's joints each take one, so this many joints at most on one body
export const MAX_CONSTRAINTS = 16; // drag and grab points (a uniform: the solver reads them, nothing reads them back)
/** Slots of the index uniform: (substep, iteration) pairs, then one per joint colour. */
export const COLOR_INDEX = MAX_SUBSTEPS * MAX_ITERATIONS;
export const INDEX_SLOTS = COLOR_INDEX + MAX_COLORS;
export const MAX_PLANES = 16;
export const GROUP = 64;
export const ROW = 65535; // workgroups per dispatch row: index = wid.x + wid.y * ROW

/** Body flags (Props.flags). */
export const FLAG = { active: 1, dynamic: 2, kinematic: 4, static: 8, sleeping: 16, ccd: 32, infinite: 64, moved: 128 };
/** Joint flags. */
export const JOINT = { drive: 1 };
/** Command kinds (CPU -> GPU state writes). */
export const COMMAND = { teleport: 0, addVelocity: 1, setVelocity: 2 };
/** First words of `atom`: counters. Per-body regions follow (see atomLayout). */
export const COUNTER = { pairs: 0, contacts: 1, reports: 2, overflow: 3 };
export const COUNTERS = 16;

/** Word offsets of the per-body regions of `atom` for `cap` body slots. */
export function atomLayout(cap) {
  return { pushed: COUNTERS, wake: COUNTERS + cap, count: COUNTERS + 2 * cap, start: COUNTERS + 3 * cap, cursor: COUNTERS + 4 * cap + 1, words: COUNTERS + 5 * cap + 1 };
}

/** 32-bit words per element of each buffer (matching the structs below). */
export const WORDS = { props: 32, state: 16, prev: 16, bounds: 8, pair: 28, contact: 20, joint: 24, constraint: 16, command: 20, report: 12 };

export const STRUCTS = /* wgsl */ `
struct Params {
  dt: f32, h: f32, substeps: u32, bodyCount: u32,
  gravity: vec3f, margin: f32,
  maxSweep: f32, maxDepen: f32, maxSpeed: f32, maxAngSpeed: f32,
  pairCap: u32, contactCap: u32, reportCap: u32, reportSpeed: f32,
  commandCount: u32, excludedCount: u32, planeCount: u32, constraintCount: u32,
  bodyCap: u32, iterations: u32, colorCount: u32, pad2: u32,
  restSpeed: f32, restDamp: f32, pad3: u32, pad4: u32,   // below restSpeed (any point), extra damping (World.restDamping)
  planes: array<vec4u, ${MAX_PLANES / 4}>,
}

struct Index { a: u32, b: u32 }   // a substep and its contact iteration, or a joint colour's range

// per body, written by the CPU when something about the body changes
struct Props {
  invMass: f32, flags: u32, shape: u32, sampleStart: u32,
  sampleCount: u32, group: u32, mask: u32, radius: f32,
  com: vec3f, friction: f32,
  inv0: vec3f, restitution: f32,   // rows of the body-local inverse inertia
  inv1: vec3f, rolling: f32,
  inv2: vec3f, linDamp: f32,
  boxMin: vec3f, angDamp: f32,     // shape-space box
  boxMax: vec3f, pad: f32,
}

// per body, owned by the GPU (the CPU only sends commands)
struct State { pos: vec3f, p0: f32, quat: vec4f, vel: vec3f, p1: f32, ang: vec3f, p2: f32 }
struct Prev { pos: vec3f, p0: f32, quat: vec4f, vel: vec3f, p1: f32, ang: vec3f, p2: f32 }   // the substep's start
struct Bounds { lo: vec3f, sweep: f32, hi: vec3f, shortfall: f32 }

// a candidate pair; m: frame of a's shape-space samples in b's shape space, n: b's in a's (p = M s + t, t in w)
struct Pair { a: u32, b: u32, margin: f32, cell: f32, m0: vec4f, m1: vec4f, m2: vec4f, n0: vec4f, n1: vec4f, n2: vec4f }

// a sample of body s touching the surface of body d (body-local arms and normal)
struct Contact {
  s: u32, d: u32, friction: f32, restitution: f32,
  rA: vec3f, rolling: f32,
  rB: vec3f, approach: f32,
  nB: vec3f, lambdaN: f32,
  depth0: f32, vnPre: f32, lambdaT: f32, pad: f32,   // pad: depth pushed out this substep
}

struct Joint {
  a: u32, b: u32, kind: u32, flags: u32,   // kind 0 fixed, 1 ball
  localA: vec3f, compliance: f32,
  localB: vec3f, angCompliance: f32,
  frameA: vec4f, frameB: vec4f,
  breakForce: f32, breakTorque: f32, id: u32, p0: u32,   // id: the joint's slot in jointState
}

struct Constraint { body: u32, p0: u32, p1: u32, p2: u32, local: vec3f, compliance: f32, goal: vec3f, damping: f32, maxForce: f32, p3: f32, p4: f32, p5: f32 }
struct Command { body: u32, kind: u32, p0: u32, p1: u32, pos: vec3f, p2: f32, quat: vec4f, vel: vec3f, p3: f32, ang: vec3f, p4: f32 }
struct Report { s: u32, d: u32, approach: f32, p0: f32, point: vec3f, p1: f32, normal: vec3f, p2: f32 }

struct Shape {
  kind: u32, nx: u32, ny: u32, nz: u32,   // 0 grid, 1 plane, 2 sphere, 3 box
  ox: f32, oy: f32, oz: f32, voxel: f32,
  inv: f32, scale: f32, dataOffset: u32, sampleStart: u32,
  p: vec4f,           // plane: normal, offset | sphere: radius | box: half extents
  boxMin: vec4f,      // w > 0: bounded
  boxMax: vec4f,
}

const SLOTS = ${SLOTS}u;
const ROW = ${ROW}u;
const EMPTY = 0xffffffffu;
const F_ACTIVE = ${FLAG.active}u;
const F_DYNAMIC = ${FLAG.dynamic}u;
const F_KINEMATIC = ${FLAG.kinematic}u;
const F_STATIC = ${FLAG.static}u;
const F_SLEEPING = ${FLAG.sleeping}u;
const F_CCD = ${FLAG.ccd}u;
const F_INFINITE = ${FLAG.infinite}u;
const F_MOVED = ${FLAG.moved}u;
const J_DRIVE = ${JOINT.drive}u;
const C_PAIRS = ${COUNTER.pairs}u;
const C_CONTACTS = ${COUNTER.contacts}u;
const C_REPORTS = ${COUNTER.reports}u;
const C_OVERFLOW = ${COUNTER.overflow}u;
const A_PUSHED = ${COUNTERS}u;
`;

/** Element types of the buffers kernels can bind (atom: atomic when written). */
export const BUFFER_TYPES = {
  props: 'array<Props>',
  state: 'array<State>',
  prev: 'array<Prev>',
  bounds: 'array<Bounds>',
  pairs: 'array<Pair>',
  slots: { read: 'array<u32>', read_write: 'array<atomic<u32>>' },
  contacts: 'array<Contact>',
  csr: 'array<u32>',
  corr: 'array<vec4f>',
  joints: 'array<Joint>',
  jointState: 'array<vec4f>', // per joint id: broken (1), force, torque; kept across uploads
  colors: `array<vec4u, ${MAX_COLORS / 2}>`, // uniform: per joint colour, first joint and count (two a vec4)
  constraints: `array<Constraint, ${MAX_CONSTRAINTS}>`, // uniform
  commands: 'array<Command>',
  reports: 'array<Report>',
  excludedKeys: 'array<u32>',
  shapes: 'array<Shape>',
  samples: 'array<f32>',
  sdf: 'array<u32>',
  args: 'array<u32>',
  atom: { read: 'array<u32>', read_write: 'array<atomic<u32>>' },
};

/** Helper libraries: code, and the buffers it reads. */
export const LIBS = {
  math: {
    uses: {},
    code: /* wgsl */ `
fn index(wid: vec3u, lid: u32) -> u32 { return (wid.x + wid.y * ROW) * ${GROUP}u + lid; }
// per-body regions of atom (see atomLayout)
fn aPushed(i: u32) -> u32 { return A_PUSHED + i; }
fn aWake(i: u32) -> u32 { return A_PUSHED + params.bodyCap + i; }
fn aCount(i: u32) -> u32 { return A_PUSHED + 2u * params.bodyCap + i; }
fn aStart(i: u32) -> u32 { return A_PUSHED + 3u * params.bodyCap + i; }
fn aCursor(i: u32) -> u32 { return A_PUSHED + 4u * params.bodyCap + 1u + i; }
fn has(flags: u32, f: u32) -> bool { return (flags & f) != 0u; }
fn awake(p: Props) -> bool { return has(p.flags, F_DYNAMIC) && !has(p.flags, F_SLEEPING); }
fn moving(p: Props) -> bool { return has(p.flags, F_KINEMATIC) || awake(p); }

fn qmul(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
               a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
               a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
               a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z);
}
fn qconj(q: vec4f) -> vec4f { return vec4f(-q.xyz, q.w); }
fn rotate(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn unrotate(q: vec4f, v: vec3f) -> vec3f { return rotate(qconj(q), v); }
// q += 0.5 [v, 0] q, normalised: XPBD orientation update (integration and corrections)
fn addRotation(q: vec4f, v: vec3f) -> vec4f {
  let d = 0.5 * vec4f(v.x * q.w + v.y * q.z - v.z * q.y,
                      v.y * q.w + v.z * q.x - v.x * q.z,
                      v.z * q.w + v.x * q.y - v.y * q.x,
                      -v.x * q.x - v.y * q.y - v.z * q.z);
  return normalize(q + d);
}
// rotation vector (axis * angle, shortest arc)
fn rotationVector(q0: vec4f) -> vec3f {
  var q = q0;
  if (q.w < 0.0) { q = -q; }
  let s = length(q.xyz);
  if (s < 1e-9) { return 2.0 * q.xyz; }
  return q.xyz * (2.0 * atan2(s, q.w) / s);
}
fn rotation(q: vec4f) -> mat3x3f {
  return mat3x3f(rotate(q, vec3f(1.0, 0.0, 0.0)), rotate(q, vec3f(0.0, 1.0, 0.0)), rotate(q, vec3f(0.0, 0.0, 1.0)));
}
// world inverse inertia times v (zero for immovable bodies)
fn invInertia(p: Props, q: vec4f, v: vec3f) -> vec3f {
  if (p.invMass == 0.0) { return vec3f(0.0); }
  let u = unrotate(q, v);
  return rotate(q, vec3f(dot(p.inv0, u), dot(p.inv1, u), dot(p.inv2, u)));
}
fn inertiaMatrix(p: Props, q: vec4f) -> mat3x3f {
  return mat3x3f(invInertia(p, q, vec3f(1.0, 0.0, 0.0)), invInertia(p, q, vec3f(0.0, 1.0, 0.0)), invInertia(p, q, vec3f(0.0, 0.0, 1.0)));
}
// inverse mass seen at arm r along unit n, and about unit axis n
fn pointInvMass(p: Props, q: vec4f, r: vec3f, n: vec3f) -> f32 {
  if (p.invMass == 0.0) { return 0.0; }
  let rn = cross(r, n);
  return p.invMass + dot(rn, invInertia(p, q, rn));
}
fn angularInvMass(p: Props, q: vec4f, n: vec3f) -> f32 { return dot(n, invInertia(p, q, n)); }
fn skew(r: vec3f) -> mat3x3f { return mat3x3f(vec3f(0.0, r.z, -r.y), vec3f(-r.z, 0.0, r.x), vec3f(r.y, -r.x, 0.0)); }
// effective mass matrix of a point at arm r: 1/m E - S I^-1 S (S v = r x v)
fn pointMatrix(p: Props, q: vec4f, r: vec3f) -> mat3x3f {
  if (p.invMass == 0.0) { return mat3x3f(); }
  let S = skew(r);
  return mat3x3f(vec3f(p.invMass, 0.0, 0.0), vec3f(0.0, p.invMass, 0.0), vec3f(0.0, 0.0, p.invMass)) - S * inertiaMatrix(p, q) * S;
}
fn diag(a: f32) -> mat3x3f { return mat3x3f(vec3f(a, 0.0, 0.0), vec3f(0.0, a, 0.0), vec3f(0.0, 0.0, a)); }
// K x = b; w = 0 if K is singular
fn solve3(K: mat3x3f, b: vec3f) -> vec4f {
  let det = determinant(K);
  if (abs(det) < 1e-30) { return vec4f(0.0); }
  let inv = transpose(mat3x3f(cross(K[1], K[2]), cross(K[2], K[0]), cross(K[0], K[1]))) * (1.0 / det);
  return vec4f(inv * b, 1.0);
}
// float bits that sort like the floats
fn orderable(f: f32) -> u32 {
  let b = bitcast<u32>(f);
  return select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u);
}
`,
  },
  shape: {
    uses: { shapes: 'read', samples: 'read', sdf: 'read' },
    code: /* wgsl */ `
fn sample(i: u32) -> vec3f { return vec3f(samples[i * 3u], samples[i * 3u + 1u], samples[i * 3u + 2u]); }

fn gridValue(r: Shape, n: u32) -> f32 {
  let at = r.dataOffset + n;
  let w = sdf[at >> 1u];
  let top = select(w << 16u, w, (at & 1u) == 1u); // the wanted half in the top bits
  return f32(bitcast<i32>(top) >> 16u);           // arithmetic shift: sign-extended
}

// distance (w) and unit gradient (xyz) of a grid, trilinear inside, extended by the box distance outside
fn gridField(r: Shape, p: vec3f, wantGrad: bool) -> vec4f {
  let u = (p - vec3f(r.ox, r.oy, r.oz)) * r.inv;
  let top = vec3f(f32(r.nx - 1u), f32(r.ny - 1u), f32(r.nz - 1u)) - vec3f(1e-4);
  let c = clamp(u, vec3f(0.0), top);
  let out = u - c;
  let outside = length(out) * r.voxel;
  let i = min(u32(c.x), r.nx - 2u);
  let j = min(u32(c.y), r.ny - 2u);
  let k = min(u32(c.z), r.nz - 2u);
  let f = c - vec3f(f32(i), f32(j), f32(k));
  let sx = r.nx;
  let sxy = r.nx * r.ny;
  let base = i + sx * j + sxy * k;
  let c000 = gridValue(r, base);
  let c100 = gridValue(r, base + 1u);
  let c010 = gridValue(r, base + sx);
  let c110 = gridValue(r, base + sx + 1u);
  let c001 = gridValue(r, base + sxy);
  let c101 = gridValue(r, base + sxy + 1u);
  let c011 = gridValue(r, base + sxy + sx);
  let c111 = gridValue(r, base + sxy + sx + 1u);
  let c00 = mix(c000, c100, f.x);
  let c10 = mix(c010, c110, f.x);
  let c01 = mix(c001, c101, f.x);
  let c11 = mix(c011, c111, f.x);
  let c0 = mix(c00, c10, f.y);
  let c1 = mix(c01, c11, f.y);
  let d = mix(c0, c1, f.z) * r.scale + outside;
  if (!wantGrad) { return vec4f(0.0, 0.0, 0.0, d); }
  if (outside > 0.0) { return vec4f(normalize(out), d); }
  let g = vec3f((c100 - c000) * (1.0 - f.y) * (1.0 - f.z) + (c110 - c010) * f.y * (1.0 - f.z) + (c101 - c001) * (1.0 - f.y) * f.z + (c111 - c011) * f.y * f.z,
                (c10 - c00) * (1.0 - f.z) + (c11 - c01) * f.z,
                c1 - c0);
  if (dot(g, g) < 1e-20) { return vec4f(0.0, 1.0, 0.0, d); }
  return vec4f(normalize(g), d);
}

fn boxField(h: vec3f, p: vec3f) -> vec4f {
  let q = abs(p) - h;
  let o = max(q, vec3f(0.0));
  let outside = length(o);
  let d = outside + min(max(q.x, max(q.y, q.z)), 0.0);
  let s = select(vec3f(-1.0), vec3f(1.0), p >= vec3f(0.0));
  if (outside > 0.0) { return vec4f(normalize(s * o), d); }
  if (q.x >= q.y && q.x >= q.z) { return vec4f(s.x, 0.0, 0.0, d); }
  if (q.y >= q.z) { return vec4f(0.0, s.y, 0.0, d); }
  return vec4f(0.0, 0.0, s.z, d);
}

fn field(r: Shape, p: vec3f, wantGrad: bool) -> vec4f {
  switch r.kind {
    case 0u: { return gridField(r, p, wantGrad); }
    case 1u: { return vec4f(r.p.xyz, dot(r.p.xyz, p) - r.p.w); }
    case 2u: {
      let l = length(p);
      return vec4f(select(vec3f(0.0, 1.0, 0.0), p / l, l > 1e-12), l - r.p.x);
    }
    default: { return boxField(r.p.xyz, p); }
  }
}
fn distanceTo(r: Shape, p: vec3f) -> f32 { return field(r, p, false).w; }
fn outsideBox(r: Shape, p: vec3f, m: f32) -> bool {
  return r.boxMin.w > 0.0 && (any(p < r.boxMin.xyz - vec3f(m)) || any(p > r.boxMax.xyz + vec3f(m)));
}
`,
  },
};
