const SEQUENTIAL = /^\$(?:a?sdff|adff|dff)/;

function cellKind(type) {
  if (SEQUENTIAL.test(type)) return 'register';
  if (/\$(add|sub|mul|div|mod|neg|lt|le|gt|ge|eq|ne)/.test(type)) return 'alu';
  if (/mux|decode/.test(type)) return 'control';
  if (/mem/.test(type)) return 'memory';
  return 'logic';
}

function outputPort(cell) {
  return ['Y', 'Q'].find((name) => cell.port_directions?.[name] === 'output')
    || Object.keys(cell.port_directions || {}).find((name) => cell.port_directions[name] === 'output');
}

/** Adapts real flattened Yosys connectivity into the spatial view; no invented links. */
export function makeNetlistGraph(compiled) {
  const netlist = compiled.netlist || compiled;
  if (!netlist?.modules) throw new Error('Expected a synthesized Yosys netlist');
  const top = compiled.top || Object.entries(netlist.modules).find(([, mod]) => Number(mod.attributes?.top) === 1)?.[0]
    || Object.keys(netlist.modules)[0];
  const module = netlist.modules[top];
  if (!module) throw new Error(`No module ${top} in this design`);
  const nodes = [];
  const edges = [];
  const drivers = new Map();
  const sinks = [];
  const specialNodes = new Map();
  const addDriver = (bit, descriptor) => {
    if (typeof bit !== 'number') return;
    // Invalid multiple drivers are reported by CircuitSimulator. Preserve the
    // first connection here so graph inspection can accompany its diagnostic.
    if (!drivers.has(bit)) drivers.set(bit, descriptor);
  };

  for (const [name, port] of Object.entries(module.ports || {})) {
    const input = port.direction === 'input';
    const id = `${input ? 'input' : 'output'}:${name}`;
    const visualPort = input ? 'Y' : 'A';
    const node = {
      id, label: name, type: input ? 'input' : 'output', kind: input ? 'input' : 'output',
      width: port.bits.length, bits: [...port.bits],
      ports: [{ name: visualPort, direction: input ? 'output' : 'input', width: port.bits.length }],
      [input ? 'inputName' : 'outputName']: name,
      source: module.netnames?.[name]?.attributes?.src || module.attributes?.src || '',
      sourceAttrs: { ...(module.netnames?.[name]?.attributes || {}) },
      scope: top,
      semantic: { kind: input ? 'external-input' : 'observable-output' },
    };
    nodes.push(node);
    if (input) port.bits.forEach((bit, index) => addDriver(bit, { node: id, port: visualPort, index }));
    else sinks.push({ id, name: visualPort, bits: port.bits });
  }

  for (const [cellId, cell] of Object.entries(module.cells || {})) {
    const id = `cell:${cellId}`;
    const valuePort = outputPort(cell);
    const bits = cell.connections[valuePort] || [];
    const typeName = cell.type.replace(/^\$/, '').toUpperCase();
    const hdlName = cell.attributes?.hdlname?.trim();
    const label = hdlName?.split(/\s+/).at(-1) || (cellId.startsWith('$') ? typeName : cellId);
    nodes.push({
      id, cellId, label, type: cell.type, kind: cellKind(cell.type), width: bits.length,
      bits: [...bits], valuePort,
      ports: Object.entries(cell.connections).map(([name, values]) => ({
        name, direction: cell.port_directions?.[name] || 'input', width: values.length,
      })),
      source: cell.attributes?.src || '', sourceAttrs: { ...(cell.attributes || {}) },
      scope: hdlName ? `${top}.${hdlName.replace(/\s+/g, '.')}` : top,
      semantic: { kind: SEQUENTIAL.test(cell.type) ? 'state' : 'combinational', operation: cell.type },
    });
    for (const [name, direction] of Object.entries(cell.port_directions || {})) {
      const connection = cell.connections[name] || [];
      if (direction === 'output') connection.forEach((bit, index) => addDriver(bit, { node: id, port: name, index }));
      else sinks.push({ id, name, bits: connection });
    }
  }

  function specialDriver(bit) {
    const constant = typeof bit === 'string';
    const key = constant ? `constant:${bit}` : 'undriven';
    if (!specialNodes.has(key)) {
      const known = bit === '0' || bit === '1';
      const node = {
        id: key, label: constant ? (known ? `CONST ${bit}` : 'UNKNOWN X') : 'UNDRIVEN',
        type: 'constant', kind: 'input', width: 1, bits: constant ? [bit] : [],
        ports: [{ name: 'Y', direction: 'output', width: 1 }],
        semantic: { kind: known ? 'constant' : 'unknown', reason: constant ? 'RTL literal' : 'No driving port or cell' },
      };
      specialNodes.set(key, node);
      nodes.push(node);
    }
    const special = specialNodes.get(key);
    if (!constant && !special.bits.includes(bit)) {
      special.bits.push(bit);
      special.width = special.bits.length;
      special.ports[0].width = special.width;
    }
    return { node: key, port: 'Y', index: constant ? 0 : special.bits.indexOf(bit) };
  }

  for (const sink of sinks) {
    const groups = new Map();
    sink.bits.forEach((bit, destinationIndex) => {
      const driver = drivers.get(bit) || specialDriver(bit);
      const key = `${driver.node}\0${driver.port}`;
      if (!groups.has(key)) groups.set(key, { driver, bits: [], sourceIndices: [], destinationIndices: [] });
      const group = groups.get(key);
      group.bits.push(bit);
      group.sourceIndices.push(driver.index);
      group.destinationIndices.push(destinationIndex);
    });
    for (const { driver, bits, sourceIndices, destinationIndices } of groups.values()) {
      edges.push({
        id: `edge:${edges.length}`, from: driver.node, fromPort: driver.port,
        to: sink.id, toPort: sink.name, width: bits.length, bits,
        label: `${driver.port} → ${sink.name}`, sourceIndices, destinationIndices,
      });
    }
  }
  return { nodes, edges, top };
}

/** Works with graph adapter output and CircuitBuilder's direct node IDs. */
export function getGraphSignals(graph, sim) {
  const nodeValues = {};
  const edgeValues = {};
  const read = (bits) => Array.isArray(bits) && bits.length && bits.length <= 32 ? sim.getBits(bits) : null;
  for (const node of graph.nodes || []) {
    let value = null;
    if (node.inputName) value = sim.getPort(node.inputName);
    else if (node.outputName) value = sim.getPort(node.outputName);
    else if (node.cellId) {
      const ports = sim.getCellPorts(node.cellId);
      value = ports[node.valuePort || (Object.hasOwn(ports, 'Y') ? 'Y' : 'Q')] ?? null;
    } else value = read(node.bits);
    nodeValues[node.id] = { value, active: value !== null && value !== 0 };
  }
  for (const edge of graph.edges || []) {
    const value = read(edge.bits);
    edgeValues[edge.id] = { value, active: value !== null && value !== 0 };
  }
  return { nodeValues, edgeValues };
}
