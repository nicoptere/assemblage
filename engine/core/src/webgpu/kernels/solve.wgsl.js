/**
 * Solver, every substep (XPBD, the CPU's order; see CpuBackend.solve), as phase functions:
 *   integrateBody       keeps the substep's start (pose and velocities, in prev), then rest damping
 *                       (World.restDamping), gravity, damping, speed caps, positions and orientations
 *   solveJoint          one colour at a time: joints of a colour share no movable body, so each
 *                       solves in place (Gauss-Seidel, as the CPU): orientation lock, then point
 *                       lock, both full 3x3; breaks on the force / torque it carried. A joint's
 *                       state (broken, readouts) lives by joint id in jointState, so a joint that
 *                       broke stays broken when the CPU re-sends the list before it heard
 *   dragPositions       drag and grab points, one thread (there are a few)
 *   contactPositionAt   each contact computes the corrections of its two bodies alone (Jacobi):
 *                       non-penetration with the depenetration cap, then static friction. The first
 *                       pass of a substep starts the contact from the substep's start (lambdas,
 *                       penetration, normal velocity)
 *   applyPositionAt     each body averages the corrections of its contacts that acted. These two
 *                       run `iterations` times (lambdas and the pushed depth accumulate): one
 *                       Jacobi pass only partly fixes a patch pressed in unevenly, and what a
 *                       substep leaves counts as old penetration, pushed out at 0.25 m/s only.
 *                       The last pass also sets the velocities from the positions moved
 *   contactVelocityAt   restitution, dynamic friction, rolling resistance, as velocity changes
 *   applyVelocityAt     averaged per body
 *   dragVelocities      drag damping
 * Contacts are averaged rather than summed: every contact of a resting patch computes the
 * correction the body needs, so their mean is that correction (summing would overshoot by the
 * contact count); bodies squeezed from several sides converge over the substeps.
 *
 * Two ways to run them. `solve`: one workgroup runs every phase of every substep, a barrier
 * between phases: one dispatch a step. Split: a dispatch per phase (integrate, joints or
 * jointColors, contactPosition / applyPosition per pass, contactVelocity, applyVelocity), up to
 * ~170 a step; it spreads over the whole GPU, but every dispatch costs a barrier on the GPU and,
 * in Chrome, about 0.2 ms of the browser's own work. Hits are reported before the substeps (report).
 */

const CONTACT_FNS = /* wgsl */ `
fn contactCount() -> u32 { return min(atom[C_CONTACTS], params.contactCap); }

struct Delta { a: vec3f, b: vec3f, c: vec3f, d: vec3f }   // body a: linear, angular | body b: linear, angular

// impulse making the relative velocity of two material points change by dv
fn relativeVelocityChange(pa: Props, qa: vec4f, ra: vec3f, pb: Props, qb: vec4f, rb: vec3f, dv: vec3f) -> Delta {
  let c = length(dv);
  if (c < 1e-12) { return Delta(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0)); }
  let n = dv / c;
  let w = pointInvMass(pa, qa, ra, n) + pointInvMass(pb, qb, rb, n);
  if (w == 0.0) { return Delta(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0)); }
  let P = dv / w;
  return Delta(P * pa.invMass, invInertia(pa, qa, cross(ra, P)), -P * pb.invMass, -invInertia(pb, qb, cross(rb, P)));
}

fn relativeSpinChange(pa: Props, qa: vec4f, pb: Props, qb: vec4f, dw: vec3f) -> Delta {
  let c = length(dw);
  if (c < 1e-12) { return Delta(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0)); }
  let n = dw / c;
  let w = angularInvMass(pa, qa, n) + angularInvMass(pb, qb, n);
  if (w == 0.0) { return Delta(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0)); }
  let P = dw / w;
  return Delta(vec3f(0.0), invInertia(pa, qa, P), vec3f(0.0), -invInertia(pb, qb, P));
}

fn writeDelta(i: u32, d: Delta, acted: f32) {
  corr[i * 4u] = vec4f(d.a, acted);
  corr[i * 4u + 1u] = vec4f(d.b, 0.0);
  corr[i * 4u + 2u] = vec4f(d.c, acted);
  corr[i * 4u + 3u] = vec4f(d.d, 0.0);
}
`;

