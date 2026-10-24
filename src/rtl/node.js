import { runYosys } from '@yowasp/yosys';
import { synthesizeWith } from './synthesis.js';

// Keep tool invocations sequential: each run owns a fresh virtual filesystem.
let queue = Promise.resolve();
export function compileVerilogNode(source, options = {}) {
  const operation = queue.then(() => synthesizeWith(runYosys, source, options));
  queue = operation.catch(() => {});
  return operation;
}
