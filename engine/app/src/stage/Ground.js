import * as THREE from 'three';

/**
 * The floor's material: lit, shadowed and fogged as any, with a grid drawn by its fragment shader,
 * lines `cell` m apart, the two through the centre darker (GridHelper's look, which drew the same
 * as 2k vertices of lines). The lines are a pixel wide whatever the distance, and fade out where
 * the cells shrink to a few pixels, so the distance shows no moiré; like GridHelper's, they are
 * not lit (shadows do not darken them). With `stripes` ({ color, opacity, period, share }) it also
 * paints diagonal stripes, `period` m apart along either axis, `share` of it wide, and a line a
 * pixel wide along the square `edge` m from the centre (setEdge), as a frame on the floor: the
 * floor's own colour between them, so it can be opaque.
 */
export class GroundMaterial extends THREE.MeshStandardMaterial {
  constructor({ cell, color = 0xc9ccd2, line = 0xb3b8c1, axis = 0x9aa0ab, stripes = null }) {
    super({ color, roughness: 0.95 });
    this.uniforms = {
      gridCell: { value: cell },
      gridLine: { value: new THREE.Color(line) },
      gridAxis: { value: new THREE.Color(axis) },
      stripeColour: { value: new THREE.Color(stripes?.color ?? 0) },
      stripeOpacity: { value: stripes?.opacity ?? 0 },
      stripePeriod: { value: stripes?.period ?? 1 },
      stripeShare: { value: stripes?.share ?? 0 },
      stripeEdge: { value: 0 },
    };
    if (stripes) this.defines.STRIPES = '';
  }

  /** The stripes' edge line: the square `half` m from the centre. */
  setEdge(half) {
    this.uniforms.stripeEdge.value = half;
  }

  onBeforeCompile(shader) {
    Object.assign(shader.uniforms, this.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGround;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGround = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GROUND}`)
      .replace('#include <opaque_fragment>', 'outgoingLight = ground(outgoingLight, vGround);\n#include <opaque_fragment>');
  }

  customProgramCacheKey() {
    return 'STRIPES' in this.defines ? 'ground-stripes' : 'ground';
  }
}

/** The floor, `size` m across: a single quad (4 vertices, 2 triangles) in the ground material. */
export class Ground extends THREE.Mesh {
  constructor({ size, cell }) {
    super(new THREE.PlaneGeometry(size, size), new GroundMaterial({ cell }));
    this.rotation.x = -Math.PI / 2;
    this.receiveShadow = true;
  }
}

// cover(d, w): how much of a pixel a line covers, d from its middle, w the pixel's size (same units)
const GROUND = /* glsl */ `
uniform float gridCell;
uniform vec3 gridLine;
uniform vec3 gridAxis;
uniform vec3 stripeColour;
uniform float stripeOpacity;
uniform float stripePeriod;
uniform float stripeShare;
uniform float stripeEdge;
varying vec2 vGround;
vec2 cover(vec2 d, vec2 w) { return 1.0 - min(d / w, 1.0); }
vec3 ground(vec3 colour, vec2 p) {
  vec2 q = p / gridCell;
  vec2 w = fwidth(q);
  vec2 lines = cover(abs(fract(q - 0.5) - 0.5), w) * (1.0 - smoothstep(0.2, 0.45, w));
  vec2 axes = cover(abs(q), w);
  colour = mix(colour, gridLine, max(lines.x, lines.y));
  colour = mix(colour, gridAxis, max(axes.x, axes.y));
#ifdef STRIPES
  float s = (p.x - p.y) / stripePeriod; // a stripe on every whole s
  float ws = fwidth(s);
  float stripe = clamp((0.5 * stripeShare - abs(fract(s + 0.5) - 0.5)) / ws + 0.5, 0.0, 1.0);
  stripe = mix(stripe, stripeShare, smoothstep(0.2, 0.45, ws)); // where they shrink to a few pixels, their average
  float m = max(abs(p.x), abs(p.y));
  float edge = cover(vec2(max(m - stripeEdge, 0.0)), vec2(fwidth(m))).x;
  colour = mix(colour, stripeColour, stripeOpacity * max(stripe, edge));
#endif
  return colour;
}
`;