/** Sums the corrections listed for body i (csr entries: contact * 2 + side), weighted by whether they acted. */
const AVERAGE_FNS = /* wgsl */ `
struct Average { lin: vec3f, ang: vec3f, n: f32 }
fn average(i: u32) -> Average {
  let lo = atom[aStart(i)];
  let hi = atom[aStart(i + 1u)];
  var a = Average(vec3f(0.0), vec3f(0.0), 0.0);
  for (var k = lo; k < hi; k++) {
    let e = csr[k];
    let l = corr[e * 2u];
    a.lin += l.xyz;
    a.ang += corr[e * 2u + 1u].xyz;
    a.n += l.w;
  }
  if (a.n > 0.0) {
    a.lin /= a.n;
    a.ang /= a.n;
  }
  return a;
}
`;

const JOINT_USES = { joints: 'read', jointState: 'read_write', props: 'read', state: 'read_write' };

const JOINT_FNS = /* wgsl */ `
/** Solves joint ji in place (Gauss-Seidel): orientation lock, then point lock; breaks on what it carried. */
fn solveJoint(ji: u32) {
  let j = joints[ji];
  if (jointState[j.id].x != 0.0) { return; } // broke: stays broken whatever the CPU re-sends
  let pa = props[j.a];
  let pb = props[j.b];
  var A = state[j.a];
  var B = state[j.b];
  let h = params.h;
  var lambdaRot = vec3f(0.0);
  if (j.kind == 0u || has(j.flags, J_DRIVE)) {
    let dth = rotationVector(qmul(qmul(B.quat, j.frameB), qconj(qmul(A.quat, j.frameA))));
    let sol = solve3(inertiaMatrix(pa, A.quat) + inertiaMatrix(pb, B.quat) + diag(j.angCompliance / (h * h)), dth);
    if (sol.w > 0.0) {
      lambdaRot = sol.xyz;
      A.quat = addRotation(A.quat, invInertia(pa, A.quat, lambdaRot));
      B.quat = addRotation(B.quat, -invInertia(pb, B.quat, lambdaRot));
    }
  }
  // point lock last, so the anchor is exact after the angular correction moved the arms
  let rA = rotate(A.quat, j.localA);
  let rB = rotate(B.quat, j.localB);
  let dx = B.pos + rB - rA - A.pos;
  let alpha = j.compliance / (h * h);
  var lambdaPoint = vec3f(0.0);
  if (dot(dx, dx) >= 1e-24 || alpha != 0.0) {
    let sol = solve3(pointMatrix(pa, A.quat, rA) + pointMatrix(pb, B.quat, rB) + diag(alpha), dx);
    if (sol.w > 0.0) {
      lambdaPoint = sol.xyz;
      A.pos += lambdaPoint * pa.invMass;
      A.quat = addRotation(A.quat, invInertia(pa, A.quat, cross(rA, lambdaPoint)));
      B.pos -= lambdaPoint * pb.invMass;
      B.quat = addRotation(B.quat, -invInertia(pb, B.quat, cross(rB, lambdaPoint)));
    }
  }
  if (pa.invMass > 0.0) { state[j.a] = A; }
  if (pb.invMass > 0.0) { state[j.b] = B; }
  let inv = 1.0 / (h * h);
  let force = length(lambdaPoint) * inv;
  let torque = select(0.0, length(lambdaRot) * inv, j.kind == 0u);
  jointState[j.id] = vec4f(select(0.0, 1.0, force > j.breakForce || torque > j.breakTorque), force, torque, 0.0);
}
`;


