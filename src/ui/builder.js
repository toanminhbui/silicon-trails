import { CircuitSimulator } from '../core/simulator.js';

const port = (name, direction, width = 8) => ({ name, direction, width });
export const BUILDER_TYPES = Object.freeze({
  input: { label: 'Input · 8 bit', kind: 'input', ports: [port('Y', 'output')] },
  switch: { label: 'Switch · 1 bit', kind: 'input', ports: [port('Y', 'output', 1)] },
  output: { label: 'Output · 8 bit', kind: 'output', ports: [port('A', 'input')] },
  add: { label: 'ADD', kind: 'alu', cell: '$add', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output')] },
  and: { label: 'AND', kind: 'logic', cell: '$and', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output')] },
  or: { label: 'OR', kind: 'logic', cell: '$or', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output')] },
  xor: { label: 'XOR', kind: 'logic', cell: '$xor', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output')] },
  not: { label: 'NOT', kind: 'logic', cell: '$not', ports: [port('A', 'input'), port('Y', 'output')] },
  mux: { label: 'MUX', kind: 'control', cell: '$mux', ports: [port('A', 'input'), port('B', 'input'), port('S', 'input', 1), port('Y', 'output')] },
  register: { label: 'Register', kind: 'register', cell: '$dffe', ports: [port('D', 'input'), port('EN', 'input', 1), port('Q', 'output')] },
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const inputsOf = (type) => BUILDER_TYPES[type].ports.filter((p) => p.direction === 'input');
const outputsOf = (type) => BUILDER_TYPES[type].ports.filter((p) => p.direction === 'output');

/** The editor compiles its cables into the same RTL cell netlist as Yosys. */
export class CircuitBuilder {
  constructor({ empty = false } = {}) {
    this.nodes = new Map();
    this.edges = [];
    this.serial = 0;
    this.edgeSerial = 0;
    if (!empty) {
      this._insert({ id: 'inputA', type: 'input', label: 'Input A', position: [-10, 0, -4], value: 7 });
      this._insert({ id: 'inputB', type: 'input', label: 'Input B', position: [-10, 0, 3], value: 5 });
      this._insert({ id: 'inputEnable', type: 'switch', label: 'Write enable', position: [-3, 0, 8], value: 1 });
      this._insert({ id: 'add1', type: 'add', label: '8-bit adder', position: [-3, 0, -3] });
      this._insert({ id: 'register1', type: 'register', label: 'Enabled register', position: [4, 0, 0] });
      this._insert({ id: 'output1', type: 'output', label: 'Output', position: [11, 0, 0] });
      this.connect({ from: 'inputA', fromPort: 'Y', to: 'add1', toPort: 'A' });
      this.connect({ from: 'inputB', fromPort: 'Y', to: 'add1', toPort: 'B' });
      this.connect({ from: 'add1', fromPort: 'Y', to: 'register1', toPort: 'D' });
      this.connect({ from: 'inputEnable', fromPort: 'Y', to: 'register1', toPort: 'EN' });
      this.connect({ from: 'register1', fromPort: 'Q', to: 'output1', toPort: 'A' });
    }
  }

  _insert(node) {
    if (!Object.hasOwn(BUILDER_TYPES, node.type)) throw new Error(`Unsupported builder component ${node.type}`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.id) || node.id === 'clk' || node.id.startsWith('__st_')) throw new Error(`Invalid or reserved component ID ${node.id}`);
    if (this.nodes.has(node.id)) throw new Error(`Duplicate component ID ${node.id}`);
    if (!Array.isArray(node.position) || node.position.length !== 3 || !node.position.every(Number.isFinite)) throw new Error(`Invalid position for ${node.id}`);
    const record = { ...node, position: [...node.position], label: node.label || BUILDER_TYPES[node.type].label };
    this.nodes.set(record.id, record);
    if (['input', 'switch'].includes(record.type)) {
      try { this.setInput(record.id, record.value === undefined ? 0 : record.value); }
      catch (error) { this.nodes.delete(record.id); throw error; }
    }
    return record.id;
  }

  add(type, position = [0, 0, 0]) {
    if (!Object.hasOwn(BUILDER_TYPES, type)) throw new Error(`Unsupported builder component ${type}`);
    let id;
    do { id = `${type}_${++this.serial}`; } while (this.nodes.has(id));
    return this._insert({ id, type, position, value: 0 });
  }

  remove(id) {
    if (!this.nodes.delete(id)) throw new Error(`Unknown component ${id}`);
    this.edges = this.edges.filter((edge) => edge.from !== id && edge.to !== id);
  }

  setInput(nodeId, value) {
    const node = this.nodes.get(nodeId);
    if (!node || !['input', 'switch'].includes(node.type)) throw new Error(`${nodeId} is not an editable input`);
    const width = node.type === 'switch' ? 1 : 8;
    if (value !== null && (!Number.isInteger(value) || value < 0 || value >= 2 ** width)) throw new Error(`${nodeId} requires an unsigned ${width}-bit integer or null`);
    node.value = value;
  }

  connect({ from, fromPort, to, toPort }) {
    const source = this.nodes.get(from);
    const target = this.nodes.get(to);
    if (!source || !target) throw new Error('Both cable endpoints must exist');
    const out = fromPort ? BUILDER_TYPES[source.type].ports.find((p) => p.name === fromPort) : outputsOf(source.type)[0];
    const input = toPort ? BUILDER_TYPES[target.type].ports.find((p) => p.name === toPort) : inputsOf(target.type)[0];
    if (!out || out.direction !== 'output') throw new Error(`${from}.${fromPort || '?'} is not an output port`);
    if (!input || input.direction !== 'input') throw new Error(`${to}.${toPort || '?'} is not an input port`);
    if (out.width !== input.width) throw new Error(`Cable width mismatch: ${out.width}-bit ${from}.${out.name} → ${input.width}-bit ${to}.${input.name}`);
    const edge = { id: `cable_${++this.edgeSerial}`, from, fromPort: out.name, to, toPort: input.name, width: out.width };
    const previous = this.edges;
    this.edges = previous.filter((e) => e.to !== to || e.toPort !== input.name).concat(edge);
    try { new CircuitSimulator(this.getNetlist()); }
    catch (error) { this.edges = previous; throw error; }
    return edge.id;
  }

  disconnectInput(id, name) {
    const node = this.nodes.get(id);
    const port = node && BUILDER_TYPES[node.type].ports.find((p) => p.name === name);
    if (!port || port.direction !== 'input') throw new Error(`${id}.${name} is not an input port`);
    this.edges = this.edges.filter((edge) => edge.to !== id || edge.toPort !== name);
  }

  getInputs() {
    return { clk: 0, ...Object.fromEntries([...this.nodes.values()]
      .filter((node) => ['input', 'switch'].includes(node.type)).map((node) => [node.id, node.value])) };
  }

  getNetlist() {
    let nextBit = 3;
    const allocate = (width) => Array.from({ length: width }, () => nextBit++);
    const bus = new Map();
    const ports = { clk: { direction: 'input', bits: [2] } };
    const cells = {};
    const netnames = {};
    for (const node of this.nodes.values()) {
      for (const output of outputsOf(node.type)) bus.set(`${node.id}.${output.name}`, allocate(output.width));
    }
    const inputBits = (id, p) => {
      const edge = this.edges.find((e) => e.to === id && e.toPort === p.name);
      return edge ? [...bus.get(`${edge.from}.${edge.fromPort}`)] : Array(p.width).fill('x');
    };
    for (const node of this.nodes.values()) {
      const spec = BUILDER_TYPES[node.type];
      if (['input', 'switch'].includes(node.type)) {
        const bits = bus.get(`${node.id}.Y`);
        ports[node.id] = { direction: 'input', bits: [...bits] };
        netnames[node.id] = { hide_name: 0, bits: [...bits], attributes: {} };
      } else if (node.type === 'output') {
        ports[node.id] = { direction: 'output', bits: inputBits(node.id, spec.ports[0]) };
      } else {
        const connections = {};
        const directions = {};
        for (const p of spec.ports) {
          connections[p.name] = p.direction === 'output' ? [...bus.get(`${node.id}.${p.name}`)] : inputBits(node.id, p);
          directions[p.name] = p.direction;
        }
        let parameters;
        if (node.type === 'register') {
          connections.CLK = [2]; directions.CLK = 'input';
          parameters = { WIDTH: 8, CLK_POLARITY: 1, EN_POLARITY: 1 };
        } else if (node.type === 'mux') parameters = { WIDTH: 8 };
        else parameters = { A_WIDTH: 8, B_WIDTH: 8, Y_WIDTH: 8, A_SIGNED: 0, B_SIGNED: 0 };
        cells[node.id] = { type: spec.cell, parameters, attributes: { src: `builder:${node.id}` }, port_directions: directions, connections };
        for (const p of outputsOf(node.type)) netnames[`${node.id}_${p.name}`] = { hide_name: 0, bits: [...connections[p.name]], attributes: {} };
      }
    }
    return { creator: 'Silicon Trails structural builder', modules: { top: { attributes: { top: 1 }, ports, cells, netnames } } };
  }

  getDesign() {
    const module = this.getNetlist().modules.top;
    const nodes = [...this.nodes.values()].map((node) => {
      const spec = BUILDER_TYPES[node.type];
      const output = outputsOf(node.type)[0];
      const bits = ['input', 'switch', 'output'].includes(node.type)
        ? module.ports[node.id].bits : module.cells[node.id].connections[output.name];
      return {
        ...clone(node), kind: spec.kind, width: node.type === 'switch' ? 1 : 8,
        ports: clone(spec.ports), bits: [...bits], source: `builder:${node.id}`, scope: 'top',
        ...(['input', 'switch'].includes(node.type) ? { inputName: node.id }
          : node.type === 'output' ? { outputName: node.id } : { cellId: node.id, valuePort: output.name }),
      };
    });
    const edges = this.edges.map((edge) => {
      const source = nodes.find((node) => node.id === edge.from);
      return { ...edge, bits: [...source.bits], label: `${edge.fromPort} → ${edge.toPort}` };
    });
    return { nodes, edges };
  }

  toJSON() {
    return { version: 1, nodes: clone([...this.nodes.values()]), edges: clone(this.edges), serial: this.serial, edgeSerial: this.edgeSerial };
  }

  static fromJSON(data) {
    if (typeof data === 'string') data = JSON.parse(data);
    if (data?.version !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('Unsupported or invalid circuit project');
    const builder = new CircuitBuilder({ empty: true });
    data.nodes.forEach((node) => builder._insert(node));
    const destinations = new Set();
    data.edges.forEach((edge) => {
      const key = `${edge.to}.${edge.toPort}`;
      if (destinations.has(key)) throw new Error(`Multiple saved drivers for ${key}`);
      destinations.add(key);
      builder.connect(edge);
    });
    const edgeIds = new Set();
    builder.edges.forEach((edge, index) => {
      const savedId = data.edges[index]?.id;
      if (typeof savedId === 'string' && savedId) edge.id = savedId;
      if (edgeIds.has(edge.id)) throw new Error(`Duplicate cable ID ${edge.id}`);
      edgeIds.add(edge.id);
    });
    builder.serial = Number.isInteger(data.serial) && data.serial >= 0 ? data.serial : 0;
    builder.edgeSerial = Math.max(builder.edgeSerial, Number.isInteger(data.edgeSerial) ? data.edgeSerial : 0,
      ...builder.edges.map((edge) => Number(/^cable_(\d+)$/.exec(edge.id)?.[1] || 0)));
    return builder;
  }

  toVerilog() {
    const topPorts = ['input wire clk'];
    const lines = ['// Structural circuit exported from Silicon Trails.', '// Disconnected inputs remain X; registers start unknown until clocked.'];
    const signalName = (id, name) => ['input', 'switch'].includes(this.nodes.get(id).type) ? id : `__st_${id}_${name}`;
    const inputExpr = (id, p) => {
      const edge = this.edges.find((e) => e.to === id && e.toPort === p.name);
      return edge ? signalName(edge.from, edge.fromPort) : `${p.width}'b${'x'.repeat(p.width)}`;
    };
    for (const node of this.nodes.values()) {
      if (['input', 'switch'].includes(node.type)) topPorts.push(`input wire ${node.type === 'switch' ? '' : '[7:0] '}${node.id}`);
      if (node.type === 'output') topPorts.push(`output wire [7:0] ${node.id}`);
    }
    lines.push(`module top(\n  ${topPorts.join(',\n  ')}\n);`);
    for (const node of this.nodes.values()) {
      const spec = BUILDER_TYPES[node.type];
      if (['input', 'switch', 'output'].includes(node.type)) continue;
      const out = outputsOf(node.type)[0];
      lines.push(`  ${node.type === 'register' ? 'reg' : 'wire'} [7:0] ${signalName(node.id, out.name)};`);
    }
    for (const node of this.nodes.values()) {
      const spec = BUILDER_TYPES[node.type];
      const get = (name) => inputExpr(node.id, spec.ports.find((p) => p.name === name));
      const out = outputsOf(node.type)[0];
      const y = out && signalName(node.id, out.name);
      if (node.type === 'output') lines.push(`  assign ${node.id} = ${get('A')};`);
      else if (node.type === 'register') lines.push(`  always @(posedge clk) if (${get('EN')}) ${y} <= ${get('D')};`);
      else if (node.type === 'mux') lines.push(`  assign ${y} = ${get('S')} ? ${get('B')} : ${get('A')};`);
      else if (node.type === 'not') lines.push(`  assign ${y} = ~${get('A')};`);
      else if (['add', 'and', 'or', 'xor'].includes(node.type)) {
        const op = { add: '+', and: '&', or: '|', xor: '^' }[node.type];
        lines.push(`  assign ${y} = ${get('A')} ${op} ${get('B')};`);
      }
    }
    lines.push('endmodule', '');
    return lines.join('\n');
  }
}
