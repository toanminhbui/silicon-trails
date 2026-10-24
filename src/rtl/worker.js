import { synthesizeWith } from './synthesis.js';

let runtime;
let queue = Promise.resolve();
const originalFetch = self.fetch.bind(self);
let toolchainBase;

// The engine is shipped as gzip assets below static hosting file-size limits.
// Reconstruct a Wasm response locally; no source or synthesis goes to a server.
self.fetch = async (input, options) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (toolchainBase && url.startsWith(toolchainBase) && url.endsWith('.wasm')) {
    if (!self.DecompressionStream) throw new Error('This browser needs DecompressionStream support to load the local RTL compiler.');
    const response = await originalFetch(`${url}.gz`, options);
    if (!response.ok) throw new Error(`Unable to load local Yosys asset (${response.status}): ${url.split('/').at(-1)}.gz`);
    const alreadyDecoded = response.headers.get('content-encoding')?.includes('gzip');
    const body = alreadyDecoded ? response.body : response.body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(body, { headers: { 'content-type': 'application/wasm' } });
  }
  return originalFetch(input, options);
};
self.onmessage = event => {
  const { id, source, top, toolchainURL } = event.data;
  queue = queue.then(async () => {
    try {
      self.postMessage({ id, progress: { stage: 'loading', message: 'Loading locally served Yosys WebAssembly…' } });
      toolchainBase = new URL('./', toolchainURL).href;
      runtime ??= import(/* @vite-ignore */ toolchainURL);
      const { runYosys } = await runtime;
      self.postMessage({ id, progress: { stage: 'compiling', message: 'Elaborating modules and synthesizing RTL…' } });
      const result = await synthesizeWith(runYosys, source, {
        top,
        onProgress: progress => self.postMessage({ id, progress }),
      });
      self.postMessage({ id, result });
    } catch (error) {
      self.postMessage({ id, error: error.message, log: error.log || '' });
    }
  }).catch(() => {});
};