/** Hard hits of this step, for sounds and the debug view: closing speed at the step's start. */
const REPORT_FNS = /* wgsl */ `
fn reportContact(i: u32) {
  let c = contacts[i];
  let A = state[c.s];
  let B = state[c.d];
  let rA = rotate(A.quat, c.rA);
  let rB = rotate(B.quat, c.rB);
  let n = rotate(B.quat, c.nB);
  let pB = B.pos + rB;
  let approach = max(0.0, -dot((A.vel + cross(A.ang, rA)) - (B.vel + cross(B.ang, rB)), n));
  if (approach < params.reportSpeed) { return; }
  let r = atomicAdd(&atom[C_REPORTS], 1u);
  if (r < params.reportCap) { reports[r] = Report(c.s, c.d, approach, max(0.0, dot(pB - (A.pos + rA), n)), pB, 0.0, n, 0.0); }
}
`;

const INTEGRATE_FNS = /* wgsl */ `
fn integrateBody(i: u32) {
  let p = props[i];
  var s = state[i];
  prev[i] = Prev(s.pos, 0.0, s.quat, s.vel, 0.0, s.ang, 0.0);
  if (!has(p.flags, F_ACTIVE) || has(p.flags, F_STATIC) || has(p.flags, F_SLEEPING)) { return; }
  let h = params.h;
  if (has(p.flags, F_DYNAMIC)) {
    if (params.restDamp > 0.0 && length(s.vel) + length(s.ang) * p.radius < params.restSpeed) {
      let k = max(0.0, 1.0 - params.restDamp * h);
      s.vel *= k;
      s.ang *= k;
    }
    s.vel += params.gravity * h;
    s.vel *= max(0.0, 1.0 - p.linDamp * h);
    s.ang *= max(0.0, 1.0 - p.angDamp * h);
    let v = length(s.vel);
    if (v > params.maxSpeed) { s.vel *= params.maxSpeed / v; }
    let w = length(s.ang);
    if (w > params.maxAngSpeed) { s.ang *= params.maxAngSpeed / w; }
  }
  s.pos += s.vel * h;
  s.quat = addRotation(s.quat, s.ang * h);
  state[i] = s;
}
`;

/** The arms and normal of contact c in the current poses. */
const CONTACT_FRAME = /* wgsl */ `
  let pa = props[c.s];
  let pb = props[c.d];
  let A = state[c.s];
  let B = state[c.d];
  let rA = rotate(A.quat, c.rA);
  let rB = rotate(B.quat, c.rB);
  let n = rotate(B.quat, c.nB);
  let h = params.h;`;

const POSITION_FNS = /* wgsl */ `
fn contactPositionAt(i: u32, first: bool) {
  var c = contacts[i];${CONTACT_FRAME}
  if (first) {
    // first pass of the substep: the contact as it was at the substep's start
    let PA = prev[c.s];
    let PB = prev[c.d];
    let rA0 = rotate(PA.quat, c.rA);
    let rB0 = rotate(PB.quat, c.rB);
    let n0 = rotate(PB.quat, c.nB);
    c.lambdaN = 0.0;
    c.lambdaT = 0.0;
    c.pad = 0.0; // depth pushed out so far this substep (over the passes)
    c.depth0 = max(0.0, dot((PB.pos + rB0) - (PA.pos + rA0), n0));
    c.vnPre = dot((PA.vel + cross(PA.ang, rA0)) - (PB.vel + cross(PB.ang, rB0)), n0);
  }
  var depth = dot((B.pos + rB) - (A.pos + rA), n);
  if (pa.invMass > 0.0 && pb.invMass > 0.0) {
    depth = min(depth, (max(0.0, -c.vnPre) + params.maxDepen) * h - c.pad);
  } else {
    depth -= max(0.0, c.depth0 - params.maxDepen * h);
  }
  var d = Delta(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  let w = pointInvMass(pa, A.quat, rA, n) + pointInvMass(pb, B.quat, rB, n);
  var acted = 0.0;
  if (depth > 0.0 && w > 0.0) {
    acted = 1.0;
    let dl = depth / w;
    c.lambdaN += dl;
    c.pad += depth;
    let P = n * dl;
    d = Delta(P * pa.invMass, invInertia(pa, A.quat, cross(rA, P)), -P * pb.invMass, -invInertia(pb, B.quat, cross(rB, P)));
    // static friction: undo the tangential slip of the two points over the substep, after the push
    let qA = addRotation(A.quat, d.b);
    let qB = addRotation(B.quat, d.d);
    let rA1 = rotate(qA, c.rA);
    let rB1 = rotate(qB, c.rB);
    let PA = prev[c.s];
    let PB = prev[c.d];
    var slip = ((A.pos + d.a + rA1) - (PA.pos + rotate(PA.quat, c.rA))) - ((B.pos + d.c + rB1) - (PB.pos + rotate(PB.quat, c.rB)));
    slip -= n * dot(slip, n);
    let l = length(slip);
    if (l > 1e-9) {
      let t = -slip / l;
      let wt = pointInvMass(pa, qA, rA1, t) + pointInvMass(pb, qB, rB1, t);
      if (wt > 0.0) {
        let dlt = l / wt;
        if (c.lambdaT + dlt < c.friction * c.lambdaN) {
          c.lambdaT += dlt;
          let Pt = t * dlt;
          d.a += Pt * pa.invMass;
          d.b += invInertia(pa, qA, cross(rA1, Pt));
          d.c -= Pt * pb.invMass;
          d.d -= invInertia(pb, qB, cross(rB1, Pt));
        }
      }
    }
  }
  contacts[i] = c;
  writeDelta(i, d, acted);
}

fn applyPositionAt(i: u32, last: bool) {
  let p = props[i];
  var s = state[i];
  if (p.invMass > 0.0) {
    let a = average(i);
    if (a.n > 0.0) {
      s.pos += a.lin;
      s.quat = addRotation(s.quat, a.ang);
    }
  }
  if (last && has(p.flags, F_ACTIVE) && awake(p)) {
    // the last pass: velocities from the positions moved this substep
    let pv = prev[i];
    s.vel = (s.pos - pv.pos) / params.h;
    let dq = qmul(s.quat, qconj(pv.quat));
    s.ang = dq.xyz * (select(-2.0, 2.0, dq.w >= 0.0) / params.h);
  }
  state[i] = s;
}
`;

