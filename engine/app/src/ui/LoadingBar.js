/**
 * A thin bar along the top of the view while a LoadQueue has things to load, with how many are
 * in: "loading models · 3 / 8", or what the one loading says it is doing ("segmenting
 * steampunk · 40%"). watch(queue) follows one; it hides once all are in. notice(text) shows a
 * line there for a few seconds (what an upload gave, or why it failed).
 */
export class LoadingBar {
  constructor(parent, { label = 'loading models' } = {}) {
    this.label = label;
    this.el = document.createElement('div');
    this.el.className = 'loading';
    this.el.hidden = true;
    this.el.innerHTML = '<div class="loading__track"><div class="loading__fill"></div></div><div class="loading__text"></div>';
    this.trackEl = this.el.querySelector('.loading__track');
    this.fillEl = this.el.querySelector('.loading__fill');
    this.textEl = this.el.querySelector('.loading__text');
    this._notice = null;
    this._timer = 0;
    this._show = () => {};
    parent.appendChild(this.el);
  }

  watch(queue) {
    this._show = () => {
      const busy = queue.busy;
      this.el.hidden = !busy && !this._notice;
      this.trackEl.hidden = !busy;
      if (this.el.hidden) return;
      const list = [...queue.entries.values()];
      const noted = list.find((e) => e.state === 'loading' && e.note);
      this.fillEl.style.width = `${100 * queue.fraction}%`;
      this.textEl.textContent = this._notice
        ?? (noted ? `${noted.note} · ${Math.round(100 * noted.progress)}%` : `${this.label} · ${list.filter((e) => e.state === 'done').length} / ${list.length}`);
    };
    queue.onChange(this._show);
    this._show();
  }

  notice(text, ms = 6000) {
    clearTimeout(this._timer);
    this._notice = text;
    this._show();
    this._timer = setTimeout(() => {
      this._notice = null;
      this._show();
    }, ms);
  }
}
