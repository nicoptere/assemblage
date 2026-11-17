import { Quat, Vec3 } from '@sdfphys/core';
import { partStencil, FIT_DEFAULTS } from '@sdfphys/core/fit';
import { loadTargetMesh, ghostMesh, voxelMesh, PRIMITIVES } from '../model/TargetMesh.js';
import { LoadQueue } from '../model/LoadQueue.js';
import { Rebuild } from '../scenarios/Rebuild.js';
import { FitWorker } from './FitWorker.js';
import { Panel } from '../ui/Panel.js';

const HOLLOW_MIN = 0.15; // m
export const SIZE = { min: 0.2, max: 10, step: 0.1 }; // the target's size, × the parts' volume (the panel's slider, and the settings')
export const VOXEL_CM = 10; // cm: the coarsest fit (the panel's and Settings' voxel size run from 1 cm to it, in whole cm)
const STRENGTH_SIZE = 1; // m: the strengths are for a sculpture up to this big; a bigger one gets them in proportion
const VOLUME_VOXEL = 0.02; // m: the parts' volume (which sizes the target) is measured at this resolution
const DEFAULT_TARGET = 'taschen: armadillo';
const integer = (v) => v.toFixed(0);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const litres = (m3) => `${(m3 * 1000).toFixed(m3 < 0.01 ? 1 : 0)} L`;

/**
 * Rebuilds a target shape out of the parts lying in the scene, from its own floating panel.
 *   preview   every change of the target, size, voxel, shell or turn rebuilds the target
 *             in a worker and shows it at once: its outline and its voxel skin (the latest
 *             settings win; previews never wait for each other)
 *   generate  a second worker fits the parts into that same target (ShapeFit, big parts first)
 *             and reports each part as soon as it has a pose: it flies there right away (Rebuild),
 *             so the sculpture grows while the fit goes on. Generating again, Release, Explode
 *             or a new scene stop the fit; parts already on their way land.
 * The target holds `size` x the parts' volume and stands on the ground over the arena centre; a
 * target bigger than the parts is hollowed to a shell they can cover (at least HOLLOW_MIN thick).
 * Generating again rebuilds from all parts, the anchored ones included; when that fit ends, the
 * earlier sculptures' parts it did not use are let go (they would stay anchored in mid-air).
 * A finished sculpture is welded together and keeps one anchor per piece (see Rebuild), unless
 * `jointed` is off: then every part keeps its own anchor and nothing is welded. A sculpture
 * bigger than STRENGTH_SIZE gets its anchors and welds that much stronger, and the arena's walls
 * move out to hold it (env.contain).
 * Release, Explode, "Anchor strength" and "Joint strength" apply to every sculpture still standing.
 * `env`: { world() -> World, scene, start(scenario), explode(centre, options), contain(centre, size) }.
 */
export class Rebuilder {
  constructor(env, container) {
    this.env = env;
    this.params = {
      target: DEFAULT_TARGET,
      size: 2,
      voxel: 0.02, // m: the fit's resolution (Settings' "voxel size")
      shell: 0.1, // m: thickness given to open surfaces
      yaw: 0,
      orientations: 64,
      outside: 1.5,
      overlap: 2,
      minGain: FIT_DEFAULTS.minGain,
      strength: 2000, // N (and N m): an anchor breaks beyond it
      weld: 1000, // N (and N m): a weld between two parts of a finished sculpture breaks beyond it
      jointed: false, // a finished sculpture is welded together (else, the default: anchored, every part on its own anchor)
      interval: 0, // s between two parts setting off (0: as soon as the fit places them)
      ghost: false,
      blast: 20, // m/s at the centre
    };
    this.sculpture = null; // { centre, size } of the target being built
    // target name -> { V, F }: all of them load in turn once listed, the one wanted first
    this.meshes = new LoadQueue((name, report) => loadTargetMesh(`${this.base}${this.targets.find((t) => t.name === name).file}`, report));
    this.targets = []; // [{ name, file, thumb? }] from targets/index.json
    this.onTarget = () => {}; // called with the target's name when it changes
    this.scenario = null; // the latest build
    this.sculptures = []; // every build whose anchors may still stand (the latest last)
    this.views = { outline: null, voxels: null };
    this.previewer = new FitWorker();
    this.builder = new FitWorker();
    this.building = false;
    this._build = 0; // id of the running build (a stopped one ignores its late messages)
    this._preview = { running: false, again: false };
    this._parts = -1; // part count the preview was made for
    this.panel = new Panel(container, 'Rebuild', this._controls(), { side: 'left' });
    this.panel.setStats(['Pick a target: its shape shows here;', 'Generate fits the parts into it.']);
    setInterval(() => this._watch(), 1500);
  }

