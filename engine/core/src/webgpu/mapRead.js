/**
 * Maps `buffer` for reading (GPUBuffer.mapAsync), optionally without the browser's polling delay.
 * Firefox notices finished GPU work on a 100 ms timer (bugzilla 1870699), so a map waits up to
 * 100 ms there whatever the GPU did. Each queue submission also polls, so with `nudge` a map still
 * pending after `delay` ms gets an empty command buffer submitted every `every` ms. Browsers
 * that map promptly do not need it, and there the empty submits only load the GPU process
 * (see nudgeNeeded). Resolves to the time waited, in ms.
 */
export async function mapRead(device, buffer, offset, size, { nudge = true, delay = 6, every = 2 } = {}) {
  const start = performance.now();
  let pending = nudge;
  const tick = () => {
    if (!pending) return;
    device.queue.submit([device.createCommandEncoder().finish()]);
    setTimeout(tick, every);
  };
  if (nudge) setTimeout(tick, delay);
  try {
    await buffer.mapAsync(GPUMapMode.READ, offset, size);
  } finally {
    pending = false;
  }
  return performance.now() - start;
}

/**
 * Whether this browser maps faster with nudges: the fastest of a few small read-backs each way.
 * Resolves to { nudge, plainMs, nudgedMs }.
 */
export async function nudgeNeeded(device, trials = 3) {
  const src = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC });
  const dst = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const trial = async (nudge) => {
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(src, 0, dst, 0, 16);
    device.queue.submit([encoder.finish()]);
    const ms = await mapRead(device, dst, 0, 16, { nudge });
    dst.unmap();
    return ms;
  };
  let plainMs = Infinity;
  let nudgedMs = Infinity;
  for (let i = 0; i < trials; i++) {
    plainMs = Math.min(plainMs, await trial(false));
    nudgedMs = Math.min(nudgedMs, await trial(true));
  }
  src.destroy();
  dst.destroy();
  return { nudge: plainMs > 20 && nudgedMs < plainMs / 2, plainMs, nudgedMs };
}
