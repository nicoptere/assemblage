import * as THREE from 'three';

const SOLID = 250; // texel alpha (0-255) from which nothing shows through
const SIDE = 1024; // texels a side, at most, its alpha is read at
const alphas = new WeakMap(); // texture -> its alpha { width, height, data }, or null if unreadable
const twins = new WeakMap(); // see-through material -> its opaque twin
const _uv = new THREE.Vector2();

/**
 * `material` for triangles `tris` of `geometry`, or its opaque twin where they do not show through
 * it. A file often marks a whole material see-through (glTF's BLEND: Sketchfab's exports do,
 * for a windscreen sharing the atlas) when only a few of its faces are. Drawn see-through, the rest
 * writes no depth, so the depth of field reads what is behind it (the sky behind a sculpture: all
 * blurred), and its parts sort as wholes, drawn over one another in the wrong order. The triangles
 * show through if the material is less than opaque, its vertex colours have alpha, or its colour
 * map is see-through (alpha under SOLID) at the middle of any of them.
 */
export function opaqueIfSolid(material, geometry, tris) {
  if (!material.transparent || material.opacity < 1 || geometry.getAttribute('color')?.itemSize === 4) return material;
  if (material.map && seenThrough(material.map, geometry, tris)) return material;
  if (!twins.has(material)) twins.set(material, Object.assign(material.clone(), { transparent: false, depthWrite: true }));
  return twins.get(material);
}

/** Whether `map` is see-through at the middle of any of triangles `tris` (if it cannot be read: yes). */
function seenThrough(map, geometry, tris) {
  const alpha = alphaOf(map);
  const uv = geometry.getAttribute(map.channel ? `uv${map.channel}` : 'uv');
  if (!alpha || !uv) return true;
  if (map.matrixAutoUpdate) map.updateMatrix(); // offset, repeat, rotation (KHR_texture_transform)
  const index = geometry.index.array;
  for (const t of tris) {
    _uv.set(0, 0);
    for (let k = 0; k < 3; k++) _uv.x += uv.getX(index[3 * t + k]) / 3, _uv.y += uv.getY(index[3 * t + k]) / 3;
    _uv.applyMatrix3(map.matrix);
    const u = _uv.x - Math.floor(_uv.x), v = _uv.y - Math.floor(_uv.y); // repeated
    const x = Math.min(alpha.width - 1, Math.floor(u * alpha.width));
    const y = Math.min(alpha.height - 1, Math.floor((map.flipY ? 1 - v : v) * alpha.height)); // row 0 is the image's top
    if (alpha.data[y * alpha.width + x] < SOLID) return true;
  }
  return false;
}

/** A texture's alpha, read once (at most SIDE texels a side); null if its image cannot be drawn (compressed, say). */
function alphaOf(texture) {
  if (alphas.has(texture)) return alphas.get(texture);
  let alpha = null;
  const image = texture.image;
  try {
    const s = Math.min(1, SIDE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * s)), height = Math.max(1, Math.round(image.height * s));
    const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i++) data[i] = rgba[4 * i + 3];
    alpha = { width, height, data };
  } catch {
    alpha = null;
  }
  alphas.set(texture, alpha);
  return alpha;
}
