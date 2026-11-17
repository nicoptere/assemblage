import { Stage } from './stage/Stage.js';
import { PhysicsLoop } from './physics/PhysicsLoop.js';
import { BodyViews } from './render/BodyViews.js';
import { DebugLayer } from './render/DebugLayer.js';
import { AssemblyModel } from './model/AssemblyModel.js';
import { DragTool } from './tools/DragTool.js';
import { Cannon } from './tools/Cannon.js';
import { Panel } from './ui/Panel.js';
import { Dismantle } from './scenarios/Dismantle.js';
import { ModelRain } from './scenarios/ModelRain.js';
import { PartRain } from './scenarios/PartRain.js';
import { Rebuilder } from './tools/Rebuilder.js';
import { FocusTool } from './tools/FocusTool.js';
import { TapTool } from './tools/TapTool.js';
import { QuickControls } from './ui/QuickControls.js';
import { Explosion } from './tools/Explosion.js';
import { LoadingBar } from './ui/LoadingBar.js';
import { LoadQueue } from './model/LoadQueue.js';
import { ByteProgress } from './model/ByteProgress.js';
import { Detonator } from './tools/Detonator.js';
import { ImpactAudio } from './audio/ImpactAudio.js';
import { loadUploadedModel } from './upload/UploadedModel.js';
import { loadUploadedTarget } from './upload/UploadedTarget.js';
import { FrameBudget } from './physics/FrameBudget.js';
import { Settings } from './ui/Settings.js';
import { exportGlb, download } from './export/GlbExport.js';
import { RigidBody, PlaneShape, Vec3 } from '@sdfphys/core';

const ARENA_CELLS = 10; // the walls' usual span, in floor grid cells

/** Wires stage, physics, model, tools and UI. Each piece only knows what it is handed. */
export class App {
  constructor(container) {
    this.stage = new Stage(container);
    this.loading = new LoadingBar(container); // the mechs, as they come
    this.physics = new PhysicsLoop({ world: { substeps: 10, samplePrecision: 0.2, maxAwake: 100 }, gpu: App.gpuOptions(new URL(window.location.href).searchParams) });
    this.budget = new FrameBudget(this.physics); // where a frame's time goes
    this.engines = { webgpu: null }; // { ok, reason, software } once probed
    this.views = new BodyViews(this.stage.scene);
    this.debug = new DebugLayer(this.stage.scene, this.views);
    this.drag = new DragTool(this.stage, () => this.physics.world);
    this.focus = new FocusTool(this.stage, () => this.physics.world);
    this.cannon = new Cannon(this.views);
    this.rig = { articulationCompliance: 1 / 5000, jointStrength: 5e6, breakable: true, limp: false };
    this.partRain = { count: 50, round: 0 }; // round: each drop is seeded differently
    this.removed = new Set(); // the parts taken out with Delete (their models' part entries): never in "add parts" again
    this.blast = { speed: 12 };
    this.explosion = new Explosion(this.stage.scene);
    this.audio = new ImpactAudio();
    this.audio.attach(this.physics.world);
    this.physics.on('reset', ({ world }) => this.audio.attach(world));
    // scenarios advance with the simulation, between two steps (a GPU step is asynchronous)
    this.physics.on('step', ({ world }) => { for (const s of this.scenarios) s.update(world); });
    this.physics.on('error', ({ error }) => {
      console.error(error);
      this.panel.setValue('Engine', 'cpu');
      this.say(`WebGPU stopped (${error.message}): back on the CPU`);
    });
    this.model = null;
    this.instance = null;
    // name -> AssemblyModel (loaded once, spawned many times): one at a time, the one wanted first
    this.mechs = new LoadQueue((name, report) => AssemblyModel.load(`models/${name}/`, new ByteProgress(report)));
    this.loading.watch(this.mechs);
    this.catalog = [];
    this.uploads = new Map(); // name -> picture (once made) of the models made at run time from mesh files
    this.extras = [];
    this.dropped = 0;
    this.scenarios = []; // running side by side (rains, dismantling, rebuilding)
    this.arena = true;
    this.arenaCells = ARENA_CELLS; // walls enclose arenaCells x arenaCells floor grid cells (more for a big rebuild)
    this.walls = [];
    this.pointer = null;
    this.profiling = false; // rendering waits while the GPU is profiled
    this._fps = 0;
    this._renders = 0;
    this._frames = 0;
    this._fpsSince = 0;

    this.panel = new Panel(container, 'SDF physics', this._controls());
    this.rebuilder = new Rebuilder({
      world: () => this.physics.world,
      scene: this.stage.scene,
      gridCell: this.stage.gridCell,
      start: (scenario) => this.startScenario(scenario),
      explode: (centre, options) => this.blastAt(centre, options),
      contain: (centre, size) => this.containArena(centre, size),
    }, container);
    this.detonator = new Detonator(this.stage, {
      world: () => this.physics.world,
      blast: (centre, radius) => this.blastAt(centre, { speed: this.blast.speed, radius }),
      sculpture: this.rebuilder,
    });
    this.detonator.onArm = (on) => this.panel.setActive('Explode', on);
    // a tap (touch screens) shoots there, a double tap or double click blows up what is there (the keys' Space and X)
    // a double tap or click: every model comes apart, then what is under the pointer blows up
    this.taps = new TapTool(this.stage.renderer.domElement, { onTap: (p) => this.shoot(p), onDoubleTap: (p) => this.detonator.at(p, () => this.takeApart()) });
    this.hint = document.createElement('div');
    this.hint.className = 'hint';
    const sep = ' &nbsp;·&nbsp; ';
    this.hint.innerHTML = window.matchMedia('(pointer: coarse)').matches
      ? ['Tap to shoot', 'Double tap to explode', 'Drag a part to pull it', 'Drag elsewhere to turn, pinch to zoom'].join(sep)
      : ['Click to focus', 'Double click to explode', 'Drag a part to pull it', '<kbd>Space</kbd> shoot at cursor', '<kbd>X</kbd> explode at cursor', '<kbd>Del</kbd> remove the part dragged', '<kbd>R</kbd> reset', '<kbd>C</kbd> clear', '<kbd>P</kbd> pause'].join(sep);
    container.appendChild(this.hint);
    this.caption = document.createElement('div');
    this.caption.className = 'caption';
    container.appendChild(this.caption);
    this.quick = new QuickControls(this, container); // the big buttons; panels and info lines behind H
    this.settings = new Settings(container, this); // top right: engine, samples, voxel size, arena, the frame's figures
    this._bindKeys();
  }

