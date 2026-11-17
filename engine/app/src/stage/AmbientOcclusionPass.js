import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

/**
 * Ambient occlusion, the creases and contacts darkened: three's GTAO and its Poisson denoise, at
 * `scale` of the frame's size, multiplied into the image. GTAO needs the scene's normals, which it
 * renders with one material for every mesh: that would draw the parts where their vertex shader
 * does not move them (PartSkin), so each mesh is drawn in its own normal material instead (a
 * part's, `userData.normalMaterial`, moves its vertices as its skin does); see-through ones are left
 * out. (From the depth alone, with normals rebuilt from it, its noise stays: tried.)
 *   radius     m around a point that can shade it; intensity: 0 none, 1 all of it
 */
export class AmbientOcclusionPass extends GTAOPass {
  constructor(scene, camera, { radius = 0.15, intensity = 1, scale = 0.5 } = {}) {
    super(scene, camera, 1, 1, undefined, { radius, screenSpaceRadius: false });
    this.blendIntensity = intensity;
    this.scale = scale;
  }

  setSize(width, height) {
    super.setSize(Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale)));
  }

  _renderOverride(renderer, material, target, clearColor, clearAlpha) {
    const swapped = [];
    this.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      swapped.push([o, o.material, o.visible]);
      if (o.material.transparent && !o.userData.normalMaterial) o.visible = false;
      else o.material = o.userData.normalMaterial ?? material;
    });
    const color = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.setRenderTarget(target);
    renderer.autoClear = false;
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
    renderer.setClearColor(color, alpha);
    for (const [o, m, visible] of swapped) {
      o.material = m;
      o.visible = visible;
    }
  }
}
