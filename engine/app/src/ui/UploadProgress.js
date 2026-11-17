/**
 * A card in the middle of the view while mesh files become models (App.uploadModel): a row each,
 * its picture (once made), its name and how its segmentation goes (a bar, what it is doing and how
 * far), then its parts and joints, or why it failed. track(names) adds rows and opens it; the rows
 * follow `queue`'s entries (the models' LoadQueue). Once every row is in, it closes by itself
 * `linger` ms later, unless one failed; ✕, Escape or a click beside the card close it sooner
 * (the work goes on). `thumb(name)`: a model's picture, or null until it is made.
 */
export class UploadProgress {
  constructor(parent, queue, thumb, { linger = 1500 } = {}) {
    this.queue = queue;
    this.thumb = thumb;
    this.linger = linger;
    this.rows = new Map(); // name -> its elements
    this._timer = 0;
    this.el = Object.assign(document.createElement('div'), { className: 'uploads', hidden: true });
    this.el.innerHTML = '<div class="uploads__card" role="dialog" aria-label="Adding models"><header class="uploads__head"><h2 class="uploads__title">Adding models</h2><button type="button" class="uploads__close" aria-label="Close">✕</button></header><ul class="uploads__list"></ul></div>';
    this.list = this.el.querySelector('.uploads__list');
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });
    this.el.querySelector('.uploads__close').addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape') this.close(); });
    queue.onChange((entry) => { if (this.rows.has(entry.key)) this._show(entry); });
    parent.appendChild(this.el);
  }

  /** Rows for the models `names` (a closed card starts afresh), and the card open. */
  track(names) {
    if (this.el.hidden) {
      this.rows.clear();
      this.list.replaceChildren();
    }
    for (const name of names) {
      const el = (tag, className, props) => Object.assign(document.createElement(tag), { className, ...props });
      const row = { li: el('li', 'uploads__row'), image: el('img', 'uploads__picture', { alt: '' }), status: el('span', 'uploads__status'), bar: el('span', 'uploads__bar') };
      const text = el('span', 'uploads__text');
      text.append(el('b', 'uploads__name', { textContent: name }), row.status);
      row.li.append(row.image, text, row.bar);
      this.list.append(row.li);
      this.rows.set(name, row);
      this._show(this.queue.entry(name) ?? { key: name, state: 'waiting', progress: 0 });
    }
    this.el.hidden = false;
  }

  close() {
    clearTimeout(this._timer);
    this.el.hidden = true;
  }

  _show({ key, state, progress, note, value, error }) {
    const row = this.rows.get(key);
    const picture = this.thumb(key);
    if (picture && row.image.getAttribute('src') !== picture) row.image.src = picture;
    row.li.dataset.state = state;
    row.bar.style.setProperty('--p', state === 'done' ? 1 : progress);
    const stats = value?.stats;
    row.status.textContent = state === 'waiting' ? 'waiting'
      : state === 'loading' ? `${(note ?? 'loading').replace(` ${key}`, '')} · ${Math.round(100 * progress)}%`
        : state === 'done' ? (stats ? `${stats.parts} parts, ${stats.joints} joints · ${((stats.segmentMs + stats.bakeMs) / 1000).toFixed(1)} s` : 'in')
          : error?.message ?? 'failed';
    this._settle();
  }

  /** Closes `linger` ms after every row is in, if none failed. */
  _settle() {
    clearTimeout(this._timer);
    const states = [...this.rows.keys()].map((name) => this.queue.entry(name)?.state ?? 'failed'); // a failed upload leaves the queue
    if (states.every((s) => s === 'done')) this._timer = setTimeout(() => this.close(), this.linger);
  }
}
