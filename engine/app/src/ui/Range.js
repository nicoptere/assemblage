/**
 * A labelled slider with its value: new Range({ label, min, max, step, value, format?, title?,
 * onChange(value) }). `el` is the control; set(value) moves it without calling onChange.
 */
export class Range {
  constructor({ label, min, max, step, value, format = String, title = '', onChange = () => {} }) {
    const el = (tag, className, props) => Object.assign(document.createElement(tag), { className, ...props });
    this.el = el('label', 'range', { title });
    this.format = format;
    this.out = el('output', 'range__value', { textContent: format(value) });
    this.input = el('input', 'range__input', { type: 'range', min, max, step, value });
    this.input.addEventListener('input', () => {
      this.out.textContent = format(Number(this.input.value));
      onChange(Number(this.input.value));
    });
    this.el.append(el('span', 'range__label', { textContent: label }), this.input, this.out);
  }

  get value() {
    return Number(this.input.value);
  }

  set(value) {
    if (document.activeElement === this.input) return; // being dragged
    this.input.value = value;
    this.out.textContent = this.format(Number(this.input.value));
  }
}
