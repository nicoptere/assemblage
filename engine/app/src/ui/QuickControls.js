import { ActionBar } from './ActionBar.js';
import { Gallery } from './Gallery.js';
import { pickFiles, dropFiles } from '../upload/FilePicker.js';
import { UploadProgress } from './UploadProgress.js';
import { MESH_FILES } from '../upload/MeshFile.js';
import { CLEAR, DOWNLOAD } from './icons.js';

const UPLOAD = Symbol('upload'); // the galleries' last tile: your own mesh
const uploadTile = (note) => ({ value: UPLOAD, label: 'upload', glyph: '↑', note, className: 'gallery__tile--upload' });
const short = (name) => name?.replace(/^[^:]+:\s*/, '') ?? '';

/**
 * The app as most people use it: big buttons along the bottom.
 *   create     drops the chosen mech; held: a gallery of the mechs, picking one drops it, in tabs:
 *              "preset" (the catalog's) and, once something is uploaded, "custom" (the uploads)
 *   rebuild    rebuilds the chosen target from the parts in the scene; held: a gallery of the
 *              targets (the primitives first), picking one rebuilds it (how big, and how it holds: Settings)
 *   add 50 parts  drops loose parts of the models in Create's tab last picked (`tab`), all at once
 *   clear (a bin) empties the scene
 *   download (an icon) saves the sculpture standing as a GLB (App.downloadSculpture); off while there is none
 * A rebuild starts `wait` ms after the click (the gallery has gone by then): a sculpture still
 * standing is blown up, and the build starts `delay` ms after the blast.
 * "Held" is a long press or a right click (ActionBar); with a mouse, resting on create or rebuild
 * opens its gallery too. The galleries stand above their button; clicking a button closes them. The panels and info lines stay hidden
 * behind H (App.quick.toggleChrome).
 * Each gallery ends with an upload tile: mesh files of yours (MESH_FILES, one or more) become
 * models, split into parts (App.uploadModel) one after the other while a card in the middle shows
 * how each goes (UploadProgress), or targets, as they are (App.uploadTarget). Files dropped
 * anywhere on the page are models, or targets while the targets' gallery is open.
 * `app`: the App (its scene actions, physics loop, stage, rebuilder, model catalog).
 */
export class QuickControls {
  constructor(app, container, { wait = 500, delay = 750 } = {}) {
    this.app = app;
    this.container = container;
    this.wait = wait;
    this.delay = delay;
    this.gallery = new Gallery(container);
    this.uploads = new UploadProgress(container, app.mechs, (name) => app.modelThumb(name));
    this._later = 0;
    this.model = null; // the mech "create" drops (until chosen: the one the app started with)
    this.tab = 'preset'; // Create's gallery tab last picked: what "add parts" draws from
    app.rebuilder.onTarget = () => this._target();

    this.bar = new ActionBar(container, [
      { id: 'model', caption: 'create', label: '', fit: true, onClick: () => this.create(), onHold: (b) => this.pickModel(b), onHover: (b) => this.pickModel(b, true) },
      { id: 'target', caption: 'rebuild', label: '', fit: true, onClick: () => this.rebuildTarget(), onHold: (b) => this.pickTarget(b), onHover: (b) => this.pickTarget(b, true) },
      { id: 'parts', caption: 'add 50', label: 'parts', title: 'Drop random loose parts of the models in Create\'s tab', onClick: () => app.rainParts({ from: this.tabModels }) },
      { id: 'clear', icon: CLEAR, title: 'Empty the scene (C)', onClick: () => app.clear() },
      { id: 'download', icon: DOWNLOAD, title: 'Download the rebuilt model as a GLB file', onClick: () => app.downloadSculpture() },
    ].map((item) => ({ ...item, onClick: () => { this.gallery.close(); item.onClick(); } }))); // a click closes any open gallery
    app.mechs.onChange((entry) => { if (entry.key === this.modelName) this._model(); }); // an upload's progress
    dropFiles(container, (files) => {
      const targets = this.gallery.isOpen && this.gallery.anchor === this.bar.buttons.get('target');
      this.gallery.close();
      if (targets) this.uploadTargets(files);
      else this.uploadModels(files);
    }, () => app.loading.notice('the browser gave no file for that drop (a link, or a folder it may not read): use the upload tile', 9000));
    this.update();
  }

  toggleChrome(on = !this.container.classList.contains('chrome')) {
    this.container.classList.toggle('chrome', on);
  }

  /** The catalog's models (Create's "preset" tab), and the uploaded ones ("custom"). */
  get presets() {
    return this.app.catalog.filter((name) => !this.app.uploads.has(name));
  }

  get customs() {
    return this.app.catalog.filter((name) => this.app.uploads.has(name));
  }

  /** The models of Create's tab last picked (the presets while there is no upload). */
  get tabModels() {
    return this.tab === 'custom' && this.customs.length ? this.customs : this.presets;
  }

  /** The mech "create" drops: the one chosen, else the one the app started with. */
  get modelName() {
    return this.model ?? this.app.model?.name ?? null;
  }

  /** Drops the chosen mech. */
  create() {
    if (this.modelName) this.app.dropModel(this.modelName);
  }