  /** Reads the target list (public/targets/index.json: [{ name, file, thumb? }]), after the primitives (PRIMITIVES). */
  async load(base = 'targets/') {
    this.base = base;
    const listed = await fetch(`${base}index.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    this.targets = [...PRIMITIVES.map(({ name, thumb }) => ({ name, thumb })), ...listed];
    if (!this.has(this.params.target)) this.params.target = this.targets[0]?.name ?? null;
    this._list();
    this.refresh();
    for (const { name, mesh } of PRIMITIVES) this.meshes.add([name], mesh);
    this.meshes.add(listed.map((t) => t.name));
  }

  /** A target given as a mesh ({ V, F }, an upload), with its picture (a URL); listed after the others. */
  addMesh(name, mesh, image = null) {
    this.targets.push({ name, image });
    this.meshes.add([name], () => mesh);
    this._list();
  }

  has(name) {
    return this.targets.some((t) => t.name === name);
  }

  get targetNames() {
    return this.targets.map((t) => t.name);
  }

  /** The picture of target `name`, if it has one (targets/thumbs, or an upload's). */
  thumb(name) {
    const t = this.targets.find((e) => e.name === name);
    return t?.image ?? (t?.thumb ? `${this.base}${t.thumb}` : null);
  }

  setTarget(name) {
    if (!this.has(name)) return;
    this.params.target = name;
    this.panel.setValue('Target', name);
    this.onTarget(name);
    this.refresh();
  }

  _list() {
    this.panel.setOptions('Target', this.targetNames, this.params.target);
  }

  /** What the build is doing: null when idle, else { placed, total } of the running build. */
  get progress() {
    const s = this.scenario;
    if (!s || (s.done && !this.building)) return null;
    return { placed: s.arrived.length, total: s.total };
  }

  /** Forgets the sculpture (the world was rebuilt). */
  reset() {
    this.stop();
    this.scenario = null;
    this.sculptures = [];
    this.sculpture = null;
    this.refresh();
  }

  // ---- preview ------------------------------------------------------------------------------

  /** Shows the target the current settings would build. Calls while one is computed coalesce. */
  async refresh() {
    const pv = this._preview;
    if (pv.running) {
      pv.again = true;
      return;
    }
    pv.running = true;
    try {
      do {
        pv.again = false;
        const job = await this._job();
        if (!job) break;
        const t = await this.previewer.target(job.name, job.mesh, job.place);
        if (pv.again || this.building) continue;
        this._parts = job.bodies.length;
        this._show(t, job.mesh, true);
        this.panel.setStats([
          `target ${t.size.map((v) => v.toFixed(2)).join(' × ')} m`,
          `${t.count.toLocaleString()} voxels of ${(t.voxel * 100).toFixed(1)} cm (${litres(t.volume)})`,
          `${job.bodies.length} parts, ${litres(job.place.volume)}`,
          'Generate to build it',
        ]);
      } while (pv.again);
    } catch (e) {
      this.panel.setStats([`preview failed: ${e.message}`]);
      console.error(e);
    } finally {
      pv.running = false;
    }
  }

  /** Keeps the preview in step with the scene: parts rained in, dropped or removed. */
  _watch() {
    if (this.building || (this.scenario && !this.scenario.done) || !this.params.ghost || this._preview.running) return;
    if (this._parts !== this._bodies().length) this.refresh();
  }

  _bodies() {
    return this.env.world().bodies.filter((b) => b.userData?.part && b.type === 'dynamic');
  }

  /** What a build or a preview with the current settings needs: the target mesh, where it goes, the parts. */
  async _job() {
    const p = this.params;
    const name = p.target;
    if (!name || !this.has(name)) return null; // the list is not loaded yet
    const mesh = await this._mesh(name);
    if (!mesh) {
      this._clearViews();
      this.panel.setStats(['no target mesh']);
      return null;
    }
    const bodies = this._bodies();
    if (!bodies.length) {
      this._clearViews();
      this.panel.setStats(['no parts in the scene:', 'rain some parts or drop models first']);
      this._parts = 0;
      return null;
    }
    const volume = bodies.reduce((s, b) => s + partStencil(b.shape, b.com, VOLUME_VOXEL).volume, 0);
    const place = { volume, size: p.size, voxel: p.voxel, shell: p.shell, yaw: (p.yaw * Math.PI) / 180, floor: 0, minThickness: HOLLOW_MIN };
    return { name, mesh, bodies, place };
  }

  /** Draws a target: its outline (if "Show target"), and its voxel skin while previewing. */
  _show(t, mesh, voxels) {
    this._clearViews();
    const scene = this.env.scene;
    this.views.outline = ghostMesh(t.vertices, mesh.F);
    this.views.outline.visible = this.params.ghost;
    scene.add(this.views.outline);
    if (voxels) {
      this.views.voxels = voxelMesh(t.surface, t.voxel);
      this.views.voxels.visible = this.params.ghost;
      scene.add(this.views.voxels);
    }
  }

  _clearViews() {
    for (const key of Object.keys(this.views)) {
      const v = this.views[key];
      if (!v) continue;
      this.env.scene.remove(v);
      v.geometry.dispose();
      v.material.dispose();
      v.dispose?.();
      this.views[key] = null;
    }
  }

  // ---- build --------------------------------------------------------------------------------

  /** Fits the parts into the selected target and builds it (see the class). */
  async generate() {
    this.stop();
    const job = await this._job();
    if (!job) return;
    const p = this.params;
    const world = this.env.world();
    const id = ++this._build;
    this.building = true;
    const t0 = performance.now();
    this.panel.setStats(['measuring the parts…']);
    await nextFrame();
    if (id !== this._build) return;
    const stencils = job.bodies.map((b) => partStencil(b.shape, b.com, p.voxel));
    const anchor = world.bodies.find((b) => b.name === 'ground') ?? world.bodies.find((b) => b.type === 'static');
    const strength = p.strength, weld = p.jointed ? p.weld : 0;
    const scenario = (this.scenario = new Rebuild([], { anchor, interval: p.interval, strength, weld, reach: p.voxel }));
    this.sculptures.push(scenario);
    this.env.start(scenario);
    const fit = { orientations: p.orientations, outside: p.outside, overlap: p.overlap, minGain: p.minGain };
    let target = null;
    const progress = (m) => [
      `fitting part ${m.done}/${m.total}: ${m.placed} placed`,
      `${scenario.arrived.length} in place, ${scenario.total - scenario.arrived.length} on their way`,
      `${target.size.map((v) => v.toFixed(2)).join(' × ')} m, ${target.count.toLocaleString()} voxels`,
    ];
    try {
      const done = await this.builder.fit(job.name, job.mesh, job.place, stencils, fit, (m) => {
        if (id !== this._build) return;
        if (m.type === 'target') {
          target = m;
          this.sculpture = { centre: m.centre, size: Math.max(...m.size) };
          scenario.setScale(Math.max(1, this.sculpture.size / STRENGTH_SIZE));
          this.env.contain?.(m.centre, m.size);
          this._show(m, job.mesh, false);
          this.panel.setStats(['fitting the first part…']);
          return;
        }
        if (m.type === 'place') {
          const body = job.bodies[m.placement.index];
          if (world.bodies.includes(body)) scenario.add({ body, position: Vec3.from(m.placement.position), quaternion: Quat.from(m.placement.quaternion) });
        }
        this.panel.setStats(progress(m));
      });
      if (id !== this._build) return;
      this._letGo(scenario);
      const { stats } = done;
      this.panel.setStats([
        `${done.placed} of ${job.bodies.length} parts placed`,
        `IoU ${stats.iou.toFixed(2)}   target filled ${(100 * stats.coverage).toFixed(0)}%`,
        `${target.size.map((v) => v.toFixed(2)).join(' × ')} m`,
        `fit ${((performance.now() - t0) / 1000).toFixed(1)} s (${target.grid.join('×')} voxels)`,
      ]);
    } catch (e) {
      if (e.message === 'cancelled') return;
      this.panel.setStats([`failed: ${e.message}`]);
      console.error(e);
    } finally {
      if (id === this._build) {
        scenario.close();
        this.building = false;
      }
    }
  }

  /** Stops a running fit; the parts already flying land, the build takes no more (a model taken away: App.removeModel). */
  stop() {
    if (this.building) {
      this._build++;
      this.builder.cancel();
      this.building = false;
    }
    if (this.scenario && !this.scenario.done) this.scenario.finish(this.env.world());
  }

  /** Earlier sculptures' parts that `latest` does not use fall (those it uses fly from where they stand). */
  _letGo(latest) {
    const world = this.env.world();
    for (const s of this.sculptures) if (s !== latest) s.release(world, latest.bodies);
    this.sculptures = this.sculptures.filter((s) => s === latest || s.standing);
  }

  release() {
    this.stop();
    for (const s of this.sculptures) s.release(this.env.world());
    this.sculptures = this.scenario ? [this.scenario] : [];
  }

  /** Whether `body` is anchored or welded in a sculpture. */
  holds(body) {
    return this.sculptures.some((s) => s.holds(body));
  }

  setStrength(strength) {
    this.params.strength = strength;
    for (const s of this.sculptures) s.setStrength(strength);
  }

  /** The fit's resolution (m): the target is voxelised again, its preview shown. */
  setVoxel(voxel) {
    this.params.voxel = voxel;
    this.panel.setRange('Voxel', voxel * 100);
    this.refresh();
  }

  /** The target's size, × the parts' volume (the preview follows). */
  setSize(size) {
    this.params.size = size;
    this.panel.setRange('Size', size);
    this.refresh();
  }

  /** Whether the next sculptures are welded together (else every part keeps its own anchor). */
  setJointed(jointed) {
    this.params.jointed = jointed;
    this.panel.setToggle('Jointed', jointed);
  }

  setWeld(weld) {
    this.params.weld = weld;
    for (const s of this.sculptures) s.setWeld(weld);
  }

  /** Releases the sculpture and blows it apart from its centre. */
  explode() {
    if (!this.sculpture) return;
    this.release();
    this.env.explode(this.sculpture.centre, { speed: this.params.blast, radius: 0.75 * this.sculpture.size + 0.3, lift: 0.1 });
  }

  _mesh(name) {
    return this.meshes.need(name);
  }

  _controls() {
    const p = this.params;
    const set = (key, k = 1) => (v) => { p[key] = v * k; };
    const shape = (key, k = 1) => (v) => { p[key] = v * k; this.refresh(); }; // settings the preview shows
    const show = (v) => {
      p.ghost = v;
      for (const view of Object.values(this.views)) if (view) view.visible = v;
      if (v) this.refresh();
    };
    return [
      { select: 'Target', options: [], onChange: (v) => this.setTarget(v) },
      { range: 'Size', unit: '× parts', value: p.size, ...SIZE, onChange: (v) => this.setSize(v) },
      { range: 'Voxel', unit: 'cm', value: p.voxel * 100, min: 1, max: VOXEL_CM, step: 1, format: integer, onChange: (v) => this.setVoxel(v / 100) },
      { range: 'Shell', unit: 'cm', value: p.shell * 100, min: 2, max: 40, step: 1, format: integer, onChange: shape('shell', 0.01) },
      { range: 'Turn', unit: '°', value: p.yaw, min: 0, max: 360, step: 15, format: integer, onChange: shape('yaw') },
      { toggle: 'Show target', value: p.ghost, onChange: show },
      { section: 'Fit' },
      { range: 'Orientations', value: p.orientations, min: 4, max: 128, step: 4, format: integer, onChange: set('orientations') },
      { range: 'Stay inside', value: p.outside, min: 0, max: 3, step: 0.1, onChange: set('outside') },
      { range: 'Overlap penalty', value: p.overlap, min: 0, max: 2, step: 0.1, onChange: set('overlap') },
      { range: 'Min fit', value: p.minGain, min: 0, max: 0.9, step: 0.05, onChange: set('minGain') },
      { section: 'Assembly' },
      { range: 'Part interval', unit: 's', value: p.interval, min: 0, max: 1, step: 0.05, onChange: set('interval') },
      { range: 'Anchor strength', unit: 'N', value: p.strength, min: 20, max: 1e6, log: true, onChange: (v) => this.setStrength(v) },
      { toggle: 'Jointed', value: p.jointed, onChange: (v) => this.setJointed(v) },
      { range: 'Joint strength', unit: 'N', value: p.weld, min: 20, max: 1e6, log: true, onChange: (v) => this.setWeld(v) },
      { button: 'Generate', key: 'G', onClick: () => this.generate() },
      { button: 'Release', onClick: () => this.release() },
      { button: 'Explode', onClick: () => this.explode() },
      { range: 'Blast strength', unit: 'm/s', value: p.blast, min: 2, max: 40, step: 1, format: integer, onChange: set('blast') },
    ];
  }
}
