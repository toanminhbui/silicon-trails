let worker;
let serial = 0;
const pending = new Map();

function failPending(message) {
  worker?.terminate();
  worker = null;
  for (const job of pending.values()) {
    clearTimeout(job.timeout);
    job.reject(new Error(message));
  }
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (data.progress) { job.onProgress?.(data.progress); return; }
    pending.delete(data.id);
    clearTimeout(job.timeout);
    if (data.error) {
      const error = new Error(data.error);
      error.log = data.log;
      job.reject(error);
    } else job.resolve(data.result);
  };
  worker.onerror = event => {
    event.preventDefault();
    failPending(`The local RTL compiler could not start: ${event.message || 'worker failed'}. Check that the toolchain assets are available.`);
  };
  return worker;
}

export async function compileVerilog(source, { top = 'top', onProgress } = {}) {
  if (typeof window === 'undefined') {
    // Keep the Node-only package graph opaque to the browser bundler. A literal
    // import can cause Rollup to traverse the 27 MiB synthesis engine anyway.
    const nodeEntry = ['.', 'node.js'].join('/');
    const { compileVerilogNode } = await import(/* @vite-ignore */ nodeEntry);
    return compileVerilogNode(source, { top, onProgress });
  }
  if (!globalThis.Worker || !globalThis.WebAssembly) throw new Error('RTL compilation requires a browser with Web Workers and WebAssembly.');
  const localWorker = getWorker();
  const id = ++serial;
  const toolchainURL = new URL(`${import.meta.env.BASE_URL}toolchain/bundle.js`, window.location.origin).href;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => failPending('RTL compilation exceeded two minutes. Reduce the design size and try again.'), 120000);
    pending.set(id, { resolve, reject, timeout, onProgress });
    localWorker.postMessage({ id, source, top, toolchainURL });
  });
}
