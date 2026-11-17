/** Share of a mesh's size: border loops narrower than this are capped (see capBorders). */
export const CAP_WIDTH = 0.02;

/**
 * Closes a part cut out of a mesh where it was cut through material: the loops of its border
 * (edges whose face across is not in the part, or is missing: cuts and holes), each capped by a
 * fan from the loop's centre, wound against the part's faces, so a consistently oriented part
 * comes out closed and oriented. Only narrow loops are capped: a cut across a wall or a small
 * solid (its width, twice its area over its length, at most `maxWidth`), and only where the fan
 * does not fold over itself (fan area at most 1.5 times the loop's). A wide loop is the outline of
 * a skin (a hull plate split off at a crease, a dome's rim): a lid over it would fill the room
 * under the skin with phantom solid, so it is left open, and the bake grows the skin into a
 * thin shell instead.
 * `faces`: the part's faces in `topo`; `inPart(g)`: whether face g is in it; `maxWidth` in the
 * mesh's units (default CAP_WIDTH of its size).
 * Returns the caps' triangles, 9 coordinates each, and the loops (vertex indices), capped or not.
 */
export function capBorders(topo, faces, inPart, maxWidth = CAP_WIDTH * topo.size) {
  const { F, nbr, V } = topo;
  // border half-edges, by the vertex they leave
  const from = new Map();
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const g = nbr[3 * f + k];
      if (g >= 0 && inPart(g)) continue;
      const u = F[3 * f + k], v = F[3 * f + ((k + 1) % 3)];
      if (u === v) continue;
      if (!from.has(u)) from.set(u, []);
      from.get(u).push(v);
    }
  }
  const loops = [];
  for (const [start, outs] of from) {
    while (outs.length) {
      const loop = [start];
      let at = outs.pop();
      while (at !== start) {
        loop.push(at);
        const next = from.get(at);
        if (!next?.length) break; // an open chain (a non-manifold corner): closed by the fan anyway
        at = next.pop();
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  const tris = [];
  for (const loop of loops) {
    const c = [0, 0, 0];
    for (const v of loop) for (let a = 0; a < 3; a++) c[a] += V[3 * v + a] / loop.length;
    const fan = [];
    const area = [0, 0, 0]; // the loop's vector area (Newell): half the sum of the fan's cross products
    let fanArea = 0, length = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      const u = [V[3 * p] - c[0], V[3 * p + 1] - c[1], V[3 * p + 2] - c[2]];
      const w = [V[3 * q] - c[0], V[3 * q + 1] - c[1], V[3 * q + 2] - c[2]];
      const x = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      for (let a = 0; a < 3; a++) area[a] += x[a] / 2;
      fanArea += Math.hypot(...x) / 2;
      length += Math.hypot(w[0] - u[0], w[1] - u[1], w[2] - u[2]);
      fan.push(...c, V[3 * q], V[3 * q + 1], V[3 * q + 2], V[3 * p], V[3 * p + 1], V[3 * p + 2]);
    }
    const enclosed = Math.hypot(...area);
    if ((2 * enclosed) / length <= maxWidth && fanArea <= 1.5 * enclosed + 1e-12) tris.push(...fan);
  }
  return { tris: Float64Array.from(tris), loops };
}

/** The triangles of `faces`, 9 coordinates each. */
export function trianglesOf(topo, faces) {
  const { V, F } = topo;
  const out = new Float64Array(9 * faces.length);
  faces.forEach((f, i) => {
    for (let c = 0; c < 3; c++) for (let a = 0; a < 3; a++) out[9 * i + 3 * c + a] = V[3 * F[3 * f + c] + a];
  });
  return out;
}

/**
 * A part as closed as its cuts allow: its own triangles then the caps over its narrow borders
 * (capBorders), 9 coordinates each. Returns { tris, own, caps }.
 */
export function closedPart(topo, faces, inPart, maxWidth = CAP_WIDTH * topo.size) {
  const own = trianglesOf(topo, faces);
  const { tris: caps } = capBorders(topo, faces, inPart, maxWidth);
  const tris = new Float64Array(own.length + caps.length);
  tris.set(own);
  tris.set(caps, own.length);
  return { tris, own, caps };
}
