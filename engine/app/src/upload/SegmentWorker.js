/**
 * Segments and bakes a mesh in a worker (segment.worker.js: @sdfphys/core/segment), off the main
 * thread: resolves with { labels, manifest, buffer, caps, stats }, reporting progress (0..1) to
 * `report`. The worker serves one job and is let go.
 */
export function segmentInWorker(positions, indices, options = {}, report = () => {}) {
  const worker = new Worker(new URL('./segment.worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') return report(data.fraction);
      worker.terminate();
      if (data.type === 'done') resolve(data);
      else reject(new Error(data.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'the segmentation worker failed'));
    };
    worker.postMessage({ positions, indices, options }, [positions.buffer, indices.buffer]);
  });
}