  async load(name) {
    this.model = await this._model(name);
    this.catalog = await fetch('models/index.json').then((r) => (r.ok ? r.json() : [name])).catch(() => [name]);
    this.panel.setOptions('Model', this.catalog, name);
    await this.rebuilder.load();
    this.respawn();
    // the other models load now, one at a time (the bar at the top, and Create's gallery, show them coming)
    this.mechs.add(this.catalog);
    this._offerEngines();
    this.stage.setWallMarks(this.arena ? this.arenaHalf : null);
    this._last = performance.now();
    this.stage.renderer.setAnimationLoop((t) => this._frame(t));
  }

  async switchModel(name) {
    this.model = await this._model(name);
    const url = new URL(window.location.href);
    url.searchParams.set('model', name);
    window.history.replaceState(null, '', url);
    this.respawn();
  }

  /**
   * Lists the engines, WebGPU only where the browser has it, and starts on WebGPU where it runs on a
   * GPU (a CPU emulation of one, like SwiftShader, is slower than the CPU engine), else on the CPU;
   * ?engine=cpu or ?engine=webgpu decides instead.
   */
  async _offerEngines() {
    const { ok: gpu, reason, software } = await PhysicsLoop.gpuProbe();
    this.engines.webgpu = { ok: gpu, reason, software };
    this.defaultEngine = gpu && !software ? 'webgpu' : 'cpu';
    if (!gpu) console.info(`WebGPU engine unavailable: ${reason}`);
    // a software adapter (SwiftShader) runs the GPU engine on the CPU, slower than the CPU engine
    const label = !gpu ? 'WebGPU (unavailable)' : software ? 'WebGPU (software, slow)' : 'WebGPU';
    this.panel.setOptions('Engine', [
      { value: 'cpu', label: 'CPU' },
      { value: 'webgpu', label, disabled: !gpu, title: software ? 'the browser offers WebGPU on a CPU emulation, not the GPU' : reason },
    ], this.physics.backend.name);
    this.panel.inputs.get('Engine').title = gpu ? '' : `WebGPU: ${reason}`;
    const asked = new URL(window.location.href).searchParams.get('engine');
    const start = ['cpu', 'webgpu'].includes(asked) ? asked : this.defaultEngine;
    if (gpu && start === 'webgpu') await this.setEngine('webgpu');
  }

