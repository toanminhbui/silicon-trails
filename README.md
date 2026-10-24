# Silicon Trails

A browser-based computer architecture workshop. Explore a processor, inspect its live signals, build circuits, and turn Verilog into hardware you can walk around.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
npm test
npm run build
```

The first implementation is in progress. The circuit simulator, RTL frontend, and spatial renderer are independent modules sharing synthesized netlist data.

See [the implementation contract](docs/implementation-contract.md) for module interfaces.
