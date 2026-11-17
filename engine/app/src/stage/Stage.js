import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { DepthOfFieldPass } from './DepthOfFieldPass.js';
import { AmbientOcclusionPass } from './AmbientOcclusionPass.js';
import { StudioEnvironment } from './StudioEnvironment.js';
import { WallFrame } from './WallFrame.js';
import { Ground } from './Ground.js';

// The image is tone mapped as a whole (OutputPass, ACES), background and fog included: ACES only
// reaches white for bright inputs, so the studio white is this bright before tone mapping.
const WHITE = new THREE.Color(20, 20, 20);
// the floor fades into the background from `near` m on, `density` (1/m) a metre, all white `1 / density` m further:
// half the density it had (white at 30 m, not 18), so the distance is a haze; the intro starts at `start` (all white)
const FOG = { near: 6, density: 1 / 24, start: 100 };
const FLOOR = 4 * (FOG.near + 1 / FOG.density); // m across, the floor and its grid: their edge always lost in the fog
const ORANGE = 0xffa23e; // the walls' marks on the floor
const _v = new THREE.Vector3();
const _target = new THREE.Vector3();

/**
 * Renderer, camera, controls, lights and ground: a white studio, the floor fading into the
 * background. It starts all white (the fog right at the camera) until reveal() lifts the fog.
 * Reflections come from a simple studio (StudioEnvironment). Frames go through a composer (scene,
 * ambient occlusion, depth of field, tone mapping); the depth of field focuses
 * on a chosen point (setFocus), else on what the camera orbits (the controls' target), gliding
 * there rather than jumping. Knows nothing about physics.
 */
export class Stage {
  constructor(container) {
    this.container = container;
    this.gridCell = 0.25; // m, the floor grid's cell
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = WHITE;
    this.scene.fog = new THREE.Fog(WHITE, 0, 1 / FOG.start); // all white until reveal()
    this._reveal = null; // { t, duration } while the fog lifts
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const studio = new StudioEnvironment();
    this.scene.environment = pmrem.fromScene(studio, 0.02).texture;
    this.scene.environmentIntensity = 0.6;
    studio.dispose();
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.position.set(1.6, 1.0, 1.9);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.25, 0);
    this.controls.enableDamping = true;
    this.minHeight = 0.03; // m: how low the camera may go (it orbits below its target, never below the floor)