  /**
   * WebGPU engine options from the page's URL, to compare browser behaviours without editing code:
   * ?nudge=on|off (empty submissions while a read-back is pending; default: measured),
   * ?timestamps=off (no GPU timing queries), ?ahead=N (steps in flight before waiting; default 4),
   * ?solve=split (a dispatch per solver phase instead of one for every substep).
   */
  static gpuOptions(params) {
    const options = {};
    const flag = (name) => (params.get(name) === null ? undefined : !['off', '0', 'false'].includes(params.get(name)));
    if (flag('nudge') !== undefined) options.nudge = flag('nudge');
    if (flag('timestamps') === false) options.timestamps = false;
    if (Number(params.get('ahead')) > 0) options.maxAhead = Number(params.get('ahead'));
    if (['one', 'split'].includes(params.get('solve'))) options.solve = params.get('solve');
    return options;
  }

  /** Switches the physics engine ('cpu' or 'webgpu') without touching the scene. */
  async setEngine(name) {
    try {
      await this.physics.setBackend(name);
      const url = new URL(window.location.href);
      if (name === this.defaultEngine) url.searchParams.delete('engine');
      else url.searchParams.set('engine', name);
      window.history.replaceState(null, '', url);
      this.say(name === 'webgpu' ? `engine: WebGPU on ${this.physics.backend.gpuName}` : 'engine: CPU');
    } catch (e) {
      console.error(e);
      this.panel.setValue('Engine', this.physics.backend.name);
      this.say(`WebGPU unavailable: ${e.message}`);
    }
    this.panel.setValue('Engine', this.physics.backend.name);
  }

  _model(name) {
    return this.mechs.need(name);
  }

  /** A model's picture: models/<name>/thumb.png, or the one made for an upload (null until it is). */
  modelThumb(name) {
    return this.uploads.has(name) ? this.uploads.get(name) : `models/${name}/thumb.png`;
  }

  /**
   * Adds a mesh file to the models: segmented into parts and baked (UploadedModel, in a worker),
   * it then drops, rains and rebuilds as the others do. Listed at once (its picture and progress
   * in the gallery and the bar at the top), queued after the models listed before it, and started
   * now by `mechs.need(name)`; returns its name.
   */
  uploadModel(file) {
    const name = App.uniqueName(file.name, this.catalog);
    this.catalog.push(name);
    this.uploads.set(name, null);
    this.panel.setOptions('Model', this.catalog, this.model?.name);
    this.mechs.add([name], (key, report) => loadUploadedModel(file, { name, report, onThumb: (url) => this.uploads.set(name, url) }));
    this.mechs.entry(name).promise.then((model) => {
      const { parts, joints, largest, segmentMs, bakeMs } = model.stats;
      this.loading.notice(`${name}: ${parts} parts, ${joints} joints, the largest ${(100 * largest).toFixed(0)}% of the faces (${((segmentMs + bakeMs) / 1000).toFixed(1)} s)`);
    }, (e) => {
      console.error(e);
      this.catalog.splice(this.catalog.indexOf(name), 1);
      this.uploads.delete(name);
      this.mechs.remove(name);
      this.panel.setOptions('Model', this.catalog, this.model?.name);
      this.loading.notice(`${name}: ${e.message}`);
    });
    return name;
  }

  /**
   * Takes an uploaded model away (once it is in): first every body of it in the scene, spawned whole,
   * dealt as loose parts or built into a sculpture (a build moving some of them is stopped, so they
   * land and go too), then the model: from the list, the queue, the rains to come, and its drawing.
   * A preset model stays. Returns whether it did.
   */
  removeModel(name) {
    const model = this.uploads.has(name) ? this.mechs.entry(name)?.value : null;
    if (!model) return false;
    const world = this.physics.world;
    const parts = new Set(model.assembly.parts);
    const mine = (body) => parts.has(body.userData?.part);
    const build = this.rebuilder.scenario;
    if (build && !build.done && build.moves.some((m) => mine(m.body))) this.rebuilder.stop();
    for (const body of world.bodies.filter(mine)) {
      world.removeBody(body);
      this.views.remove(body);
    }
    for (const s of this.scenarios) s.without?.(model);
    if (this.model === model) {
      this.model = this.mechs.entry(this.catalog[0])?.value ?? null; // R respawns a preset then
      this.instance = null;
    }
    model.dispose();
    for (const part of parts) this.removed.delete(part);
    this.catalog.splice(this.catalog.indexOf(name), 1);
    this.uploads.delete(name);
    this.mechs.remove(name);
    this.panel.setOptions('Model', this.catalog, this.model?.name);
    this.debug.refreshViews();
    this.loading.notice(`${name} deleted`);
    return true;
  }

