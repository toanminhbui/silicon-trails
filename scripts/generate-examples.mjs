import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileVerilogNode } from '../src/rtl/node.js';
import { RTL_EXAMPLES } from '../src/rtl/examples.js';

const destination = fileURLToPath(new URL('../public/examples/', import.meta.url));
await mkdir(destination, { recursive: true });
for (const example of RTL_EXAMPLES) {
  const result = await compileVerilogNode(example.source, { top: example.top });
  await writeFile(`${destination}${example.id}.v`, example.source);
  await writeFile(`${destination}${example.id}.json`, JSON.stringify(result));
  const types = [...new Set(Object.values(result.netlist.modules[example.top].cells).map(cell => cell.type))];
  console.log(`${example.id}: ${Object.keys(result.netlist.modules[example.top].cells).length} cells (${types.join(', ')})`);
}