    this._lights();
    this.scene.add(new Ground({ size: FLOOR, cell: this.gridCell }));
    this._composer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xeef2ff, 0x8a8680, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, 4, 1.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = c.bottom = -2;
    c.right = c.top = 2;
    c.near = 0.5;
    c.far = 10;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
  }

  /** Lifts the fog from all white (FOG.start) to its usual distance and density in `duration` seconds, `delay` seconds from now. */
  reveal(duration = 1.5, delay = 0) {
    this._reveal = { t: -delay, duration };
  }

  _lift(elapsed) {
    const r = this._reveal;
    if (!r) return;
    r.t = Math.min(r.duration, r.t + Math.max(0, elapsed));
    const k = (Math.max(0, r.t) / r.duration) ** 2; // slow at first: the scene comes out of the white, nearest first
    const depth = (1 - k) / FOG.start + k / FOG.density; // m from where it starts to all white: 1 / its density
    this.scene.fog.near = FOG.near * k;
    this.scene.fog.far = this.scene.fog.near + depth;
    if (r.t >= r.duration) this._reveal = null;
  }

  /** The walls' marks on the floor, the walls `half` m from the centre (null hides them): a striped frame a grid cell wide outside them, lined along them. */
  setWallMarks(half) {
    this.wallFrame ??= new WallFrame(this.scene, { cell: this.gridCell, color: ORANGE });
    this.wallFrame.set(half);
  }

  /**
   * Scene -> ambient occlusion -> depth of field -> tone mapping and sRGB (OutputPass), multisampled;
   * the depth of field on the depth the scene was rendered with (render()).
   */
  _composer() {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(1, 1) });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new AmbientOcclusionPass(this.scene, this.camera);
    this.composer.addPass(this.ao);
    this.bokeh = new DepthOfFieldPass(this.camera, { focus: 2.7, aperture: 0, maxblur: 0.012 });
    this.composer.addPass(this.bokeh);
    this.composer.addPass(new OutputPass());
    this.renderer.info.autoReset = false; // the stats count the whole frame, not its last pass
    this.focus = null;
    this.focusTime = 0.15; // s: time constant of the focus glide (95% of the way in 0.45 s)
    this._focusPoint = null; // where the focus is now, on its way to the target
    this.fx = true; // the occlusion and the depth of field (setFx)
    this.setDepthOfField(0.003);
  }

  /** The effects on or off: ambient occlusion and depth of field (Settings' "FX"; off, a slow GPU draws the scene alone). */
  setFx(on) {
    this.fx = on;
    this.ao.enabled = on;
    this.setDepthOfField(this.depthOfField);
  }

  /** The point to keep sharp: a function returning { x, y, z } every frame, or null for the orbit target. */
  setFocus(point) {
    this.focus = point;
  }

  /** Blur per metre away from the focus (0: off). */
  setDepthOfField(aperture) {
    this.depthOfField = aperture;
    this.bokeh.enabled = this.fx && aperture > 0;
    this.bokeh.uniforms.aperture.value = aperture;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** World-space ray through a pointer event. */
  ray(event, out = new THREE.Ray()) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const caster = new THREE.Raycaster();
    caster.setFromCamera(ndc, this.camera);
    return out.copy(caster.ray);
  }

  /**
   * The orbit may pass under its target but not under the floor: the lowest angle it may reach
   * puts the camera `minHeight` over the floor, at its distance from the target (on or over the floor).
   */
  _keepAboveFloor() {
    const { target } = this.controls;
    if (target.y < 0) target.y = 0; // panned down: back on the floor
    const r = this.camera.position.distanceTo(target);
    this.controls.maxPolarAngle = Math.acos(Math.min(1, Math.max(-1, (this.minHeight - target.y) / (r || 1))));
  }

  /** Vertices of everything visible (instanced geometry's times its instances; the shadow pass not counted). */
  drawnVertices() {
    let n = 0;
    this.scene.traverseVisible((o) => {
      const g = (o.isMesh || o.isLine || o.isPoints) && o.geometry;
      if (!g?.attributes.position) return;
      n += g.attributes.position.count * (o.isInstancedMesh ? o.count : g.isInstancedBufferGeometry ? g.instanceCount : 1);
    });
    return n;
  }

  /** Renders a frame `elapsed` seconds after the last one. */
  render(elapsed = 1 / 60) {
    this._lift(elapsed);
    this._keepAboveFloor();
    this.controls.update();
    if (this.camera.position.y < this.minHeight) this.camera.position.y = this.minHeight; // a zoom since
    // the focus point glides to its target in world space (following a moving part as it goes);
    // the bokeh shader compares view depths, so what it gets is that point's depth along the view
    const p = this.focus?.() ?? this.controls.target;
    _target.set(p.x, p.y, p.z);
    if (!this._focusPoint) this._focusPoint = _target.clone();
    else this._focusPoint.lerp(_target, 1 - Math.exp(-Math.min(elapsed, 0.1) / this.focusTime));
    this.camera.updateMatrixWorld();
    this.bokeh.uniforms.focus.value = Math.max(this.camera.near, -_v.copy(this._focusPoint).applyMatrix4(this.camera.matrixWorldInverse).z);
    this.renderer.info.reset();
    this.bokeh.depth = this.composer.readBuffer.depthTexture; // where the scene renders this frame (the first pass's buffer: the occlusion writes to the other)
    this.composer.render();
  }
}
