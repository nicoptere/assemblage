/**
 * A round button in a top corner of the view (`side`: 'left' or 'right') that shows and hides
 * `panel` under it. Escape hides it again, and so does a click anywhere else if `outside`.
 * `label`: text or an element; onToggle(open) hears every change.
 */
export class CornerButton {
  constructor(parent, panel, { label, title = '', side = 'left', outside = true, onToggle = () => {} }) {
    this.panel = panel;
    this.onToggle = onToggle;
    panel.hidden = true;
    panel.classList.add('corner-panel', `corner-panel--${side}`);
    this.button = Object.assign(document.createElement('button'), { type: 'button', className: `corner-button corner-button--${side}`, title });
    this.button.setAttribute('aria-label', title);
    this.button.setAttribute('aria-expanded', 'false');
    this.button.append(label);
    this.button.addEventListener('click', () => this.toggle());
    parent.append(this.button);
    if (!panel.parentNode) parent.append(panel);
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape') this.toggle(false); });
    if (outside) {
      window.addEventListener('pointerdown', (e) => {
        if (this.open && !panel.contains(e.target) && !this.button.contains(e.target)) this.toggle(false);
      }, true);
    }
  }

  get open() {
    return !this.panel.hidden;
  }

  toggle(on = !this.open) {
    if (on === this.open) return;
    this.panel.hidden = !on;
    this.button.setAttribute('aria-expanded', String(on));
    this.onToggle(on);
  }
}
