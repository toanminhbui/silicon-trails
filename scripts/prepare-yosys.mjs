import { mkdir, readdir, cp, rm, unlink, writeFile, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const installed = dirname(fileURLToPath(import.meta.resolve('@yowasp/yosys')));
const destination = join(root, 'public/toolchain');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(installed, destination, { recursive: true });
const assets = await readdir(destination);
for (const name of assets.filter(name => name.endsWith('.wasm'))) {
  await pipeline(createReadStream(join(destination, name)), createGzip({ level: 9 }), createWriteStream(join(destination, `${name}.gz`)));
  await unlink(join(destination, name));
  const { size } = await stat(join(destination, `${name}.gz`));
  if (size > 24 * 1024 * 1024) throw new Error(`Compressed synthesis asset exceeds hosting limit: ${name}`);
}
await writeFile(join(destination, 'NOTICE.txt'), 'YoWASP Yosys, locally served WebAssembly synthesis engine.\nYosys and YoWASP are distributed under the ISC license.\nhttps://github.com/YoWASP/yosys\nhttps://github.com/YosysHQ/yosys\n');
console.log(`Prepared local Yosys runtime with gzip Wasm transport in public/toolchain.`);