const VELOCITY_FNS = /* wgsl */ `
fn contactVelocityAt(i: u32) {
  let c = contacts[i];${CONTACT_FRAME}
  var d = Delta(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  if (c.lambdaN > 0.0) {
    let v = (A.vel + cross(A.ang, rA)) - (B.vel + cross(B.ang, rB));
    let vn = dot(v, n);
    var t = v - n * vn;
    let vt = length(t);
    let fn_ = c.lambdaN / (h * h);
    // restitution, off for resting contacts (no jitter)
    let e = select(c.restitution, 0.0, abs(vn) <= 2.0 * length(params.gravity) * h);
    d = relativeVelocityChange(pa, A.quat, rA, pb, B.quat, rB, n * (-vn + max(-e * c.vnPre, 0.0)));
    // dynamic friction: impulse h mu fn, as a velocity change of that times the inverse mass along the slip
    if (vt > 1e-9) {
      t /= vt;
      let w = pointInvMass(pa, A.quat, rA, t) + pointInvMass(pb, B.quat, rB, t);
      let f = relativeVelocityChange(pa, A.quat, rA, pb, B.quat, rB, t * -min(h * c.friction * fn_ * w, vt));
      d = Delta(d.a + f.a, d.b + f.b, d.c + f.c, d.d + f.d);
    }
    // rolling and spinning resistance: a torque of rolling x normal force, never reversing the spin
    if (c.rolling > 0.0) {
      let rel = A.ang - B.ang;
      let spin = length(rel);
      if (spin > 1e-9) {
        let axis = rel / spin;
        let k = angularInvMass(pa, A.quat, axis) + angularInvMass(pb, B.quat, axis);
        let f = relativeSpinChange(pa, A.quat, pb, B.quat, axis * -min(spin, h * c.rolling * fn_ * k));
        d = Delta(d.a, d.b + f.b, d.c, d.d + f.d);
      }
    }
  }
  writeDelta(i, d, select(0.0, 1.0, c.lambdaN > 0.0));
}

fn applyVelocityAt(i: u32) {
  if (props[i].invMass == 0.0) { return; }
  let a = average(i);
  if (a.n == 0.0) { return; }
  var s = state[i];
  s.vel += a.lin;
  s.ang += a.ang;
  state[i] = s;
}
`;

