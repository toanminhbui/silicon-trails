import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = (await readdir(new URL('../tests/', import.meta.url)))
  .filter(name => name.endsWith('.test.js')).sort();

// Run node:test files directly: each still emits TAP and sets a failure exit
// code, but there is no extra test-runner process or ambiguity about V8 flag
// inheritance. Limit Wasm compilation workers for small development machines.
for (const file of files) {
  console.log(`Running tests/${file}`);
  const { code, signal } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--wasm-num-compilation-tasks=1', '--liftoff-only', `tests/${file}`,
    ], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (code !== 0 || signal) {
    console.error(`tests/${file} failed${signal ? ` (${signal})` : ` (exit ${code})`}.`);
    process.exitCode = 1;
  }
}
