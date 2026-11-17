/**
 * A choice of a few options side by side, one lit: new Segmented([{ value, label, title? }], value,
 * onChange(value)). `el` is the control; `value` is the option lit. set(value) lights another
 * without calling onChange; enable(value, on, title?) greys an option out (or back).
 */
export class Segmented {
  constructor(options, value, onChange = () => {}) {
    this.el = document.createElement('div');
    this.el.className = 'segmented';
    this.el.setAttribute('role', 'radiogroup');
    this.buttons = options.map((o) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'segmented__option', textContent: o.label, title: o.title ?? '' });
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        if (this.value === o.value) return;
        this.set(o.value);
        onChange(o.value);
      });
      this.el.appendChild(b);
      return { b, value: o.value };
    });
    this.set(value);
  }

  enable(value, on, title) {
    const option = this.buttons.find((o) => o.value === value);
    if (!option) return;
    option.b.disabled = !on;
    if (title !== undefined) option.b.title = title;
  }

  set(value) {
    this.value = value;
    for (const { b, value: v } of this.buttons) {
      b.classList.toggle('segmented__option--on', v === value);
      b.setAttribute('aria-checked', String(v === value));
    }
  }
}