  /**
   * The gallery of mechs above `anchor` (the button), opened by a long press or, with `hover`, by
   * the mouse resting on it; picking one drops it (and "create" drops it from then on).
   */
  async pickModel(anchor = null, hover = false) {
    if (this._showing(anchor, hover)) return;
    const mechs = this.app.mechs;
    // a mech can be picked once loaded (its picture greys until then; its entry is the queue's, kept up to date)
    const item = (name) => ({ value: name, label: name, image: this.app.modelThumb(name), status: mechs.entry(name) ?? { state: 'waiting' }, waits: true });
    // an upload, once in, has a bin: it goes, with all of it in the scene
    const custom = (name) => ({ ...item(name), ...(mechs.entry(name)?.state === 'done' ? { remove: () => this.removeModel(name) } : {}) });
    const tab = (value, names, make = item) => ({ value, label: value, items: [...names.map(make), uploadTile('split into parts')] });
    const tabs = [tab('preset', this.presets), ...(this.customs.length ? [tab('custom', this.customs, custom)] : [])];
    const choice = await this._open(mechs, { tabs, tab: this.tab, onTab: (t) => { this.tab = t; }, value: this.modelName, anchor, hover });
    if (choice === null) return;
    if (choice === UPLOAD) {
      this.uploadModels();
      return;
    }
    this.model = choice;
    this._model();
    this.create();
  }

  /**
   * Mesh files (asked for if not given) as models: all listed at once in Create's "custom" tab (the
   * tab picked from then on), the card showing how each goes, and split one after the other (each
   * in a worker of its own); the first is chosen at once (its button shows how it goes too) and
   * dropped once it is in.
   */
  async uploadModels(files = null) {
    files ??= await pickFiles(MESH_FILES.join(','));
    if (!files.length) return;
    const names = files.map((file) => this.app.uploadModel(file));
    this.uploads.track(names);
    this.tab = 'custom';
    this.model = names[0];
    this._model();
    for (const name of names) {
      try {
        await this.app.mechs.need(name);
      } catch {
        if (this.model === name) this.model = null; // it failed (the card says why)
        this._model();
        continue;
      }
      if (name === names[0] && this.model === name) this.create();
    }
  }

  /** Takes an uploaded model away, with all of it in the scene (App.removeModel); Create falls back to the start model if it was chosen. */
  removeModel(name) {
    if (!this.app.removeModel(name)) return;
    if (this.model === name) this.model = null;
    this._model();
  }

  /** Mesh files (asked for if not given) as rebuild targets, the first rebuilt at once. */
  async uploadTargets(files = null) {
    files ??= await pickFiles(MESH_FILES.join(','));
    let first = null;
    for (const file of files) { // in turn: each name is made unique against those listed before it
      const name = await this.app.uploadTarget(file).catch(() => null);
      if (name && !first) this._rebuildAs((first = name));
    }
  }

  /** Opens the gallery with `options`, its tiles following `queue`'s loads while it is open. */
  async _open(queue, options) {
    const stop = queue.onChange((entry) => this.gallery.setStatus(entry.key, entry));
    try {
      return await this.gallery.open(options);
    } finally {
      stop();
    }
  }

  /** Whether `anchor`'s gallery is open already (pinned, if this is a long press or a right click). */
  _showing(anchor, hover) {
    if (!anchor || !this.gallery.isOpen || this.gallery.anchor !== anchor) return false;
    if (!hover) this.gallery.pin();
    return true;
  }

  /** Rebuilds the chosen target. */
  rebuildTarget() {
    this.rebuild();
  }

  /** The gallery of targets above `anchor`, as pickModel's; picking one rebuilds it from the parts in the scene. */
  async pickTarget(anchor = null, hover = false) {
    if (this._showing(anchor, hover)) return;
    const rb = this.app.rebuilder;
    // a model can be picked while it loads: it comes next, and is built once in
    const items = rb.targetNames.map((name) => ({ value: name, label: short(name), image: rb.thumb(name), status: rb.meshes.entry(name) ?? { state: 'waiting' } }));
    items.push(uploadTile('as it is'));
    const choice = await this._open(rb.meshes, { items, value: rb.params.target, anchor, hover });
    if (choice === null) return;
    if (choice === UPLOAD) this.uploadTargets();
    else this._rebuildAs(choice);
  }

  /** Makes `name` the target and rebuilds it (its mesh loads ahead of the others). */
  _rebuildAs(name) {
    const rb = this.app.rebuilder;
    rb.meshes.need(name).catch(() => {});
    rb.setTarget(name);
    this.rebuild();
  }

  /** Builds the target `wait` ms from now; a sculpture still standing is blown up then, and the build starts `delay` ms after the blast. */
  rebuild() {
    const rb = this.app.rebuilder;
    clearTimeout(this._later);
    this._later = setTimeout(() => {
      if (!rb.sculptures.some((s) => s.standing)) {
        rb.generate();
        return;
      }
      rb.explode();
      this._later = setTimeout(() => rb.generate(), this.delay);
    }, this.wait);
  }

  /** Labels that follow the state: the target (its list loads late), the build's progress. Called a few times a second. */
  update() {
    this.bar.set('parts', { caption: `add ${this.app.partRain.count}` });
    this.bar.set('download', { disabled: !this.app.rebuilder.sculptures.some((s) => s.standing) });
    this._model();
    this._target();
  }

  /** The model button: the chosen model's picture and name (and how far it is, while an upload is split). */
  _model() {
    const name = this.modelName;
    const e = name && this.app.mechs.entry(name);
    // its name (cut short if long: the button keeps its size), or while it is made, only how far
    const label = e?.state === 'loading' && e.note ? `${Math.round(100 * e.progress)}%` : name ?? 'Model';
    this.bar.set('model', { icon: (name && this.app.modelThumb(name)) ?? '+', label });
  }

  _target() {
    const name = this.app.rebuilder.params.target;
    const p = this.app.rebuilder.progress;
    this.bar.set('target', {
      icon: this.app.rebuilder.thumb(name) ?? '◆',
      label: p ? `${p.placed}/${p.total}` : short(name), // while it builds, only how far
    });
  }
}
