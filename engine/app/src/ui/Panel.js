/**
 * Schema-driven control panel. Items:
 *   { section }                                       heading
 *   { button, onClick, key? }                         action (optional keyboard shortcut label)
 *   { toggle, value, onChange, key? }                 checkbox
 *   { range, value, min, max, step?, log?, unit?, format?, onChange }   slider (log = logarithmic,
 *                                                      format(v) -> text, default Panel.format)
 *   { select, options, value, onChange }               dropdown (options can be set later; an option is a
 *                                                      string or { value, label?, disabled? })
 */
export class Panel {
  constructor(parent, title, items, { side = 'right' } = {}) {
    this.inputs = new Map();
    this.buttons = new Map();
    this.ranges = new Map(); // label -> set(value): a slider and its read-out
    this.el = document.createElement('aside');
    this.el.className = `panel panel--${side}`;
    this.el.innerHTML = `<header class="panel__title">${title}</header>`;
    for (const item of items) this.el.appendChild(this._item(item));
    this.stats = document.createElement('pre');
    this.stats.className = 'panel__stats';
    this.el.appendChild(this.stats);
    parent.appendChild(this.el);
  }

  _item(item) {
    if (item.section) {
      const h = document.createElement('h3');
      h.className = 'panel__section';
      h.textContent = item.section;
      return h;
    }
    const row = document.createElement('label');
    row.className = 'panel__row';
    if (item.button) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'panel__button';
      b.innerHTML = item.button + (item.key ? ` <kbd>${item.key}</kbd>` : '');
      b.addEventListener('click', item.onClick);
      this.buttons.set(item.button, b);
      return b;
    }
    if (item.toggle) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = item.value;
      input.addEventListener('change', () => item.onChange(input.checked));
      row.classList.add('panel__row--toggle');
      row.append(input, this._text(item.toggle, item.key));
      this.inputs.set(item.toggle, input);
      return row;
    }
    if (item.select) {
      const input = document.createElement('select');
      input.className = 'panel__select';
      input.addEventListener('change', () => item.onChange(input.value));
      row.classList.add('panel__row--select');
      row.append(this._text(item.select), input);
      this.inputs.set(item.select, input);
      this.setOptions(item.select, item.options ?? [], item.value);
      return row;
    }
    if (item.range) {
      const { min, max, log = false, step = log ? 0.01 : (max - min) / 100 } = item;
      const toSlider = (v) => (log ? Math.log10(v) : v);
      const fromSlider = (s) => (log ? 10 ** s : s);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = toSlider(min);
      input.max = toSlider(max);
      input.step = step;
      input.value = toSlider(item.value);
      const out = document.createElement('output');
      const format = item.format ?? Panel.format;
      const show = (v) => { out.textContent = format(v) + (item.unit ? ` ${item.unit}` : ''); };
      show(item.value);
      input.addEventListener('input', () => {
        const v = fromSlider(Number(input.value));
        show(v);
        item.onChange(v);
      });
      row.classList.add('panel__row--range');
      row.append(this._text(item.range), out, input);
      this.inputs.set(item.range, input);
      this.ranges.set(item.range, (v) => { input.value = toSlider(v); show(v); });
      return row;
    }
    throw new Error(`Panel: unknown item ${JSON.stringify(item)}`);
  }

  _text(label, key) {
    const span = document.createElement('span');
    span.innerHTML = label + (key ? ` <kbd>${key}</kbd>` : '');
    return span;
  }

  /** Reflects a programmatic change of a slider in the UI. */
  setRange(label, value) {
    this.ranges.get(label)?.(value);
  }

  /** Reflects a programmatic toggle change (e.g. keyboard shortcut) in the UI. */
  setToggle(label, value) {
    const input = this.inputs.get(label);
    if (input) input.checked = value;
  }

  /** Shows a button as engaged (an armed tool, say). */
  setActive(label, on) {
    this.buttons.get(label)?.classList.toggle('panel__button--active', on);
  }

  setOptions(label, options, value) {
    const input = this.inputs.get(label);
    if (!input) return;
    input.replaceChildren(...options.map((o) => {
      const { value: v, label: text = v, disabled = false, title = '' } = typeof o === 'string' ? { value: o } : o;
      return Object.assign(document.createElement('option'), { value: v, textContent: text, disabled, title });
    }));
    if (value !== undefined) input.value = value;
  }

  /** Reflects a programmatic change of a dropdown in the UI. */
  setValue(label, value) {
    const input = this.inputs.get(label);
    if (input) input.value = value;
  }

  setStats(lines) {
    this.stats.textContent = lines.join('\n');
  }

  static format(v) {
    if (!Number.isFinite(v)) return '∞';
    const a = Math.abs(v);
    if (a >= 1e5 || (a > 0 && a < 1e-2)) return v.toExponential(1);
    return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  }
}
