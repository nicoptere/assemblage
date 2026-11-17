import { ShaderMaterial, UniformsUtils } from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { BokehShader } from 'three/addons/shaders/BokehShader.js';

/**
 * Depth of field (three's bokeh shader) on the depth the scene was rendered with: the composer's
 * render targets carry a depth texture. three's BokehPass renders the whole scene a second time
 * for its depth instead, which with many triangles costs as much as the scene itself.
 * uniforms: focus (view depth, m), aperture (blur per metre away from it), maxblur. `depth`: the
 * scene's depth texture when a pass before this one wrote elsewhere (else the read buffer's).
 */
export class DepthOfFieldPass extends Pass {
  constructor(camera, { focus = 1, aperture = 0.025, maxblur = 0.01 } = {}) {
    super();
    this.camera = camera;
    this.material = new ShaderMaterial({
      name: 'DepthOfField',
      defines: { DEPTH_PACKING: 0, PERSPECTIVE_CAMERA: 1 },
      uniforms: UniformsUtils.clone(BokehShader.uniforms),
      vertexShader: BokehShader.vertexShader,
      fragmentShader: BokehShader.fragmentShader,
    });
    this.uniforms = this.material.uniforms;
    Object.assign(this.uniforms, { focus: { value: focus }, aperture: { value: aperture }, maxblur: { value: maxblur } });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = this.depth ?? readBuffer.depthTexture;
    u.aspect.value = this.camera.aspect;
    u.nearClip.value = this.camera.near;
    u.farClip.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
