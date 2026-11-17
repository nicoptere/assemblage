/**
 * A labelled on / off switch: new Switch({ label, value, title?, onChange(on) }). `el` is the
 * control; set(on) flips it without calling onChange.
 */
export class Switch {
  constructor({ label, value = false, title = '', onChange = () => {} }) {
    const el = (tag, className, props) => Object.assign(document.createElement(tag), { className, ...props });
    this.el = el('label', 'switch', { title });
    this.input = el('input', 'switch__input', { type: 'checkbox', checked: value });
    this.input.setAttribute('role', 'switch');
    this.input.addEventListener('change', () => onChange(this.input.checked));
    this.el.append(el('span', 'switch__label', { textContent: label }), this.input, el('span', 'switch__track'));
  }

  set(on) {
    this.input.checked = on;
  }
}
