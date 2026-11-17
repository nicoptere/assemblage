import { CornerButton } from './CornerButton.js';
import { Segmented } from './Segmented.js';
import { Range } from './Range.js';
import { Switch } from './Switch.js';
import { FrameBand } from './FrameBand.js';
import { VOXEL_CM, SIZE } from '../tools/Rebuilder.js';

// "awake cap": the most bodies simulated at once (World.maxAwake), 50 to 1000, the slider's end is no cap
const AWAKE_OFF = 1050;
const awakeOf = (n) => (Number.isFinite(n) ? n : AWAKE_OFF);
const centimetres = (voxel) => Math.round(100 * voxel);

/**
 * The settings button, top right, and the card it opens: the physics engine (WebGPU greyed out
 * where the page cannot use it) and how the frame goes under it (fps, parts, vertices drawn, draw
 * calls, and where a frame's time goes: FrameBand); then the substeps a physics step takes, how
 * many of their collision samples bodies use, how many bodies may move at once (the rest sleep),
 * the walls, the effects (ambient occlusion and depth of field); the rebuild's voxel size, model
 * size, and how its parts hold. It stays open while the scene is played with
 * (Escape or the button closes it), and follows changes made elsewhere (the panels, the keys)
 * whenever it is updated. `app`: the App (its engine, world options, arena, rebuilder, stage, budget).
 */
export class Settings {
  constructor(parent, app) {
    this.app = app;
    const el = (tag, className, props) => Object.assign(document.createElement(tag), { className, ...props });
    this.el = el('div', 'settings');
    this.engine = new Segmented([
      { value: 'cpu', label: 'CPU' },
      { value: 'webgpu', label: 'WebGPU' },
    ], app.physics.backend.name, (name) => app.setEngine(name));
    this.steps = new Range({
      label: 'steps', min: 1, max: 64, step: 1, value: app.physics.substeps,
      title: 'Substeps per physics step: more is stiffer and steadier, and slower', onChange: (n) => app.setSubsteps(n),
    });
    this.samples = new Range({
      label: 'collision samples', min: 1, max: 100, step: 1, value: Math.round(100 * app.physics.world.samplePrecision),
      format: (v) => `${v}%`, title: 'The share of its surface samples each body collides with', onChange: (v) => app.setSamplePrecision(v / 100),
    });
    this.awake = new Range({
      label: 'awake cap', min: 50, max: AWAKE_OFF, step: 50, value: awakeOf(app.physics.world.maxAwake),
      format: (n) => (n >= AWAKE_OFF ? 'off' : String(n)), title: 'Beyond this many moving bodies, the calmest groups are put to sleep at once',
      onChange: (n) => app.setMaxAwake(n >= AWAKE_OFF ? Infinity : n),
    });
    this.walls = new Switch({ label: 'walls', value: app.arena, title: 'Walls around the scene', onChange: (on) => app.setArena(on) });
    this.fx = new Switch({ label: 'FX', value: app.stage.fx, title: 'Ambient occlusion and depth of field (off: faster on a slow GPU)', onChange: (on) => app.stage.setFx(on) });
    const rb = app.rebuilder;
    this.voxel = new Range({
      label: 'voxel size', min: 1, max: VOXEL_CM, step: 1, value: centimetres(rb.params.voxel), format: (cm) => `${cm} cm`,
      title: 'rebuild model precision: lower is more precise and slower to compute, higher is coarser and faster to build',
      onChange: (cm) => rb.setVoxel(cm / 100),
    });
    this.size = new Range({
      label: 'model size', ...SIZE, value: rb.params.size, format: (v) => `${v.toFixed(1)}×`,
      title: 'physical scale multiplier for the rebuilt model', onChange: (v) => rb.setSize(v),
    });
    // how the next sculptures hold once built: every part on its own anchor, or welded into pieces
    this.jointed = new Segmented([
      { value: false, label: 'Anchored', title: 'Every part held where it is by its own anchor' },
      { value: true, label: 'Jointed', title: 'Parts welded together, one anchor per piece: it comes apart where it is hit' },
    ], rb.params.jointed, (v) => rb.setJointed(v));
    const row = (label, control) => {
      const r = el('div', 'settings__row');
      r.append(el('span', 'settings__label', { textContent: label }), control.el);
      return r;
    };
    this.figures = Object.fromEntries(['fps', 'parts', 'vertices', 'draw calls'].map((name) => {
      const cell = el('div', 'settings__figure');
      const value = el('b', 'settings__value', { textContent: '–' });
      cell.append(value, el('span', 'settings__unit', { textContent: name }));
      return [name, { cell, value }];
    }));
    const figures = el('div', 'settings__figures');
    figures.append(...Object.values(this.figures).map((f) => f.cell));
    this.band = new FrameBand();
    this.el.append(
      row('engine', this.engine), figures, this.band.el, el('hr', 'settings__rule'),
      this.steps.el, this.samples.el, this.awake.el, this.walls.el, this.fx.el,
      el('div', 'settings__section', { textContent: 'rebuild' }), this.voxel.el, this.size.el, row('parts', this.jointed),
    );
    this.corner = new CornerButton(parent, this.el, { label: gear(), title: 'Settings', side: 'right', outside: false, onToggle: (on) => on && this.update() });
  }

  /** Shows the current state and figures (while open; called a few times a second). */
  update() {
    if (!this.corner.open) return;
    const { app } = this;
    const gpu = app.engines?.webgpu;
    this.engine.enable('webgpu', !!gpu?.ok, gpu?.ok ? (gpu.software ? 'a CPU emulation of a GPU here: slower than the CPU engine' : '') : `unavailable: ${gpu?.reason ?? 'checking…'}`);
    this.engine.set(app.physics.backend.name);
    this.steps.set(app.physics.substeps);
    this.samples.set(Math.round(100 * app.physics.world.samplePrecision));
    this.awake.set(awakeOf(app.physics.world.maxAwake));
    this.walls.set(app.arena);
    this.fx.set(app.stage.fx);
    this.voxel.set(centimetres(app.rebuilder.params.voxel));
    this.size.set(app.rebuilder.params.size);
    this.jointed.set(app.rebuilder.params.jointed);
    const show = (name, text) => { this.figures[name].value.textContent = text; };
    show('fps', app.fps.toFixed(0));
    show('parts', String(app.physics.world.bodies.filter((b) => b.userData?.part).length));
    show('vertices', count(app.stage.drawnVertices()));
    show('draw calls', String(app.stage.renderer.info.render.calls));
    this.band.update(app.budget);
  }
}

/** 1234 -> "1.2k", 3456789 -> "3.5M". */
function count(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

/** A cog (an SVG): `teeth` square teeth round a ring with a hole. */
function gear(teeth = 8, outer = 10.5, inner = 7.6, hole = 3.4) {
  const points = [];
  for (let k = 0; k < teeth; k++) {
    const a = (k / teeth) * 2 * Math.PI, w = Math.PI / teeth;
    for (const [r, da] of [[inner, -0.62 * w], [outer, -0.36 * w], [outer, 0.36 * w], [inner, 0.62 * w]]) points.push([12 + r * Math.cos(a + da), 12 + r * Math.sin(a + da)]);
  }
  const ring = `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`;
  const circle = `M${12 + hole} 12a${hole} ${hole} 0 1 0 ${-2 * hole} 0a${hole} ${hole} 0 1 0 ${2 * hole} 0Z`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<path fill="currentColor" fill-rule="evenodd" d="${ring}${circle}"/>`;
  return svg;
}