  /** Adds a mesh file to the rebuild targets, as it is (no segmentation); resolves to its name. */
  async uploadTarget(file) {
    const rb = this.rebuilder;
    const name = App.uniqueName(file.name, rb.targetNames);
    try {
      const { mesh, picture } = await loadUploadedTarget(file);
      rb.addMesh(name, mesh, picture);
      return name;
    } catch (e) {
      console.error(e);
      this.loading.notice(`${name}: ${e.message}`);
      throw e;
    }
  }

  /** A file's name without its extension, numbered if `taken` has it already. */
  static uniqueName(file, taken) {
    const base = file.replace(/\.[^.]+$/, '') || 'upload';
    let name = base;
    for (let i = 2; taken.includes(name); i++) name = `${base} ${i}`;
    return name;
  }

  /** The models among `names` (the catalog's) loaded so far, or, while none is, the first of them to load. */
  _loadedModels(names = this.catalog) {
    const done = this.mechs.done.filter((name) => names.includes(name));
    const first = names.includes(this.model?.name) ? this.model.name : names[0];
    return Promise.all((done.length ? done : [first]).map((name) => this._model(name)));
  }

  respawn({ empty = false } = {}) {
    this.focus.reset();
    this.drag.forget();
    this.physics.reset();
    this.views.clear();
    this.cannon.clear();
    this.extras = [];
    this.dropped = 0;
    this.scenarios = [];
    this.rebuilder.reset();
    this.say('');
    this.arenaCells = ARENA_CELLS;
    this.stage.setWallMarks(this.arena ? this.arenaHalf : null);
    if (this.arena) this._addWalls();
    this.instance = empty ? null : this.model.spawn(this.physics.world, this.views, this._rigOptions());
    this.debug.refreshViews();
  }

  /**
   * Infinitely high walls around the origin enclosing `arenaCells` x `arenaCells` floor grid cells:
   * four static half-spaces facing inwards, outlined on the floor. Being half-spaces, they hold
   * whatever the speed (the narrowphase sweeps them in full) and push back anything inside them.
   */
  setArena(on) {
    this.arena = on;
    for (const w of this.walls) this.physics.world.removeBody(w);
    this.walls = [];
    if (on) this._addWalls();
    this.stage.setWallMarks(on ? this.arenaHalf : null);
    this.panel.setToggle('Walls', on);
  }

  /**
   * Moves the walls out (never in) so that they enclose a box (`centre`, `size`: [x, y, z] m)
   * with `margin` grid cells to spare: a rebuild bigger than the arena stays inside.
   */
  containArena(centre, size, margin = 3) {
    const cell = this.stage.gridCell;
    const reach = Math.max(Math.abs(centre[0]) + size[0] / 2, Math.abs(centre[2]) + size[2] / 2) + margin * cell;
    const cells = 2 * Math.ceil(reach / cell);
    if (cells <= this.arenaCells) return;
    this.arenaCells = cells;
    this.setArena(this.arena); // the walls and their outline again, further out
  }

  /** Distance from the centre to each wall (m). */
  get arenaHalf() {
    return 0.5 * this.arenaCells * this.stage.gridCell;
  }

  _addWalls() {
    const h = this.arenaHalf;
    this.walls = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map((n) =>
      this.physics.world.addBody(new RigidBody({ shape: new PlaneShape(n, -h), type: 'static', friction: 0.4, name: 'wall' })));
  }

  /** Runs `scenario` (update(world), label, done) alongside the others, until it is done. */
  startScenario(scenario) {
    this.scenarios.push(scenario);
    this.say(scenario.label);
    return scenario;
  }

  /**
   * Takes the part being dragged, or else the one dragged last, out of the scene (Delete or
   * Backspace): its joints and anchors go with it, the model or sculpture it was in keeps the rest,
   * and "add parts" leaves that part of its model out from then on (`removed`).
   */
  removePicked() {
    const body = this.drag.picked;
    if (!body) return;
    if (body.userData?.part) this.removed.add(body.userData.part);
    this.drag.release();
    this.drag.last = null;
    this.physics.world.removeBody(body);
    this.views.remove(body);
    this.debug.refreshViews();
  }