/** Drag and grab points, few: one thread does them all. Pull at most maxForce, then damp the point's velocity. */
const DRAG_FNS = /* wgsl */ `
fn dragPositions() {
  let h = params.h;
  for (var i = 0u; i < params.constraintCount; i++) {
    let c = constraints[i];
    let p = props[c.body];
    var s = state[c.body];
    let r = rotate(s.quat, c.local);
    let dx = c.goal - s.pos - r;
    let alpha = c.compliance / (h * h);
    if (p.invMass > 0.0 && (dot(dx, dx) >= 1e-24 || alpha != 0.0)) {
      let sol = solve3(pointMatrix(p, s.quat, r) + diag(alpha), dx);
      if (sol.w > 0.0) {
        var lam = sol.xyz;
        // cap the force (lambda / h^2), not the error: the pull saturates instead of going soft
        let cap = c.maxForce * h * h;
        let l = length(lam);
        if (l > cap) { lam *= cap / l; }
        s.pos += lam * p.invMass;
        s.quat = addRotation(s.quat, invInertia(p, s.quat, cross(r, lam)));
        state[c.body] = s;
      }
    }
  }
}

fn dragVelocities() {
  for (var i = 0u; i < params.constraintCount; i++) {
    let c = constraints[i];
    let p = props[c.body];
    if (p.invMass == 0.0 || c.damping <= 0.0) { continue; }
    var s = state[c.body];
    let r = rotate(s.quat, c.local);
    let dv = -(s.vel + cross(s.ang, r)) * min(c.damping * params.h, 1.0);
    let l = length(dv);
    if (l < 1e-12) { continue; }
    let w = pointInvMass(p, s.quat, r, dv / l);
    if (w == 0.0) { continue; }
    let P = dv / w;
    s.vel += P * p.invMass;
    s.ang += invInertia(p, s.quat, cross(r, P));
    state[c.body] = s;
  }
}
`;

const COLOR_FNS = /* wgsl */ `
fn colorRange(c: u32) -> vec2u {   // first joint and count of colour c
  let q = colors[c / 2u];
  return select(q.xy, q.zw, (c & 1u) == 1u);
}
`;

/** A dispatch over items: thread i of the grid, if under `count`. */
const over = (count, call) => /* wgsl */ `
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = index(wid, lid);
  if (i < ${count}) { ${call}; }
}`;

/** Threads of a one-workgroup kernel: as many as the device allows, up to 512. */
const SOLO = (limits) => Math.min(512, limits.maxComputeInvocationsPerWorkgroup, limits.maxComputeWorkgroupSizeX);

const BODY_USES = { props: 'read', state: 'read_write' };
const CONTACT_USES = { contacts: 'read_write', props: 'read', state: 'read', corr: 'read_write', atom: 'read' };
const AVERAGE_USES = { props: 'read', state: 'read_write', atom: 'read', csr: 'read', corr: 'read' };

