import { segmentMesh } from '@sdfphys/core/segment';

// One job per worker (SegmentWorker): { positions, indices, options } in, progress messages, then
// { type: 'done', labels, manifest, buffer, caps, stats } or { type: 'error', message }.
self.onmessage = ({ data: { positions, indices, options } }) => {
  try {
    let last = -1;
    const out = segmentMesh(positions, indices, options, (fraction) => {
      if (fraction - last < 0.01 && fraction < 1) return;
      last = fraction;
      self.postMessage({ type: 'progress', fraction });
    });
    const transfer = [out.labels.buffer, out.buffer, ...out.caps.map((c) => c.buffer)];
    self.postMessage({ type: 'done', ...out }, transfer);
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message || String(e) });
  }
};