  /** Empties the scene: no models, no parts (the walls stay if they are on). */
  clear() {
    this.respawn({ empty: true });
  }

  /** The parts of the sculptures still standing (anchored or welded), as they are now. */
  sculptureParts() {
    const standing = this.rebuilder.sculptures.filter((s) => s.standing);
    return this.physics.world.bodies.filter((b) => standing.some((s) => s.holds(b)));
  }

  /** Saves the standing sculptures as a GLB, named after the target (GlbExport). */
  async downloadSculpture() {
    const bodies = this.sculptureParts();
    if (!bodies.length) {
      this.loading.notice('nothing rebuilt to download: rebuild a target first');
      return;
    }
    const glb = await exportGlb(bodies.map((b) => this.views.get(b)?.userData.content).filter((part) => part?.owner));
    const target = this.rebuilder.params.target.replace(/^[^:]+:\s*/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    download(new Blob([glb], { type: 'model/gltf-binary' }), `assemblage-${target}.glb`);
    this.loading.notice(`assemblage-${target}.glb: ${bodies.length} parts, ${(glb.byteLength / 1e6).toFixed(1)} MB`);
  }

  /** Drops every catalog model in turn onto the scene, inside the walls: after 0.5 s, then 3 s, then every 2 s. */
  async rain(options = {}) {
    const models = await Promise.all(this.catalog.map((name) => this._model(name)));
    this.setArena(true);
    this.startScenario(new ModelRain(models, (model, i) => this._drop(model, i), options));
  }

  /**
   * Drops `partRain.count` loose parts of the models `from` (names; the whole catalog by default) loaded so far onto
   * the scene at once, at various heights, over the arena (see PartRain), each moved in if needed so it starts
   * wholly over it (the walls on or off as they are). Parts taken out with Delete are left out (`removed`).
   */
  async rainParts({ from = this.catalog, ...options } = {}) {
    const models = await this._loadedModels(from); // not waiting for the others: they join the next drops
    const deck = models.flatMap((model) => model.assembly.parts.flatMap((part, index) => (this.removed.has(part) ? [] : [{ model, index }])));
    if (!deck.length) {
      this.say('no parts left to add: every one of these models\' parts was deleted');
      return;
    }
    const spawn = ({ model, index }, pose) => {
      const body = model.spawnPart(this.physics.world, this.views, index, pose);
      const reach = Math.max(0, this.arenaHalf - body.boundingRadius - 0.01);
      const clamp = (v) => Math.max(-reach, Math.min(reach, v));
      const p = body.position;
      const shift = new Vec3(clamp(p.x) - p.x, 0, clamp(p.z) - p.z);
      if (shift.lengthSq() > 0) body.setOrigin(body.getOrigin(new Vec3()).add(shift));
      this.debug.refreshViews();
      return body;
    };
    this.startScenario(new PartRain(deck, spawn, { count: this.partRain.count, seed: ++this.partRain.round, rate: Infinity, first: 0, spread: 1.5, radius: 0.8 * this.arenaHalf, ...options }));
  }

  /** Removes the joints of every model in the scene at once (dismantle: the same, over 2 s). */
  takeApart() {
    const world = this.physics.world;
    for (const instance of [this.instance, ...this.extras].filter(Boolean)) for (const joint of instance.intactJoints) world.removeJoint(joint);
  }

  /** Removes the joints of every model in the scene in 2 s, leg after leg, foot first, accelerating. */
  dismantle(options) {
    if (!this.instance && !this.extras.length) this.respawn();
    this.startScenario(new Dismantle([this.instance, ...this.extras].filter(Boolean), options));
  }

  /** Drops the next catalog model (or `name`) from `height` above the scene, slightly tumbled. */
  async dropModel(name = this._nextDrop(), options) {
    const instance = this._drop(await this._model(name), this.dropped, options);
    this.say(`dropping ${name}`);
    return instance;
  }

  /** Spawns a loaded model `height` above the highest body, tumbled and slightly off-centre. */
  _drop(model, i, { height = 1.0, yaw = 0.6 + 2.4 * i, tilt = 0.35, offset = 0.2 } = {}) {
    this.dropped++;
    const q = [Math.sin(tilt / 2) * Math.cos(yaw), 0, Math.sin(tilt / 2) * Math.sin(yaw), Math.cos(tilt / 2)];
    const top = Math.max(...this.physics.world.bodies.filter((b) => !b.shape.infinite).map((b) => b.aabb.max.y), 0);
    const at = [offset * Math.cos(1.7 * i), top + height, offset * Math.sin(1.7 * i)];
    // short settle window: it is in free fall, so its landing must count as an impact
    const instance = model.spawn(this.physics.world, this.views, { ...this._rigOptions(), settleTime: 0.1, at, quaternion: q });
    this.extras.push(instance);
    this.debug.refreshViews();
    return instance;
  }

  _nextDrop() {
    const others = this.catalog.filter((n) => n !== this.model.name);
    return others.length ? others[this.dropped % others.length] : this.model.name;
  }

  say(text) {
    this.caption.textContent = text;
    this.caption.hidden = !text;
  }

  _rigOptions() {
    return {
      articulationCompliance: this.rig.limp ? Infinity : this.rig.articulationCompliance,
      jointStrength: this.rig.jointStrength,
      breakable: this.rig.breakable,
    };
  }

  _applyRig() {
    const o = this._rigOptions();
    for (const instance of [this.instance, ...this.extras].filter(Boolean)) {
      instance.setArticulationCompliance(o.articulationCompliance);
      instance.setJointStrength(o.breakable ? o.jointStrength : Infinity);
      instance.wake(); // sleepers would ignore the new settings
    }
  }

  /** A blast at `centre` (see Explosion), with its boom. */
  blastAt(centre, options) {
    this.explosion.blast(this.physics.world, centre, options);
    this.audio.boom({ x: centre[0], y: centre[1], z: centre[2] }, Math.min(1, (options.speed ?? 12) / 30));
  }

  /** Fires a ball through `pointer` ({ clientX, clientY }; default: the mouse). */
  shoot(pointer = this.pointer) {
    if (pointer) this.cannon.fire(this.physics.world, this.stage.ray(pointer));
  }

  /**
   * Where the WebGPU engine's time goes, rendering paused: logged in the console and copied to
   * the clipboard (GpuProfiler.format), to paste in a report.
   */
  async profileGpu() {
    if (this.physics.backend.name !== 'webgpu') return this.say('profiling: switch the engine to WebGPU first');
    if (this.profiling) return;
    this.profiling = true;
    this.say('profiling the GPU…');
    try {
      const text = await this.physics.profileGpu();
      console.log(text);
      const copied = await navigator.clipboard?.writeText(text).then(() => true, () => false);
      this.say(`GPU profile ${copied ? 'copied to the clipboard' : 'logged'} (see the console)`);
    } catch (e) {
      console.error(e);
      this.say(`profiling failed: ${e.message}`);
    } finally {
      this.profiling = false;
      this._last = performance.now();
    }
  }

  /** Substeps per physics step (1-64: the WebGPU engine's limit). */
  setSubsteps(n) {
    this.physics.substeps = Math.max(1, Math.min(64, Math.round(n)));
    this.panel.setRange('Substeps', this.physics.substeps);
  }

  /** The most bodies simulated at once (World.maxAwake; Infinity: no cap): past it the calmest islands sleep. */
  setMaxAwake(n) {
    this.physics.configure({ maxAwake: n });
  }

  /** The share (0..1) of their collision samples bodies use (World.samplePrecision). */
  setSamplePrecision(fraction) {
    this.physics.configure({ samplePrecision: fraction });
    this.debug.refreshViews();
    this.panel.setRange('Sample precision', 100 * fraction);
  }

  togglePause(value = !this.physics.paused) {
    this.physics.paused = value;
    this.panel.setToggle('Pause', value);
  }

  _controls() {
    const debug = (label, flag) => ({ toggle: label, value: this.debug.flags[flag], onChange: (v) => {
      this.debug.set(flag, v);
      if (flag === 'contacts' && this.physics.backends.webgpu) this.physics.backends.webgpu.reportSpeed = v ? 0 : 0.3; // GPU: read back every contact
    } });
    const integer = (v) => v.toFixed(0);
    return [
      { section: 'Simulation' },
      { select: 'Engine', options: [{ value: 'cpu', label: 'CPU' }], onChange: (name) => this.setEngine(name) },
      { select: 'Model', options: [], onChange: (name) => this.switchModel(name) },
      { button: 'Reset', key: 'R', onClick: () => this.respawn() },
      { button: 'Clear', key: 'C', onClick: () => this.clear() },
      { toggle: 'Pause', key: 'P', value: false, onChange: (v) => this.togglePause(v) },
      { button: 'Step', onClick: () => this.physics.stepOnce() },
      { range: 'Substeps', value: this.physics.substeps, min: 1, max: 64, step: 1, format: integer, onChange: (v) => this.setSubsteps(v) },
      { range: 'Sample precision', unit: '%', value: 100 * this.physics.world.samplePrecision, min: 0.1, max: 100, log: true,
        onChange: (v) => this.setSamplePrecision(v / 100) },
      { toggle: 'Sleeping', value: this.physics.world.allowSleep, onChange: (v) => this.physics.configure({ allowSleep: v }) },

      { section: 'Rig' },
      { range: 'Muscle stiffness', unit: 'N·m/rad', value: 1 / this.rig.articulationCompliance, min: 10, max: 1e6, log: true,
        onChange: (v) => { this.rig.articulationCompliance = 1 / v; this._applyRig(); } },
      { toggle: 'Limp (ragdoll)', value: false, onChange: (v) => { this.rig.limp = v; this._applyRig(); } },
      { range: 'Joint strength', unit: 'Pa', value: this.rig.jointStrength, min: 1e4, max: 1e8, log: true,
        onChange: (v) => { this.rig.jointStrength = v; this._applyRig(); } },
      { toggle: 'Breakable joints', value: true, onChange: (v) => { this.rig.breakable = v; this._applyRig(); } },

      { section: 'Scenarios' },
      { button: 'Dismantle', key: 'D', onClick: () => this.dismantle() },
      { button: 'Drop another model', key: 'M', onClick: () => this.dropModel() },
      { button: 'Rain all models', key: 'A', onClick: () => this.rain() },
      { button: 'Raining parts', onClick: () => this.rainParts() },
      { range: 'Parts', value: this.partRain.count, min: 1, max: 100, step: 1, format: integer, onChange: (v) => { this.partRain.count = Math.round(v); } },
      { toggle: 'Walls', value: this.arena, onChange: (v) => this.setArena(v) },

      { section: 'Explosion' },
      // armed, the next click on the stage picks what blows up (X does it at the cursor)
      { button: 'Explode', key: 'X', onClick: () => (this.detonator.armed ? this.detonator.disarm() : this.detonator.arm()) },
      { range: 'Blast strength', unit: 'm/s', value: this.blast.speed, min: 2, max: 40, step: 1, format: integer, onChange: (v) => { this.blast.speed = v; } },

      { section: 'Sound' },
      { toggle: 'Impact sounds', value: this.audio.enabled, onChange: (v) => { this.audio.enabled = v; this.audio.unlock(); } },
      { range: 'Volume', value: this.audio.volume, min: 0, max: 1, step: 0.05, onChange: (v) => this.audio.setVolume(v) },
      { range: 'Pitch', unit: '×', value: this.audio.pitch, min: 0.5, max: 1.5, step: 0.05, onChange: (v) => { this.audio.pitch = v; } },

      { section: 'Drag' },
      { range: 'Drag force', unit: 'N', value: this.drag.options.maxForce, min: 20, max: 5000, log: true,
        onChange: (v) => { this.drag.options.maxForce = v; if (this.drag.constraint) this.drag.constraint.maxForce = v; } },

      { section: 'Cannon' },
      { range: 'Ball speed', unit: 'm/s', value: this.cannon.options.speed, min: 2, max: 80, onChange: (v) => { this.cannon.options.speed = v; } },
      { range: 'Ball radius', unit: 'm', value: this.cannon.options.radius, min: 0.01, max: 0.15, onChange: (v) => { this.cannon.options.radius = v; } },

      { section: 'View' },
      { range: 'Depth of field', value: this.stage.depthOfField * 1000, min: 0, max: 20, step: 0.5, format: (v) => (v ? v.toFixed(1) : 'off'),
        onChange: (v) => this.stage.setDepthOfField(v / 1000) },

      { section: 'Debug' },
      debug('Textured meshes', 'meshes'),
      debug('Collision samples', 'samples'),
      debug('SDF zero level', 'sdf'),
      debug('Contacts', 'contacts'),
      debug('Joints', 'joints'),
      debug('Sleeping bodies (blue)', 'sleeping'),
      { button: 'Profile GPU', onClick: () => this.profileGpu() },
    ];
  }

  _bindKeys() {
    const el = this.stage.renderer.domElement;
    // browsers start audio only after a user gesture
    // (capture phase: the drag tool and orbit controls stop pointer events on the canvas)
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    el.addEventListener('pointermove', (e) => { this.pointer = { clientX: e.clientX, clientY: e.clientY }; });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || (e.repeat && e.code !== 'Space')) return;
      if (e.code === 'Space' || e.code === 'KeyF') { e.preventDefault(); this.shoot(); }
      else if (e.code === 'KeyR') this.respawn();
      else if (e.code === 'KeyC') this.clear();
      else if (e.code === 'KeyX') this.detonator.at(this.pointer);
      else if (e.code === 'KeyG') this.quick.rebuild();
      else if (e.code === 'KeyH') this.quick.toggleChrome();
      else if (e.code === 'KeyP') this.togglePause();
      else if (e.code === 'KeyD') this.dismantle();
      else if (e.code === 'KeyM') this.dropModel();
      else if (e.code === 'KeyA') this.rain();
      else if (e.code === 'Delete' || e.code === 'Backspace') this.removePicked();
      else if (e.code === 'Escape') { this.drag.release(); this.detonator.disarm(); }
    });
  }

  get fps() {
    return this._fps;
  }

  _frame(t) {
    const start = performance.now();
    const interval = t - this._last;
    const elapsed = Math.max(0, Math.min(interval / 1000, 0.1)); // the first frame's time can come from before load() ended
    this._last = t;
    this._frames++;
    if (t - this._fpsSince > 500) {
      this._fps = (this._frames * 1000) / (t - this._fpsSince);
      this._frames = 0;
      this._fpsSince = t;
    }

    if (this.profiling) return; // the GPU is the profiler's
    this.tick(elapsed);
    if (++this._renders % 10 === 0) { // labels and stats, a few times a second (paused too)
      this._stats();
      this.quick.update();
      this.settings.update();
    }
    this.budget.end(interval, performance.now() - start);
  }

  /** Advances physics and scenarios by `elapsed` seconds and renders. Deterministic for a fixed elapsed. */
  tick(elapsed) {
    const steps = this.physics.update(elapsed); // scenarios advance on the loop's 'step' events
    if (this.scenarios.length && steps > 0) {
      // the caption follows the latest running scenario; finished ones are dropped (the last one stays for its caption)
      const running = this.scenarios.filter((s) => !s.done);
      this.say((running.at(-1) ?? this.scenarios.at(-1)).label);
      this.scenarios = running.length ? running : this.scenarios.slice(-1);
    }
    this.budget.time('marshalling', () => {
      this.views.sync();
      this.explosion.update(elapsed);
      this.cannon.update(this.physics.world.time);
      this.audio.updateListener(this.stage.camera);
      this.debug.update(this.physics.world);
      this.drag.update();
    });
    this.budget.time('render', () => this.stage.render(elapsed));
  }

  _stats() {
    const w = this.physics.world;
    const s = w.stats;
    const joints = [this.instance, ...this.extras].flatMap((i) => i?.joints ?? []); // the models' (not the rebuilds' anchors)
    const broken = joints.filter((j) => j.broken).length;
    const r = this.stage.renderer.info.render;
    this.panel.setStats([
      s.backend === 'webgpu'
        ? `${this._fps.toFixed(0)} fps   step cpu ${s.stepMs.toFixed(1)} ms, gpu ${s.gpuMs?.toFixed(1) ?? '?'} ms${this.physics.backend.adapter?.software ? ' (software GPU)' : ''}`
        : `${this._fps.toFixed(0)} fps   step ${s.stepMs.toFixed(1)} ms (cpu)`,
      // webgpu: results come back `readbackMs` after a step is queued; `waited`: a step held back for them
      `  collide ${s.collideMs.toFixed(1)}  solve ${s.solveMs.toFixed(1)} ms${s.backend === 'webgpu' && s.readbackMs ? `  read back ${s.readbackMs.toFixed(0)} ms` : ''}${s.waitMs ? `  (waited ${s.waitMs.toFixed(1)})` : ''}`,
      `draws ${r.calls}   tris ${(r.triangles / 1e3).toFixed(0)}k`,
      `bodies ${w.bodies.length - 1 - this.walls.length}   sleeping ${s.sleeping}`,
      `pairs ${s.pairs}   contacts ${s.contacts}`,
      `joints ${joints.length - broken}/${joints.length}   broken ${broken}`,
    ]);
  }
}
