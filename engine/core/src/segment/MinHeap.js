/** A binary min-heap of (key, value) pairs: numbers keys, integer values; grows as needed. */
export class MinHeap {
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.values = new Int32Array(capacity);
    this.size = 0;
  }

  push(key, value) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(2 * this.size);
      const values = new Int32Array(2 * this.size);
      keys.set(this.keys);
      values.set(this.values);
      this.keys = keys;
      this.values = values;
    }
    const { keys, values } = this;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      values[i] = values[p];
      i = p;
    }
    keys[i] = key;
    values[i] = value;
  }

  /** The smallest key (Infinity when empty); pop() removes its pair and returns the value. */
  get top() {
    return this.size ? this.keys[0] : Infinity;
  }

  pop() {
    const { keys, values } = this;
    const value = values[0];
    const n = --this.size;
    const key = keys[n], last = values[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= key) break;
      keys[i] = keys[c];
      values[i] = values[c];
      i = c;
    }
    keys[i] = key;
    values[i] = last;
    return value;
  }
}
