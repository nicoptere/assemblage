/**
 * Taps on a touch screen: `onTap(point)` and `onDoubleTap(point)`, point = { clientX, clientY }.
 * A tap is one finger lifted within `time` ms without moving more than `slop` px; a second tap
 * within `gap` ms and `near` px of it makes a double tap, so a single tap's action waits `gap` ms
 * to be sure. Fingers that drag (a part, the view) or pinch make no tap. With a mouse or pen, a
 * double click is a double tap too; single clicks are left to the other tools (focus, drag).
 * Listens on the window in the capture phase, ahead of the drag tool and the orbit controls.
 */
export class TapTool {
  constructor(element, { onTap = () => {}, onDoubleTap = () => {} } = {}, { slop = 10, time = 300, gap = 280, near = 40 } = {}) {
    this.options = { slop, time, gap, near };
    this.onTap = onTap;
    this.onDoubleTap = onDoubleTap;
    this.fingers = new Map(); // pointerId -> { x, y, t }
    this.multi = false; // more than one finger since the last all-up: a pinch, not a tap
    this.pending = null; // { x, y, t, timer }: a tap waiting to know whether a second one follows
    this.touched = false; // the last press on the element was a finger (browsers may follow two taps with a dblclick)
    window.addEventListener('pointerdown', (e) => {
      if (e.target !== element) return;
      this.touched = e.pointerType === 'touch';
      if (!this.touched) return;
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (this.fingers.size > 1) this.multi = true;
    }, true);
    element.addEventListener('dblclick', (e) => {
      if (!this.touched) this.onDoubleTap({ clientX: e.clientX, clientY: e.clientY });
    });
    window.addEventListener('pointerup', (e) => this._up(e), true);
    window.addEventListener('pointercancel', (e) => { this.fingers.delete(e.pointerId); this.multi = this.fingers.size > 0 && this.multi; }, true);
  }

  _up(e) {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    this.fingers.delete(e.pointerId);
    const multi = this.multi;
    if (!this.fingers.size) this.multi = false;
    const { slop, time, gap, near } = this.options;
    if (multi || e.timeStamp - f.t > time || Math.hypot(e.clientX - f.x, e.clientY - f.y) > slop) return;
    const point = { clientX: e.clientX, clientY: e.clientY };
    const p = this.pending;
    if (p && e.timeStamp - p.t <= gap && Math.hypot(point.clientX - p.clientX, point.clientY - p.clientY) <= near) {
      clearTimeout(p.timer);
      this.pending = null;
      this.onDoubleTap(point);
      return;
    }
    if (p) {
      clearTimeout(p.timer);
      this.onTap(p);
    }
    this.pending = { ...point, t: e.timeStamp, timer: setTimeout(() => { this.pending = null; this.onTap(point); }, gap) };
  }
}
