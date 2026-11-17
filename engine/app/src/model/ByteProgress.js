/**
 * How far a load made of a few files is, in bytes: report(fraction) is called as they come.
 * track() gives a report(loaded, total) for one file (report.done() once it has all come);
 * `fetch` is a fetch that tracks the bodies it reads. Files whose size is not known yet count
 * for nothing, so start the big ones together for a fraction that moves smoothly.
 */
export class ByteProgress {
  constructor(report = () => {}) {
    this.report = report;
    this.files = [];
    this.fetch = (url, init) => this._fetch(url, init);
  }

  track() {
    const file = { loaded: 0, total: 0 };
    this.files.push(file);
    const report = (loaded, total = 0) => {
      file.loaded = loaded;
      file.total = Math.max(total, loaded);
      this._report();
    };
    report.done = () => {
      file.total = file.loaded = Math.max(file.loaded, file.total);
      this._report();
    };
    return report;
  }

  _report() {
    let loaded = 0;
    let total = 0;
    for (const f of this.files) {
      loaded += f.loaded;
      total += f.total;
    }
    if (total) this.report(loaded / total);
  }

  async _fetch(url, init) {
    const response = await fetch(url, init);
    if (!response.ok || !response.body) return response;
    const report = this.track();
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    let loaded = 0;
    const body = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          report.done();
          controller.close();
          return;
        }
        loaded += value.byteLength;
        report(loaded, total);
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
