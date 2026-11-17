import { PHASES } from '../physics/FrameBudget.js';

/**
 * A frame as a band (FrameBudget): its width is one frame, each phase a stretch of it in its
 * colour, what is left of the frame empty; past the frame, the band is the phases' sum and a
 * tick marks where the frame ended. Under it, each phase's time and the total against the frame.
 */
export class FrameBand {
  constructor() {
    const el = (tag, className, props) => Object.assign(document.createElement(tag), { className, ...props });
    this.el = el('div', 'band');
    this.bar = el('div', 'band__bar');
    this.parts = Object.fromEntries(PHASES.map((p) => [p, el('span', `band__part band__part--${p}`)]));
    this.tick = el('span', 'band__tick');
    this.bar.append(...Object.values(this.parts), this.tick);
    this.legend = el('div', 'band__legend');
    this.values = Object.fromEntries(PHASES.map((p) => {
      const key = el('span', `band__key band__key--${p}`, { textContent: p });
      const value = el('b', 'band__ms');
      key.append(value);
      this.legend.append(key);
      return [p, value];
    }));
    this.total = el('div', 'band__total');
    this.el.append(this.bar, this.legend, this.total);
  }

  /** Shows `budget` (a FrameBudget). */
  update(budget) {
    const frame = budget.frameMs;
    const span = Math.max(frame, budget.total);
    for (const p of PHASES) {
      this.parts[p].style.width = `${(100 * budget.ms[p]) / span}%`;
      this.values[p].textContent = budget.ms[p].toFixed(1);
    }
    const gpu = budget.gpu ? ' (gpu)' : '';
    this.parts.collisions.title = `collisions${gpu}`;
    this.parts.solver.title = `solver${gpu}`;
    this.el.classList.toggle('band--gpu', budget.gpu);
    this.tick.hidden = budget.total <= frame;
    this.tick.style.left = `${(100 * frame) / span}%`;
    this.total.textContent = `${budget.total.toFixed(1)} of ${frame.toFixed(1)} ms a frame`;
    this.total.title = 'The rest of the frame is the browser\'s: its own work (events, style, compositing, garbage collection) and waiting for the next refresh, or for the GPU to finish drawing';
  }
}
