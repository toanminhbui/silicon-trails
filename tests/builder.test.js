import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBuilder } from '../src/ui/builder.js';
import { CircuitSimulator } from '../src/core/simulator.js';
import { makeNetlistGraph, getGraphSignals } from '../src/ui/circuit-graph.js';

function simulate(builder) {
  const sim = new CircuitSimulator(builder.getNetlist());
  for (const [name, value] of Object.entries(builder.getInputs())) sim.setInput(name, value);
  return sim.settle();
}

test('builder cables drive arithmetic and a real clocked enabled register', () => {
  const builder = new CircuitBuilder();
  const sim = simulate(builder);
  assert.equal(sim.getCellPorts('add1').Y, 12);
  assert.equal(sim.getPort('output1'), null);
  sim.tick();
  assert.equal(sim.getPort('output1'), 12);
  sim.setInput('inputA', 20).setInput('inputEnable', 0).tick();
  assert.equal(sim.getPort('output1'), 12);
  sim.setInput('inputEnable', 1).tick();
  assert.equal(sim.getPort('output1'), 25);
});

test('replacing a cable changes execution and disconnected data stays unknown', () => {
  const builder = new CircuitBuilder();
  builder.connect({ from: 'inputB', fromPort: 'Y', to: 'add1', toPort: 'A' });
  let sim = simulate(builder).tick();
  assert.equal(sim.getPort('output1'), 10);
  assert.equal(builder.edges.filter((edge) => edge.to === 'add1' && edge.toPort === 'A').length, 1);
  builder.disconnectInput('register1', 'D');
  sim = simulate(builder).tick();
  assert.equal(sim.getPort('output1'), null);
  builder.connect({ from: 'inputA', to: 'register1', toPort: 'D' });
  assert.equal(simulate(builder).tick().getPort('output1'), 7);
});

test('invalid widths, directions, and combinational feedback reject atomically', () => {
  const builder = new CircuitBuilder();
  const before = builder.edges.map((edge) => ({ ...edge }));
  assert.throws(() => builder.connect({ from: 'inputEnable', to: 'add1', toPort: 'A' }), /width mismatch/);
  assert.throws(() => builder.connect({ from: 'add1', fromPort: 'A', to: 'register1', toPort: 'D' }), /not an output/);
  assert.throws(() => builder.connect({ from: 'add1', fromPort: 'Y', to: 'add1', toPort: 'A' }), /feedback/);
  assert.deepEqual(builder.edges, before);
  builder.connect({ from: 'register1', fromPort: 'Q', to: 'add1', toPort: 'A' });
  assert.doesNotThrow(() => simulate(builder).tick());
});

test('removing a driver disconnects its consumers instead of leaving stale data', () => {
  const builder = new CircuitBuilder();
  builder.remove('inputB');
  assert.equal(simulate(builder).getCellPorts('add1').B, null);
  assert.equal(simulate(builder).tick().getPort('output1'), null);
});

test('project round trips preserve placement, connections, and editable input values', () => {
  const original = new CircuitBuilder();
  original.setInput('inputA', 250);
  const mux = original.add('mux', [2, 0, 10]);
  original.connect({ from: 'inputEnable', to: mux, toPort: 'S' });
  const restored = CircuitBuilder.fromJSON(JSON.stringify(original.toJSON()));
  assert.deepEqual(restored.getDesign(), original.getDesign());
  assert.equal(simulate(restored).tick().getPort('output1'), 255);
  assert.throws(() => restored.setInput('inputEnable', 2), /1-bit/);
  assert.throws(() => restored.add('unsupported'), /Unsupported/);
});

test('project reload preserves unknown input state and stable cable IDs after rewiring', () => {
  const builder = new CircuitBuilder();
  builder.setInput('inputA', null);
  builder.disconnectInput('add1', 'A');
  builder.connect({ from: 'inputB', to: 'add1', toPort: 'A' });
  const restored = CircuitBuilder.fromJSON(builder.toJSON());
  assert.deepEqual(restored.getDesign(), builder.getDesign());
  assert.equal(restored.getInputs().inputA, null);
  assert.equal(simulate(restored).tick().getPort('output1'), 10);
});

test('builder visual values and cable values read the simulator net bits', () => {
  const builder = new CircuitBuilder();
  const sim = simulate(builder).tick();
  const graph = builder.getDesign();
  const values = getGraphSignals(graph, sim);
  assert.equal(values.nodeValues.add1.value, 12);
  assert.equal(values.nodeValues.register1.value, 12);
  assert.equal(values.nodeValues.output1.value, 12);
  const inputCable = graph.edges.find((edge) => edge.from === 'inputA');
  assert.equal(values.edgeValues[inputCable.id].value, 7);
});

test('netlist adapter preserves actual sliced bus wiring and constant/unknown inputs', () => {
  const netlist = { modules: { top: { ports: {
    a: { direction: 'input', bits: [2, 3, 4, 5] },
    y: { direction: 'output', bits: [6, 7, 8, 9] },
  }, cells: { gate: { type: '$or', attributes: { src: 'demo.v:2.1-2.12' },
    port_directions: { A: 'input', B: 'input', Y: 'output' },
    connections: { A: [5, 4, 3, 2], B: ['1', '0', 'x', '0'], Y: [6, 7, 8, 9] },
    parameters: { A_WIDTH: 4, B_WIDTH: 4, Y_WIDTH: 4 },
  } } } } };
  const graph = makeNetlistGraph(netlist);
  const sim = new CircuitSimulator(netlist).setInput('a', 1).settle();
  const bus = graph.edges.find((edge) => edge.from === 'input:a' && edge.to === 'cell:gate');
  assert.deepEqual(bus.bits, [5, 4, 3, 2]);
  assert.equal(getGraphSignals(graph, sim).edgeValues[bus.id].value, 8);
  assert.ok(graph.nodes.some((node) => node.id === 'constant:x' && node.semantic.kind === 'unknown'));
  assert.equal(graph.nodes.find((node) => node.cellId === 'gate').source, 'demo.v:2.1-2.12');
  assert.equal(getGraphSignals(graph, sim).nodeValues['output:y'].value, null);
});
