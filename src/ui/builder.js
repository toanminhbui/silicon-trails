import { CircuitSimulator } from '../core/simulator.js';

const port = (name, direction, width = 8) => ({ name, direction, width });
export const BUILDER_TYPES = Object.freeze({
  input: { label: 'Input · 8 bit', kind: 'input', ports: [port('Y', 'output')] },
  switch: { label: 'Switch · 1 bit', kind: 'input', ports: [port('Y', 'output', 1)] },
  output: { label: 'Output · 8 bit', kind: 'output', ports: [port('A', 'input')] },
  add: { label: 'ADD', kind: 'alu', cell: '$add', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output')] },
  sub: { label: 'SUB', kind: 'alu', cell: '$sub', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output')] },
  mul: { label: 'MUL', kind: 'alu', cell: '$mul', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output')] },
  eq: { label: 'Equal', kind: 'control', cell: '$eq', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output', 1)] },
  lt: { label: 'Less than', kind: 'control', cell: '$lt', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output', 1)] },
  shl: { label: 'Shift left', kind: 'alu', cell: '$shl', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output')] },
  shr: { label: 'Shift right', kind: 'alu', cell: '$shr', ports: [port('A', 'input'), port('B', 'input'), port('Y', 'output')] },
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
const verilogRange = (width) => width === 1 ? '' : `[${width - 1}:0] `;
const BINARY_OPERATORS = { add: '+', sub: '-', mul: '*', eq: '==', lt: '<', shl: '<<', shr: '>>', and: '&', or: '|', xor: '^' };

const IO_TYPES = new Set(['input', 'switch', 'output']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PORTS = new Set('clk accept_on alias always always_comb always_ff always_latch and assert assign assume automatic before begin bind bins binsof bit break buf bufif0 bufif1 byte case casex casez cell chandle checker class clocking cmos config const constraint context continue cover covergroup coverpoint cross deassign default defparam design disable dist do edge else end endcase endchecker endclass endclocking endconfig endfunction endgenerate endgroup endinterface endmodule endpackage endprimitive endprogram endproperty endspecify endsequence endtable endtask enum event eventually expect export extends extern final first_match for force foreach forever fork forkjoin function generate genvar global highz0 highz1 if iff ifnone ignore_bins illegal_bins implements implies import incdir include initial inout input inside instance int integer interconnect interface intersect join join_any join_none large let liblist library local localparam logic longint macromodule matches medium modport module nand negedge nettype new nexttime nmos nor noshowcancelled not notif0 notif1 null or output package packed parameter pmos posedge primitive priority program property protected pull0 pull1 pulldown pullup pulsestyle_ondetect pulsestyle_onevent pure rand randc randcase randsequence rcmos real realtime ref reg reject_on release repeat restrict return rnmos rpmos rtran rtranif0 rtranif1 s_always s_eventually s_nexttime s_until s_until_with scalared sequence shortint shortreal showcancelled signed small soft solve specify specparam static string strong strong0 strong1 struct super supply0 supply1 sync_accept_on sync_reject_on table tagged task this throughout time timeprecision timeunit tran tranif0 tranif1 tri tri0 tri1 triand trior trireg type typedef union unique unique0 unsigned until until_with untyped use uwire var vectored virtual void wait wait_order wand weak weak0 weak1 while wildcard wire with within wor xnor xor'.split(' '));
const immutable = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
};
const fullId = (path, id) => [...path, id].join('/');
const validPosition = (position) => Array.isArray(position) && position.length === 3 && position.every(Number.isFinite);
const validId = (id) => typeof id === 'string' && IDENTIFIER.test(id) && id !== 'clk' && !id.startsWith('__st_');
const validPortName = (name) => typeof name === 'string' && IDENTIFIER.test(name) && !RESERVED_PORTS.has(name) && !name.startsWith('__st_');

/** Structural circuits and immutable reusable modules share one flattened simulator. */
export class CircuitBuilder {
  constructor({ empty = false } = {}) {
    this.nodes = new Map(); this.edges = []; this.modules = new Map();
    this.serial = 0; this.edgeSerial = 0; this.moduleSerial = 0;
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

  getSpec(nodeOrId) {
    let node = nodeOrId;
    if (typeof nodeOrId === 'string') {
      if (nodeOrId.includes('/')) {
        const ids = nodeOrId.split('/');
        let nodes = this.nodes;
        for (let index = 0; index < ids.length; index++) {
          node = nodes.get(ids[index]);
          if (!node) throw new Error(`Unknown component ${nodeOrId}`);
          if (index < ids.length - 1) {
            const definition = node.type === 'module' && this.modules.get(node.moduleId);
            if (!definition) throw new Error(`Unknown module path ${nodeOrId}`);
            nodes = new Map(definition.nodes.map((n) => [n.id, n]));
          }
        }
      } else node = this.nodes.get(nodeOrId) || { type: nodeOrId };
    }
    if (!node) throw new Error('Unknown component');
    if (node.type === 'module') {
      const definition = this.modules.get(node.moduleId);
      if (!definition) throw new Error(`Unknown module ${node.moduleId}`);
      return { label: definition.name, kind: 'module', ports: definition.ports.map(({ name, direction, width }) => ({ name, direction, width })) };
    }
    if (!Object.hasOwn(BUILDER_TYPES, node.type)) throw new Error(`Unsupported builder component ${node.type}`);
    return clone(BUILDER_TYPES[node.type]);
  }

  _insert(node) {
    this.getSpec(node);
    if (!validId(node.id)) throw new Error(`Invalid or reserved component ID ${node.id}`);
    if (this.nodes.has(node.id)) throw new Error(`Duplicate component ID ${node.id}`);
    if (!validPosition(node.position)) throw new Error(`Invalid position for ${node.id}`);
    const record = { ...clone(node), label: node.label || this.getSpec(node).label };
    this.nodes.set(record.id, record);
    if (record.type === 'input' || record.type === 'switch') {
      try { this.setInput(record.id, record.value === undefined ? 0 : record.value); }
      catch (error) { this.nodes.delete(record.id); throw error; }
    }
    return record.id;
  }

  _nextId(type) {
    let id; do { id = `${type}_${++this.serial}`; } while (this.nodes.has(id));
    return id;
  }
  add(type, position = [0, 0, 0]) {
    if (!Object.hasOwn(BUILDER_TYPES, type)) throw new Error(`Unsupported builder component ${type}`);
    return this._insert({ id: this._nextId(type), type, position, value: 0 });
  }
  addModule(moduleId, position = [0, 0, 0]) {
    if (!this.modules.has(moduleId)) throw new Error(`Unknown module ${moduleId}`);
    const id = this._insert({ id: this._nextId('module'), type: 'module', moduleId, position });
    try { new CircuitSimulator(this.getNetlist()); }
    catch (error) { this.nodes.delete(id); throw error; }
    return id;
  }
  remove(id) {
    if (!this.nodes.delete(id)) throw new Error(`Unknown component ${id}`);
    this.edges = this.edges.filter((edge) => edge.from !== id && edge.to !== id);
  }
  setInput(id, value) {
    const node = this.nodes.get(id);
    if (!node || !['input', 'switch'].includes(node.type)) throw new Error(`${id} is not an editable input`);
    const width = this.getSpec(node).ports.find((p) => p.direction === 'output').width;
    if (value !== null && (!Number.isInteger(value) || value < 0 || value >= 2 ** width)) throw new Error(`${id} requires an unsigned ${width}-bit integer or null`);
    node.value = value;
  }
  _checkedConnection(connection, nodes) {
    const { from, to, fromPort, toPort } = connection;
    const source = nodes.get(from), target = nodes.get(to);
    if (!source || !target) throw new Error('Both cable endpoints must exist');
    const out = this.getSpec(source).ports.find((p) => fromPort ? p.name === fromPort : p.direction === 'output');
    const input = this.getSpec(target).ports.find((p) => toPort ? p.name === toPort : p.direction === 'input');
    if (!out || out.direction !== 'output') throw new Error(`${from}.${fromPort || '?'} is not an output port`);
    if (!input || input.direction !== 'input') throw new Error(`${to}.${toPort || '?'} is not an input port`);
    if (out.width !== input.width) throw new Error(`Cable width mismatch: ${out.width}-bit ${from}.${out.name} → ${input.width}-bit ${to}.${input.name}`);
    return { ...connection, fromPort: out.name, toPort: input.name, width: out.width };
  }
  connect(connection) {
    const edge = { ...this._checkedConnection(connection, this.nodes), id: `cable_${++this.edgeSerial}` };
    const previous = this.edges;
    this.edges = previous.filter((e) => e.to !== edge.to || e.toPort !== edge.toPort).concat(edge);
    try { new CircuitSimulator(this.getNetlist()); }
    catch (error) { this.edges = previous; throw error; }
    return edge.id;
  }
  disconnectInput(id, name) {
    const node = this.nodes.get(id), p = node && this.getSpec(node).ports.find((p) => p.name === name);
    if (!p || p.direction !== 'input') throw new Error(`${id}.${name} is not an input port`);
    this.edges = this.edges.filter((e) => e.to !== id || e.toPort !== name);
  }
  getInputs() {
    return { clk: 0, ...Object.fromEntries([...this.nodes.values()].filter((n) => n.type === 'input' || n.type === 'switch').map((n) => [n.id, n.value])) };
  }

  listModules() { return [...this.modules.values()].map((definition) => ({ ...clone(definition), nodeCount: definition.nodes.length })); }

  previewModule(nodeIds) {
    if (!Array.isArray(nodeIds) || !nodeIds.length) throw new Error('Select at least one functional component to package');
    const ids = [...new Set(nodeIds)], selected = new Set(ids);
    const nodes = ids.map((id) => {
      const node = this.nodes.get(id);
      if (!node) throw new Error(`Unknown root component ${id}`);
      if (IO_TYPES.has(node.type)) throw new Error('Keep Input, Switch, and Output outside modules as external drivers and probes');
      return node;
    });
    const position = [0, 1, 2].map((axis) => nodes.reduce((sum, n) => sum + n.position[axis], 0) / nodes.length);
    const ports = [], inputs = new Map();
    for (const node of nodes) for (const p of this.getSpec(node).ports) {
      if (p.direction !== 'input') continue;
      const driver = this.edges.find((e) => e.to === node.id && e.toPort === p.name);
      if (driver && selected.has(driver.from)) continue;
      const key = driver ? `input:${driver.from}.${driver.fromPort}` : `input:${node.id}.${p.name}`;
      if (!inputs.has(key)) {
        const boundary = { key, name: `${node.id}_${p.name}`, direction: 'input', width: p.width, bindings: [] };
        inputs.set(key, boundary); ports.push(boundary);
      }
      inputs.get(key).bindings.push({ nodeId: node.id, port: p.name });
    }
    const allOutputs = [];
    for (const node of nodes) for (const p of this.getSpec(node).ports) {
      if (p.direction !== 'output') continue;
      const consumers = this.edges.filter((e) => e.from === node.id && e.fromPort === p.name);
      const boundary = { key: `output:${node.id}.${p.name}`, name: `${node.id}_${p.name}`, direction: 'output', width: p.width, bindings: [{ nodeId: node.id, port: p.name }] };
      allOutputs.push(boundary);
      if (!consumers.length || consumers.some((e) => !selected.has(e.to))) ports.push(boundary);
    }
    if (!ports.some((p) => p.direction === 'output')) ports.push(...allOutputs);
    const names = new Set();
    for (const p of ports) {
      const base = validPortName(p.name) ? p.name : `port_${p.name}`;
      let name = base, suffix = 2;
      while (names.has(name)) name = `${base}_${suffix++}`;
      p.name = name; names.add(name);
    }
    return { nodeIds: ids, position, ports: clone(ports), nodeCount: nodes.length };
  }

  createModule({ name, nodeIds, portNames = {} }) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Give the module a name of at most 80 characters');
    const preview = this.previewModule(nodeIds), selected = new Set(preview.nodeIds);
    const names = new Set();
    const ports = preview.ports.map((p) => {
      const renamed = portNames[p.name] ?? portNames[p.key] ?? p.name;
      if (!validPortName(renamed) || names.has(renamed)) throw new Error(`Invalid, reserved, or duplicate module port ${renamed}`);
      names.add(renamed); return { ...p, name: renamed };
    });
    let moduleId; do { moduleId = `moduledef_${++this.moduleSerial}`; } while (this.modules.has(moduleId));
    const definition = immutable({ id: moduleId, name: name.trim(), ports, nodes: preview.nodeIds.map((id) => {
      const node = clone(this.nodes.get(id)); node.position = node.position.map((v, axis) => v - preview.position[axis]); return node;
    }), edges: clone(this.edges.filter((e) => selected.has(e.from) && selected.has(e.to))) });
    const oldNodes = this.nodes, oldEdges = this.edges, oldModules = this.modules;
    this.nodes = new Map(oldNodes); this.modules = new Map(oldModules);
    this.modules.set(moduleId, definition);
    preview.nodeIds.forEach((id) => this.nodes.delete(id));
    const instanceId = this._insert({ id: this._nextId('module'), type: 'module', moduleId, label: name.trim(), position: preview.position });
    const boundaryFor = (direction, id, port) => ports.find((p) => p.direction === direction && p.bindings.some((b) => b.nodeId === id && b.port === port));
    const driven = new Set();
    this.edges = oldEdges.flatMap((edge) => {
      const fromInside = selected.has(edge.from), toInside = selected.has(edge.to);
      if (fromInside && toInside) return [];
      const result = { ...edge };
      if (fromInside) { result.from = instanceId; result.fromPort = boundaryFor('output', edge.from, edge.fromPort).name; }
      if (toInside) { result.to = instanceId; result.toPort = boundaryFor('input', edge.to, edge.toPort).name; }
      const key = `${result.to}.${result.toPort}`;
      if (driven.has(key)) return [];
      driven.add(key); return [result];
    });
    try { new CircuitSimulator(this.getNetlist()); }
    catch (error) { this.nodes = oldNodes; this.edges = oldEdges; this.modules = oldModules; throw error; }
    return { moduleId, instanceId };
  }

  _validateModules() {
    const visiting = new Set(), done = new Set();
    const visit = (id) => {
      if (visiting.has(id)) throw new Error(`Recursive module hierarchy involving ${id}`);
      if (done.has(id)) return;
      const def = this.modules.get(id);
      if (!def || def.id !== id || !validId(id) || typeof def.name !== 'string' || !def.name.trim() || def.name.length > 80 || !Array.isArray(def.nodes) || !def.nodes.length || !Array.isArray(def.edges) || !Array.isArray(def.ports)) throw new Error(`Invalid module definition ${id}`);
      visiting.add(id);
      const nodes = new Map();
      for (const node of def.nodes) {
        if (!validId(node.id) || nodes.has(node.id) || !validPosition(node.position) || IO_TYPES.has(node.type)) throw new Error(`Invalid internal component in module ${id}`);
        if (node.type === 'module') visit(node.moduleId);
        else if (!Object.hasOwn(BUILDER_TYPES, node.type)) throw new Error(`Unsupported builder component ${node.type}`);
        nodes.set(node.id, node);
      }
      const drivers = new Set(), edgeIds = new Set();
      for (const edge of def.edges) {
        const checked = this._checkedConnection(edge, nodes), key = `${checked.to}.${checked.toPort}`;
        if (typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id) || checked.fromPort !== edge.fromPort || checked.toPort !== edge.toPort || edge.width !== undefined && edge.width !== checked.width) throw new Error(`Invalid internal cable in module ${id}`);
        edgeIds.add(edge.id);
        if (drivers.has(key)) throw new Error(`Multiple internal drivers for ${id}.${key}`);
        drivers.add(key);
      }
      const names = new Set(), boundInputs = new Set();
      for (const p of def.ports) {
        if (!validPortName(p.name) || names.has(p.name) || !['input', 'output'].includes(p.direction) || !Array.isArray(p.bindings) || !p.bindings.length || p.direction === 'output' && p.bindings.length !== 1) throw new Error(`Invalid boundary port in module ${id}`);
        names.add(p.name);
        for (const binding of p.bindings) {
          if (!binding || typeof binding.nodeId !== 'string' || typeof binding.port !== 'string') throw new Error(`Invalid binding at ${id}.${p.name}`);
          const node = nodes.get(binding.nodeId), target = node && this.getSpec(node).ports.find((entry) => entry.name === binding.port);
          if (!target || target.direction !== p.direction || target.width !== p.width) throw new Error(`Invalid binding or width at ${id}.${p.name}`);
          if (p.direction === 'input') {
            const key = `${binding.nodeId}.${binding.port}`;
            if (drivers.has(key) || boundInputs.has(key)) throw new Error(`Multiple boundary drivers at ${id}.${key}`);
            boundInputs.add(key);
          }
        }
      }
      visiting.delete(id); done.add(id);
    };
    for (const id of this.modules.keys()) visit(id);
  }

  _flatten(rootNodes = this.nodes, rootEdges = this.edges) {
    this._validateModules();
    const contexts = new Map(), records = new Map();
    const expand = (nodes, edges, path, definition = null) => {
      if (path.length > 32 || records.size > 4096) throw new Error('Module hierarchy exceeds the workshop size limit');
      const context = { nodes: nodes instanceof Map ? nodes : new Map(nodes.map((n) => [n.id, n])), edges, path, definition };
      contexts.set(path.join('/'), context);
      for (const node of context.nodes.values()) {
        const id = fullId(path, node.id); records.set(id, { node, context, id });
        if (node.type === 'module') { const def = this.modules.get(node.moduleId); if (!def) throw new Error(`Unknown module ${node.moduleId}`); expand(def.nodes, def.edges, [...path, node.id], def); }
      }
    };
    expand(rootNodes, rootEdges, []);
    let nextBit = 3;
    const allocate = (width) => Array.from({ length: width }, () => nextBit++);
    const buses = new Map(), ports = { clk: { direction: 'input', bits: [2] } }, cells = {}, netnames = {};
    for (const [id, record] of records) {
      if (record.node.type === 'module' || record.node.type === 'output') continue;
      for (const p of this.getSpec(record.node).ports.filter((p) => p.direction === 'output')) buses.set(`${id}.${p.name}`, allocate(p.width));
    }
    const outputBits = (id, name) => {
      const record = records.get(id); if (!record) throw new Error(`Unknown flattened component ${id}`);
      if (record.node.type !== 'module') {
        const bus = buses.get(`${id}.${name}`); if (!bus) throw new Error(`Unknown output ${id}.${name}`); return bus;
      }
      const p = this.modules.get(record.node.moduleId).ports.find((p) => p.direction === 'output' && p.name === name);
      if (!p) throw new Error(`Unknown module output ${id}.${name}`);
      return outputBits(`${id}/${p.bindings[0].nodeId}`, p.bindings[0].port);
    };
    const inputBits = (id, name) => {
      const record = records.get(id); if (!record) throw new Error(`Unknown flattened component ${id}`);
      const spec = this.getSpec(record.node).ports.find((p) => p.direction === 'input' && p.name === name);
      if (!spec) throw new Error(`Unknown input ${id}.${name}`);
      const driver = record.context.edges.find((edge) => edge.to === record.node.id && edge.toPort === name);
      if (driver) return outputBits(fullId(record.context.path, driver.from), driver.fromPort);
      const boundary = record.context.definition?.ports.find((p) => p.direction === 'input' && p.bindings.some((b) => b.nodeId === record.node.id && b.port === name));
      if (boundary) return inputBits(record.context.path.join('/'), boundary.name);
      return Array(spec.width).fill('x');
    };
    for (const [id, { node }] of records) {
      const spec = this.getSpec(node);
      if (node.type === 'module') continue;
      if (node.type === 'input' || node.type === 'switch') {
        if (id.includes('/')) throw new Error('Module definitions cannot contain external input controls');
        ports[id] = { direction: 'input', bits: [...outputBits(id, 'Y')] };
        netnames[id] = { hide_name: 0, bits: [...ports[id].bits], attributes: {} };
      } else if (node.type === 'output') ports[id] = { direction: 'output', bits: [...inputBits(id, 'A')] };
      else {
        const connections = {}, directions = {};
        for (const p of spec.ports) { connections[p.name] = [...(p.direction === 'output' ? outputBits(id, p.name) : inputBits(id, p.name))]; directions[p.name] = p.direction; }
        let parameters;
        if (node.type === 'register') { connections.CLK = [2]; directions.CLK = 'input'; parameters = { WIDTH: connections.Q.length, CLK_POLARITY: 1, EN_POLARITY: 1 }; }
        else if (node.type === 'mux') parameters = { WIDTH: connections.Y.length };
        else { parameters = { A_WIDTH: connections.A.length, Y_WIDTH: connections.Y.length, A_SIGNED: 0 }; if (connections.B) { parameters.B_WIDTH = connections.B.length; parameters.B_SIGNED = 0; } }
        cells[id] = { type: spec.cell, parameters, attributes: { src: `builder:${id}` }, port_directions: directions, connections };
        for (const p of spec.ports.filter((p) => p.direction === 'output')) netnames[`${id}_${p.name}`] = { hide_name: 0, bits: [...connections[p.name]], attributes: {} };
      }
    }
    return { netlist: { creator: 'Silicon Trails structural builder', modules: { top: { attributes: { top: 1 }, ports, cells, netnames } } }, contexts, records, inputBits, outputBits };
  }
  getNetlist() { return this._flatten().netlist; }

  resolvePath(path = []) {
    if (!Array.isArray(path)) throw new Error('Module path must be an array of instance IDs');
    let nodes = this.nodes, definition = null, instance = null;
    for (const id of path) {
      instance = nodes.get(id);
      if (!instance || instance.type !== 'module') throw new Error(`Unknown module instance path ${path.join('/')}`);
      definition = this.modules.get(instance.moduleId);
      if (!definition) throw new Error(`Unknown module ${instance.moduleId}`);
      nodes = new Map(definition.nodes.map((n) => [n.id, n]));
    }
    return { path: [...path], name: definition?.name || 'Root workshop', definition: definition ? clone(definition) : null, instance: instance ? clone(instance) : null };
  }
  getDefinitionForPath(path = []) { return this.resolvePath(path).definition; }
  getInstancePorts(path) {
    this.resolvePath(path);
    if (!path.length) return [];
    const flat = this._flatten(), id = path.join('/'), record = flat.records.get(id);
    return this.getSpec(record.node).ports.map((p) => ({ ...p, bits: [...(p.direction === 'output' ? flat.outputBits(id, p.name) : flat.inputBits(id, p.name))] }));
  }

  getDesign({ path = [] } = {}) {
    this.resolvePath(path);
    const flat = this._flatten(), context = flat.contexts.get(path.join('/'));
    const nodes = [...context.nodes.values()].map((node) => {
      const id = fullId(path, node.id), spec = this.getSpec(node), output = spec.ports.find((p) => p.direction === 'output');
      const ports = spec.ports.map((p) => ({ ...p, bits: [...(p.direction === 'output' ? flat.outputBits(id, p.name) : flat.inputBits(id, p.name))] }));
      const bits = node.type === 'output' ? ports[0].bits : output ? ports.find((p) => p.name === output.name).bits : [];
      return { ...clone(node), id, localId: node.id, kind: spec.kind, width: bits.length || 1, ports, bits: [...bits], source: `builder:${id}`, scope: path.join('/') || 'top',
        ...(node.type === 'input' || node.type === 'switch' ? { inputName: id } : node.type === 'output' ? { outputName: id } : node.type === 'module' ? { instancePath: [...path, node.id] } : { cellId: id, valuePort: output.name }) };
    });
    const edges = context.edges.map((e) => ({ ...e, id: fullId(path, e.id), from: fullId(path, e.from), to: fullId(path, e.to), bits: [...flat.outputBits(fullId(path, e.from), e.fromPort)], label: `${e.fromPort} → ${e.toPort}` }));
    if (context.definition) {
      const xs = nodes.map((n) => n.position[0]), left = Math.min(...xs) - 7, right = Math.max(...xs) + 7;
      for (const [index, p] of context.definition.ports.entries()) {
        const input = p.direction === 'input', boundaryId = `${path.join('/')}/@${p.direction}:${p.name}`;
        const bits = input ? flat.inputBits(path.join('/'), p.name) : flat.outputBits(path.join('/'), p.name);
        nodes.push({ id: boundaryId, label: p.name, type: 'module-port', kind: p.direction, boundary: true, width: p.width, bits: [...bits], position: [input ? left : right, 0, (index - context.definition.ports.length / 2) * 3.5], ports: [{ name: input ? 'Y' : 'A', direction: input ? 'output' : 'input', width: p.width, bits: [...bits] }], source: `module:${context.definition.id}`, scope: path.join('/') });
        p.bindings.forEach((binding, j) => {
          const internalId = fullId(path, binding.nodeId);
          edges.push({ id: `${boundaryId}:${j}`, from: input ? boundaryId : internalId, fromPort: input ? 'Y' : binding.port, to: input ? internalId : boundaryId, toPort: input ? binding.port : 'A', width: p.width, bits: [...bits], label: p.name });
        });
      }
    }
    return { nodes, edges, path: [...path], readOnly: path.length > 0 };
  }

  toJSON() {
    return { version: 1, nodes: clone([...this.nodes.values()]), edges: clone(this.edges), serial: this.serial, edgeSerial: this.edgeSerial, moduleSerial: this.moduleSerial, modules: clone([...this.modules.values()]) };
  }
  static fromJSON(data) {
    if (typeof data === 'string') data = JSON.parse(data);
    if (data?.version !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.edges) || data.modules !== undefined && !Array.isArray(data.modules)) throw new Error('Unsupported or invalid circuit project');
    const builder = new CircuitBuilder({ empty: true });
    for (const definition of data.modules || []) {
      if (!definition || builder.modules.has(definition.id)) throw new Error('Duplicate or invalid module definition');
      builder.modules.set(definition.id, immutable(clone(definition)));
    }
    builder._validateModules();
    data.nodes.forEach((node) => builder._insert(node));
    const destinations = new Set(), edgeIds = new Set();
    data.edges.forEach((edge) => {
      const checked = builder._checkedConnection(edge, builder.nodes), key = `${checked.to}.${checked.toPort}`;
      if (destinations.has(key)) throw new Error(`Multiple saved drivers for ${key}`);
      destinations.add(key);
      const id = typeof edge.id === 'string' && edge.id ? edge.id : `cable_${++builder.edgeSerial}`;
      if (edgeIds.has(id)) throw new Error(`Duplicate cable ID ${id}`);
      edgeIds.add(id); builder.edges.push({ ...checked, id });
    });
    builder.serial = Number.isInteger(data.serial) && data.serial >= 0 ? data.serial : 0;
    builder.moduleSerial = Number.isInteger(data.moduleSerial) && data.moduleSerial >= 0 ? data.moduleSerial : 0;
    builder.edgeSerial = Math.max(builder.edgeSerial, Number.isInteger(data.edgeSerial) ? data.edgeSerial : 0, ...builder.edges.map((e) => Number(/^cable_(\d+)$/.exec(e.id)?.[1] || 0)));
    new CircuitSimulator(builder.getNetlist());
    for (const definition of builder.modules.values()) {
      const dummy = new Map([['module_validation', { id: 'module_validation', type: 'module', moduleId: definition.id, position: [0, 0, 0] }]]);
      new CircuitSimulator(builder._flatten(dummy, []).netlist);
    }
    return builder;
  }

  toVerilog() {
    this._validateModules();
    const moduleName = (id) => `__st_definition_${id}`;
    const emit = (name, nodes, edges, definition = null) => {
      const records = nodes instanceof Map ? [...nodes.values()] : nodes;
      const byId = new Map(records.map((n) => [n.id, n]));
      const signalName = (id, p) => ['input', 'switch'].includes(byId.get(id).type) ? id : `__st_${id}_${p}`;
      const expression = (id, p) => {
        const edge = edges.find((e) => e.to === id && e.toPort === p.name);
        if (edge) return signalName(edge.from, edge.fromPort);
        const boundary = definition?.ports.find((entry) => entry.direction === 'input' && entry.bindings.some((b) => b.nodeId === id && b.port === p.name));
        return boundary ? boundary.name : `${p.width}'b${'x'.repeat(p.width)}`;
      };
      const ports = ['input wire clk'];
      if (definition) ports.push(...definition.ports.map((p) => `${p.direction} wire ${verilogRange(p.width)}${p.name}`));
      else for (const node of records) {
        const spec = this.getSpec(node);
        if (node.type === 'input' || node.type === 'switch') ports.push(`input wire ${verilogRange(spec.ports[0].width)}${node.id}`);
        if (node.type === 'output') ports.push(`output wire ${verilogRange(spec.ports[0].width)}${node.id}`);
      }
      const lines = [`module ${name}(\n  ${ports.join(',\n  ')}\n);`];
      for (const node of records) {
        if (IO_TYPES.has(node.type)) continue;
        for (const p of this.getSpec(node).ports.filter((p) => p.direction === 'output')) lines.push(`  ${node.type === 'register' ? 'reg' : 'wire'} ${verilogRange(p.width)}${signalName(node.id, p.name)};`);
      }
      for (const node of records) {
        const spec = this.getSpec(node), get = (name) => expression(node.id, spec.ports.find((p) => p.name === name));
        const output = spec.ports.find((p) => p.direction === 'output'), y = output && signalName(node.id, output.name);
        if (node.type === 'module') {
          const connections = ['.clk(clk)', ...spec.ports.map((p) => `.${p.name}(${p.direction === 'output' ? signalName(node.id, p.name) : expression(node.id, p)})`)];
          lines.push(`  ${moduleName(node.moduleId)} ${node.id} (${connections.join(', ')});`);
        } else if (node.type === 'output') lines.push(`  assign ${node.id} = ${get('A')};`);
        else if (node.type === 'register') lines.push(`  always @(posedge clk) if (${get('EN')}) ${y} <= ${get('D')};`);
        else if (node.type === 'mux') lines.push(`  assign ${y} = ${get('S')} ? ${get('B')} : ${get('A')};`);
        else if (node.type === 'not') lines.push(`  assign ${y} = ~${get('A')};`);
        else if (Object.hasOwn(BINARY_OPERATORS, node.type)) lines.push(`  assign ${y} = ${get('A')} ${BINARY_OPERATORS[node.type]} ${get('B')};`);
      }
      if (definition) for (const p of definition.ports.filter((p) => p.direction === 'output')) lines.push(`  assign ${p.name} = ${signalName(p.bindings[0].nodeId, p.bindings[0].port)};`);
      lines.push('endmodule'); return lines.join('\n');
    };
    return ['// Structural circuit with reusable module hierarchy.', '// Disconnected inputs remain X; registers start unknown until clocked.', ...[...this.modules.values()].map((d) => emit(moduleName(d.id), d.nodes, d.edges, d)), emit('top', this.nodes, this.edges), ''].join('\n\n');
  }
}
