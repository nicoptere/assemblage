import { Segmented } from './Segmented.js';
import { BIN } from './icons.js';

// a little bin (16 px box, the current colour)

/**
 * A pop-in to pick one of a few things: a grid of tiles with a picture (or a big glyph) and a
 * name. open({ title?, items: [{ value, label, image?, glyph?, note?, className? }], value, anchor?, hover? })
 * resolves with the chosen value, or null when closed (Escape, a click beside the card, or the
 * header's ✕: only a gallery with a `title` has a header). An item with `remove(value)` has a bin
 * in its tile's top right corner: it calls that and the tile goes. With `tabs` ([{ value, label, items }])
 * in place of `items`, the tiles come in tabs, picked over them (`tab`: the one shown first,
 * onTab(value) hears another picked).
 * An item can carry the `status` of its loading ({ state: 'waiting' | 'loading' | 'done' |
 * 'failed', progress 0..1 }: its picture grey until loaded, a disc sweeping its colours in with
 * the percentage meanwhile), updated with setStatus(value, status); one that `waits` cannot be
 * picked until loaded.
 * Without `anchor` it is a card in the middle of the view; with one (an element), it stands above
 * it, within the view. `hover`: opened by the mouse coming over `anchor`, it closes once the mouse
 * has left both (`linger` ms later, time to cross the gap) and leaves the rest of the view usable.
 */
export class Gallery {
  constructor(parent, { linger = 300 } = {}) {
    this.linger = linger;
    this.el = document.createElement('div');
    this.el.className = 'gallery';
    this.el.hidden = true;
    this.el.innerHTML = '<div class="gallery__card" role="dialog"><header class="gallery__head"><h2 class="gallery__title"></h2><button type="button" class="gallery__close" aria-label="Close">✕</button></header><nav class="gallery__tabs"></nav><div class="gallery__grid"></div></div>';
    this.card = this.el.querySelector('.gallery__card');
    this.grid = this.el.querySelector('.gallery__grid');
    this.head = this.el.querySelector('.gallery__head');
    this.tabs = this.el.querySelector('.gallery__tabs');
    this.title = this.el.querySelector('.gallery__title');
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });
    this.el.querySelector('.gallery__close').addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && !this.el.hidden) this.close(); });
    window.addEventListener('resize', () => { if (this.anchor && !this.el.hidden) this._place(this.anchor); });
    this.anchor = null; // the element it stands above, if any
    this.tiles = new Map(); // value -> { b, item }
    this._resolve = null;
    this._unhover = null; // removes the hover listeners
    parent.appendChild(this.el);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open({ title = '', items = [], tabs = null, tab = null, onTab = () => {}, value = null, anchor = null, hover = false }) {
    this.close();
    this.title.textContent = title;
    this.head.hidden = !title;
    const show = (list) => {
      this.tiles.clear();
      this.grid.replaceChildren(...list.map((item) => this._tile(item, item.value === value)));
    };
    this.tabs.hidden = !tabs;
    if (tabs) {
      const first = tabs.find((t) => t.value === tab) ?? tabs[0];
      this.tabs.replaceChildren(new Segmented(tabs, first.value, (v) => {
        show(tabs.find((t) => t.value === v).items);
        if (this.anchor) this._place(this.anchor);
        onTab(v);
      }).el);
      show(first.items);
    } else show(items);
    this.anchor = anchor;
    this.card.removeAttribute('style'); // an anchored card's place
    this.el.classList.toggle('gallery--anchored', !!anchor);
    this.el.classList.toggle('gallery--hover', hover);
    this.el.hidden = false;
    if (anchor) this._place(anchor);
    if (anchor && hover) this._unhover = this._followHover(anchor);
    return new Promise((resolve) => { this._resolve = resolve; });
  }

  /** Keeps an open hover gallery open when the mouse leaves (a long press or right click on its button). */
  pin() {
    this._unhover?.();
    this._unhover = null;
    this.el.classList.remove('gallery--hover');
  }

  close(value = null) {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this._unhover?.();
    this._unhover = null;
    this.anchor = null;
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(value);
  }

  /** The card above `anchor`, centred on it, kept inside the view; scrolls if taller than the room above. */
  _place(anchor, gap = 10, margin = 8) {
    const box = this.el.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const card = this.card.style;
    card.maxHeight = `${Math.max(120, a.top - box.top - gap - margin)}px`;
    card.bottom = `${box.bottom - a.top + gap}px`;
    const w = this.card.offsetWidth;
    card.left = `${Math.min(Math.max(a.left + a.width / 2 - w / 2, box.left + margin), box.right - margin - w) - box.left}px`;
  }

  /** Closes once the mouse has been off both `anchor` and the card for `linger` ms. */
  _followHover(anchor) {
    let timer = 0;
    const leave = () => { clearTimeout(timer); timer = setTimeout(() => this.close(), this.linger); };
    const enter = () => clearTimeout(timer);
    const targets = [anchor, this.card];
    for (const t of targets) {
      t.addEventListener('pointerleave', leave);
      t.addEventListener('pointerenter', enter);
    }
    return () => {
      clearTimeout(timer);
      for (const t of targets) {
        t.removeEventListener('pointerleave', leave);
        t.removeEventListener('pointerenter', enter);
      }
    };
  }

  /** Shows how `value`'s loading goes (see the class comment). */
  setStatus(value, { state, progress = 0 }) {
    const tile = this.tiles.get(value);
    if (!tile) return;
    const { b, item } = tile;
    b.dataset.state = state;
    b.style.setProperty('--p', state === 'done' ? 1 : state === 'loading' ? progress : 0);
    b.querySelector('.gallery__percent').textContent = state === 'loading' ? `${Math.round(100 * progress)}%` : state === 'failed' ? '!' : '';
    b.disabled = !!item.waits && state !== 'done';
  }

  _tile(item, current) {
    const { value, label, image, glyph, note, status, className } = item;
    const el = (tag, name, props) => Object.assign(document.createElement(tag), { className: name, ...props });
    const b = el('button', ['gallery__tile', current && 'gallery__tile--current', className].filter(Boolean).join(' '), { type: 'button' });
    let picture = el('span', 'gallery__glyph', { textContent: glyph ?? '' });
    if (image) {
      picture = el('span', 'gallery__picture');
      if (status) picture.append(el('img', 'gallery__image gallery__image--grey', { src: image, alt: '' }));
      picture.append(el('img', 'gallery__image gallery__image--colour', { src: image, alt: '' }), el('span', 'gallery__percent'));
    }
    b.append(picture, el('span', 'gallery__label', { textContent: label, title: label }));
    if (note) b.append(el('span', 'gallery__note', { textContent: note }));
    if (item.remove) b.append(this._bin(b, item));
    b.addEventListener('click', () => this.close(value));
    this.tiles.set(value, { b, item });
    if (status) this.setStatus(value, status);
    return b;
  }

  /** The bin of `tile` (in the tile's button, so a span acting as one): `item.remove(value)`, then the tile goes, nothing picked. */
  _bin(tile, { value, label, remove }) {
    const bin = Object.assign(document.createElement('span'), { className: 'gallery__remove', role: 'button', tabIndex: 0, title: `Delete ${label}`, innerHTML: BIN });
    bin.setAttribute('aria-label', `Delete ${label}`);
    const go = (e) => {
      e.stopPropagation();
      e.preventDefault();
      remove(value);
      tile.remove();
      this.tiles.delete(value);
    };
    bin.addEventListener('click', go);
    bin.addEventListener('keydown', (e) => { if (e.code === 'Enter' || e.code === 'Space') go(e); });
    return bin;
  }
}
