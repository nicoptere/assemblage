/**
 * Large buttons along the bottom of the view. Items: { id, label, icon?, caption?, title?, fit?, onClick, onHold?, onHover? }
 * (fit: the label keeps one width, a longer one cut short with an ellipsis, whole in its tooltip: the button never changes size)
 * (icon: a short text, a line icon's SVG markup (icons.js), or a picture: a URL ending in .png/.jpg/.svg/.webp, or a data: or
 * blob: URL; caption: a small line over the label; with neither label nor caption, the button is a round icon: give it a title).
 * onHold(button): a long press (`hold` ms), or a right click, instead of the click. onHover(button):
 * the mouse rests on the button (`hover` ms). set(id, changes) updates one.
 */
export class ActionBar {
  constructor(parent, items, { hold = 450, hover = 150 } = {}) {
    this.el = document.createElement('nav');
    this.el.className = 'bar';
    this.buttons = new Map();
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `bar__button${item.fit ? ' bar__button--fit' : ''}`;
      if (item.onHold) ActionBar._hold(b, () => item.onHold(b), hold);
      if (item.onHover) ActionBar._hover(b, () => item.onHover(b), hover);
      b.addEventListener('click', (e) => {
        e.currentTarget.blur();
        item.onClick();
      });
      this.buttons.set(item.id, b);
      this.el.appendChild(b);
      this.set(item.id, item);
    }
    parent.appendChild(this.el);
  }

  /**
   * Calls `onHold` after `ms` pressed, or on a right click (or a touch screen's own long press).
   * The click that ends a hold is swallowed, wherever it lands: on the button, or on a pop-in that
   * opened under the finger.
   */
  static _hold(b, onHold, ms) {
    let timer = 0;
    let held = false;
    const fire = (pressed) => {
      clearTimeout(timer);
      if (held) return;
      held = true;
      if (pressed) ActionBar._swallowNextClick();
      onHold();
    };
    const cancel = () => clearTimeout(timer);
    b.addEventListener('pointerdown', (e) => {
      held = false;
      if (e.button === 0) timer = setTimeout(() => fire(true), ms);
    });
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('pointercancel', cancel);
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); fire(false); });
  }

  /** Calls `onHover` once the mouse (not a finger or pen) has rested `ms` on the button. */
  static _hover(b, onHover, ms) {
    let timer = 0;
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') timer = setTimeout(onHover, ms); });
    b.addEventListener('pointerleave', () => clearTimeout(timer));
  }

  /** Swallows one click, if it comes before `ms` after the pointer goes up (or is cancelled). */
  static _swallowNextClick(ms = 400) {
    const click = (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.removeEventListener('click', click, true);
    };
    const up = () => {
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      setTimeout(() => window.removeEventListener('click', click, true), ms);
    };
    window.addEventListener('click', click, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  set(id, { label, icon, caption, title, disabled } = {}) {
    const b = this.buttons.get(id);
    const d = b.dataset;
    const text = (value, key) => (value === undefined ? d[key] ?? '' : value ?? '');
    const next = { label: text(label, 'label'), icon: text(icon, 'icon'), caption: text(caption, 'caption') };
    if (next.label !== d.label || next.icon !== d.icon || next.caption !== d.caption) {
      Object.assign(d, next);
      b.replaceChildren(...ActionBar._content(next));
    }
    if (title !== undefined) b.title = title;
    const round = !next.label && !next.caption; // an icon alone: its title says what it does
    b.classList.toggle('bar__button--round', round);
    if (round) b.setAttribute('aria-label', b.title);
    if (disabled !== undefined) b.disabled = disabled;
  }

  /** The button's insides: the icon (or picture), then the label, under its caption if it has one. */
  static _content({ label, icon, caption }) {
    const el = (tag, className, props) => Object.assign(document.createElement(tag), { className, ...props });
    const parts = [];
    if (icon.startsWith('<svg')) parts.push(el('span', 'bar__icon', { innerHTML: icon }));
    else if (icon) parts.push(/^(data:image\/|blob:)|\.(png|jpe?g|svg|webp)$/.test(icon) ? el('img', 'bar__thumb', { src: icon, alt: '', draggable: false }) : el('span', 'bar__icon', { textContent: icon }));
    if (!label && !caption) return parts;
    const text = el('span', 'bar__label', { textContent: label, title: label });
    if (!caption) return [...parts, text];
    const box = el('span', 'bar__text');
    box.append(el('span', 'bar__caption', { textContent: caption }), text);
    return [...parts, box];
  }
}