export const SOLVE = {
  report: {
    uses: { contacts: 'read', state: 'read', atom: 'read_write', reports: 'read_write' },
    fns: REPORT_FNS,
    code: over('min(atomicLoad(&atom[C_CONTACTS]), params.contactCap)', 'reportContact(i)'),
  },

  // every phase of every substep in one workgroup of SOLO threads: a barrier between phases, not a dispatch
  solve: {
    uses: { props: 'read', state: 'read_write', prev: 'read_write', joints: 'read', jointState: 'read_write', contacts: 'read_write', corr: 'read_write', atom: 'read', csr: 'read', colors: 'uniform', constraints: 'uniform' },
    optional: true, // 9 storage buffers: only where the device allows them
    constants: { SOLO },
    fns: [CONTACT_FNS, AVERAGE_FNS, JOINT_FNS, INTEGRATE_FNS, POSITION_FNS, VELOCITY_FNS, COLOR_FNS, DRAG_FNS].join('\n'),
    code: /* wgsl */ `
override SOLO: u32 = 256u;
@compute @workgroup_size(SOLO) fn main(@builtin(local_invocation_index) lid: u32) {
  let bodies = params.bodyCount;
  let count = contactCount();
  for (var s = 0u; s < params.substeps; s++) {
    for (var i = lid; i < bodies; i += SOLO) { integrateBody(i); }
    storageBarrier();
    for (var c = 0u; c < params.colorCount; c++) {
      let r = colorRange(c);
      for (var t = lid; t < r.y; t += SOLO) { solveJoint(r.x + t); }
      storageBarrier();
    }
    if (params.constraintCount > 0u) {
      if (lid == 0u) { dragPositions(); }
      storageBarrier();
    }
    for (var k = 0u; k < params.iterations; k++) {
      for (var i = lid; i < count; i += SOLO) { contactPositionAt(i, k == 0u); }
      storageBarrier();
      for (var i = lid; i < bodies; i += SOLO) { applyPositionAt(i, k + 1u == params.iterations); }
      storageBarrier();
    }
    for (var i = lid; i < count; i += SOLO) { contactVelocityAt(i); }
    storageBarrier();
    for (var i = lid; i < bodies; i += SOLO) { applyVelocityAt(i); }
    storageBarrier();
    if (params.constraintCount > 0u) {
      if (lid == 0u) { dragVelocities(); }
      storageBarrier();
    }
  }
}`,
  },

  integrate: {
    uses: { ...BODY_USES, prev: 'read_write' },
    fns: INTEGRATE_FNS,
    code: over('params.bodyCount', 'integrateBody(i)'),
  },

  joints: {
    uses: JOINT_USES,
    indexed: true,
    fns: JOINT_FNS,
    code: over('idx.b', 'solveJoint(idx.a + i)'),
  },

  // every colour in one dispatch, one workgroup: a barrier between colours instead of a dispatch
  jointColors: {
    uses: { ...JOINT_USES, colors: 'uniform' },
    constants: { SOLO },
    fns: JOINT_FNS + COLOR_FNS,
    code: /* wgsl */ `
override SOLO: u32 = 256u;
@compute @workgroup_size(SOLO) fn main(@builtin(local_invocation_index) lid: u32) {
  for (var c = 0u; c < params.colorCount; c++) {
    let r = colorRange(c);
    for (var t = lid; t < r.y; t += SOLO) { solveJoint(r.x + t); }
    storageBarrier();
  }
}`,
  },

  constraints: {
    uses: { constraints: 'uniform', props: 'read', state: 'read_write' },
    fns: DRAG_FNS,
    code: '@compute @workgroup_size(1) fn main() { dragPositions(); }',
  },

  contactPosition: {
    uses: { ...CONTACT_USES, prev: 'read' },
    indexed: true,
    fns: CONTACT_FNS + POSITION_FNS.slice(0, POSITION_FNS.indexOf('fn applyPositionAt')),
    code: over('contactCount()', 'contactPositionAt(i, idx.b == 0u)'),
  },

  applyPosition: {
    uses: { ...AVERAGE_USES, prev: 'read' },
    indexed: true,
    fns: AVERAGE_FNS + POSITION_FNS.slice(POSITION_FNS.indexOf('fn applyPositionAt')),
    code: over('params.bodyCount', 'applyPositionAt(i, idx.b + 1u == params.iterations)'),
  },

  contactVelocity: {
    uses: { ...CONTACT_USES, contacts: 'read' },
    fns: CONTACT_FNS + VELOCITY_FNS.slice(0, VELOCITY_FNS.indexOf('fn applyVelocityAt')),
    code: over('contactCount()', 'contactVelocityAt(i)'),
  },

  applyVelocity: {
    uses: AVERAGE_USES,
    fns: AVERAGE_FNS + VELOCITY_FNS.slice(VELOCITY_FNS.indexOf('fn applyVelocityAt')),
    code: over('params.bodyCount', 'applyVelocityAt(i)'),
  },

  constraintVelocity: {
    uses: { constraints: 'uniform', props: 'read', state: 'read_write' },
    fns: DRAG_FNS,
    code: '@compute @workgroup_size(1) fn main() { dragVelocities(); }',
  },
};
