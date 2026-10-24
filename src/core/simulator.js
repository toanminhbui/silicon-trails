const SEQUENTIAL = new Set(['$dff', '$dffe', '$adff', '$adffe', '$sdff', '$sdffe', '$sdffce']);
const COMBINATIONAL = new Set(['$not','$pos','$neg','$and','$or','$xor','$xnor','$logic_not','$logic_and','$logic_or','$reduce_and','$reduce_or','$reduce_bool','$reduce_xor','$reduce_xnor','$add','$sub','$mul','$div','$mod','$shl','$sshl','$shr','$sshr','$shift','$shiftx','$lt','$le','$gt','$ge','$eq','$ne','$eqx','$nex','$mux','$pmux','$bmux','$demux','$slice','$concat']);
const param = (cell, name, fallback = 0) => {
  const value = cell.parameters?.[name];
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  if (/^[01]+$/.test(value)) return Number(BigInt(`0b${value}`));
  return Number(value);
};
const mask = width => (1n << BigInt(width)) - 1n;
const bitArray = (value, width) => value === null ? Array(width).fill(null) : Array.from({length:width}, (_, i) => Number((BigInt(value) >> BigInt(i)) & 1n));
const unsigned = bits => bits.some(value => value === null) ? null : bits.reduce((value, bit, i) => value | (BigInt(bit) << BigInt(i)), 0n);
const signed = bits => {
  const value = unsigned(bits);
  return value === null ? null : bits.at(-1) === 1 ? value - (1n << BigInt(bits.length)) : value;
};
const same = (a,b) => a.length === b.length && a.every((value,i) => value === b[i]);
const truth = bits => bits.includes(1) ? 1 : bits.includes(null) ? null : 0;

/** Executes synthesized RTL cells. There is no instruction-level CPU in this class. */
export class CircuitSimulator {
  constructor(netlist, {top} = {}) {
    if (!netlist?.modules) throw new Error('Expected a Yosys JSON netlist with modules');
    const entries = Object.entries(netlist.modules);
    this.top = top || entries.find(([, mod]) => Number(mod.attributes?.top) === 1)?.[0] || entries[0]?.[0];
    this.module = netlist.modules[this.top];
    if (!this.module) throw new Error(`Top module ${this.top} does not exist`);
    this.netlist = netlist;
    this.cycle = 0;
    this.diagnostics = [];
    this.inputs = new Map();
    this.values = new Map();
    this.registers = new Map();
    this.cells = Object.entries(this.module.cells || {}).map(([id, cell]) => ({...cell, id}));
    this.sequential = [];
    this.combinational = [];
    const drivers = new Map();
    const addDriver = (bit, driver) => {
      if (typeof bit !== 'number') return;
      if (drivers.has(bit) && drivers.get(bit) !== driver) throw new Error(`Multiple drivers on net ${bit}: ${drivers.get(bit)} and ${driver}`);
      drivers.set(bit, driver);
    };
    for (const [name, port] of Object.entries(this.module.ports || {})) {
      this._checkWidth(port.bits, `port ${name}`);
      if (!['input','output'].includes(port.direction)) throw new Error(`Unsupported ${port.direction} port ${name}`);
      if (port.direction === 'input') {
        this.inputs.set(name, Array(port.bits.length).fill(0));
        port.bits.forEach(bit => addDriver(bit, `input:${name}`));
      }
    }
    let clockBit;
    for (const cell of this.cells) {
      if (!SEQUENTIAL.has(cell.type) && !COMBINATIONAL.has(cell.type)) throw new Error(`Unsupported RTL cell ${cell.type} (${cell.id}). Use combinational logic and rising-edge registers; memories and latches must be abstracted through ports.`);
      for (const [name, bits] of Object.entries(cell.connections)) {
        // Yosys packs the alternatives of a parallel mux into one aggregate B
        // connection. Individual data paths still obey the 32-bit limit.
        const packed = (cell.type === '$pmux' && name === 'B') || (cell.type === '$bmux' && name === 'A') || (cell.type === '$demux' && name === 'Y');
        if (!packed) this._checkWidth(bits, `${cell.id}.${name}`);
      }
      if (!cell.port_directions) throw new Error(`Missing port directions for cell ${cell.id}`);
      for (const [name, direction] of Object.entries(cell.port_directions)) {
        if (direction === 'output') cell.connections[name].forEach(bit => addDriver(bit, cell.id));
        else if (direction !== 'input') throw new Error(`Unsupported cell port direction ${cell.id}.${name}`);
      }
      if (SEQUENTIAL.has(cell.type)) {
        this.sequential.push(cell);
        const clk = cell.connections.CLK;
        if (clk?.length !== 1 || param(cell,'CLK_POLARITY',1) !== 1) throw new Error(`Only one shared rising-edge clock is supported (${cell.id})`);
        if (clockBit === undefined) clockBit = clk[0];
        if (clockBit !== clk[0]) throw new Error('Multiple or gated clocks are unsupported; connect every register to the same input clock');
      } else this.combinational.push(cell);
    }
    if (clockBit !== undefined && !String(drivers.get(clockBit)).startsWith('input:')) throw new Error('The shared clock must be driven directly by a top-level input');
    this.clockInput = clockBit === undefined ? null : String(drivers.get(clockBit)).slice(6);
    // Compile an acyclic execution order. Register Q outputs break feedback paths.
    const combById = new Map(this.combinational.map(cell => [cell.id, cell]));
    const visited = new Set(), visiting = new Set(), sorted = [];
    const visit = cell => {
      if (visited.has(cell.id)) return;
      if (visiting.has(cell.id)) throw new Error(`Combinational feedback loop involving ${cell.id}; add a register to break the loop`);
      visiting.add(cell.id);
      for (const [name, direction] of Object.entries(cell.port_directions)) {
        if (direction !== 'input') continue;
        for (const bit of cell.connections[name]) {
          const upstream = combById.get(drivers.get(bit));
          if (upstream) visit(upstream);
          else if (typeof bit === 'number' && !drivers.has(bit)) this.diagnostics.push(`Undriven net ${bit} at ${cell.id}.${name}`);
        }
      }
      visiting.delete(cell.id); visited.add(cell.id); sorted.push(cell);
    };
    this.combinational.forEach(visit);
    this.combinational = sorted;
    this.diagnostics = [...new Set(this.diagnostics)];
    this.reset();
  }

  _checkWidth(bits, label) {
    if (!Array.isArray(bits) || bits.length > 32) throw new Error(`Unsupported width at ${label}: this simulator supports buses up to 32 bits`);
  }
  _read(bits = []) { return bits.map(bit => typeof bit === 'number' ? (this.values.get(bit) ?? null) : bit === '0' ? 0 : bit === '1' ? 1 : null); }
  _write(bits, values) { bits.forEach((bit,i) => { if (typeof bit === 'number') this.values.set(bit, values[i] ?? null); }); }
  _active(cell, port, polarity) {
    const bit = this._read(cell.connections[port])[0];
    return bit === null ? null : bit === param(cell,polarity,1);
  }
  setInput(name, value) {
    const port = this.module.ports[name];
    if (!port || port.direction !== 'input') throw new Error(`Unknown input port ${name}`);
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > Number(mask(port.bits.length)))) throw new Error(`Input ${name} requires an unsigned ${port.bits.length}-bit integer or null`);
    this.inputs.set(name, bitArray(value,port.bits.length));
    return this;
  }
  getPort(name) {
    const port = this.module.ports[name];
    if (!port) throw new Error(`Unknown port ${name}`);
    return this.getBits(port.bits);
  }
  getBits(bits) { const value = unsigned(this._read(bits)); return value === null ? null : Number(value); }
  getCellPorts(id) {
    const cell = this.module.cells[id];
    if (!cell) throw new Error(`Unknown cell ${id}`);
    return Object.fromEntries(Object.entries(cell.connections).map(([name,bits]) => [name,this.getBits(bits)]));
  }

  _evaluate(cell) {
    const conn = cell.connections, type = cell.type;
    const a = this._read(conn.A), b = this._read(conn.B), s = this._read(conn.S);
    const width = conn.Y.length;
    const uA = unsigned(a), uB = unsigned(b);
    const bothSigned = Boolean(param(cell,'A_SIGNED') && param(cell,'B_SIGNED'));
    const aNum = bothSigned ? signed(a) : uA, bNum = bothSigned ? signed(b) : uB;
    const unknown = () => Array(width).fill(null);
    const out = value => bitArray(value === null ? null : value & mask(width),width);
    const extend = (bits, signedFlag) => Array.from({length:width},(_,i) => i < bits.length ? bits[i] : signedFlag ? bits.at(-1) ?? 0 : 0);
    if (type === '$mux') return s[0] === 0 ? a : s[0] === 1 ? b : a.map((bit,i) => bit === b[i] ? bit : null);
    if (type === '$pmux') {
      if (s.includes(null)) return unknown();
      const choices = s.flatMap((bit,i) => bit ? [i] : []);
      return choices.length === 0 ? a : choices.length === 1 ? b.slice(choices[0]*width,(choices[0]+1)*width) : unknown();
    }
    if (type === '$bmux') { const index = unsigned(s); return index === null ? unknown() : a.slice(Number(index)*width,(Number(index)+1)*width); }
    if (type === '$demux') { const index = unsigned(s); if (index === null) return unknown(); const result = Array(width).fill(0); result.splice(Number(index)*a.length,a.length,...a); return result.slice(0,width); }
    if (type === '$slice') return a.slice(param(cell,'OFFSET'),param(cell,'OFFSET')+width);
    if (type === '$concat') return [...a,...b];
    if (type === '$pos') return extend(a,param(cell,'A_SIGNED'));
    if (type === '$not') return extend(a,param(cell,'A_SIGNED')).map(bit => bit === null ? null : 1-bit);
    if (['$and','$or','$xor','$xnor'].includes(type)) {
      const aa = extend(a,bothSigned), bb = extend(b,bothSigned);
      return aa.map((bit,i) => {
        const other = bb[i];
        if (type === '$and') return bit === 0 || other === 0 ? 0 : bit === null || other === null ? null : 1;
        if (type === '$or') return bit === 1 || other === 1 ? 1 : bit === null || other === null ? null : 0;
        return bit === null || other === null ? null : (bit ^ other) ^ Number(type === '$xnor');
      });
    }
    if (type === '$logic_not') { const value = truth(a); return out(value === null ? null : BigInt(1-value)); }
    if (type === '$logic_and' || type === '$logic_or') {
      const aa = truth(a), bb = truth(b);
      return out(type === '$logic_and' ? aa === 0 || bb === 0 ? 0n : aa === null || bb === null ? null : 1n : aa === 1 || bb === 1 ? 1n : aa === null || bb === null ? null : 0n);
    }
    if (type.startsWith('$reduce_')) {
      if (type === '$reduce_or' || type === '$reduce_bool') { const value = truth(a); return out(value === null ? null : BigInt(value)); }
      if (type === '$reduce_and') return out(a.includes(0) ? 0n : a.includes(null) ? null : 1n);
      if (a.includes(null)) return unknown();
      return out(BigInt(a.reduce((v,bit) => v ^ bit,Number(type === '$reduce_xnor'))));
    }
    if (type === '$eqx' || type === '$nex') {
      // Compare at operand width, not the one-bit output width.
      const w = Math.max(a.length,b.length);
      const padded = bits => Array.from({length:w},(_,i) => i<bits.length ? bits[i] : bothSigned ? bits.at(-1) : 0);
      return out(BigInt(Number(type === '$eqx' ? same(padded(a),padded(b)) : !same(padded(a),padded(b)))));
    }
    if (type === '$neg') return out(uA === null ? null : -(param(cell,'A_SIGNED') ? signed(a) : uA));
    if (uA === null || (conn.B && uB === null)) return unknown();
    switch (type) {
      case '$add': return out(aNum+bNum);
      case '$sub': return out(aNum-bNum);
      case '$mul': return out(aNum*bNum);
      case '$div': return out(bNum === 0n ? null : aNum/bNum);
      case '$mod': return out(bNum === 0n ? null : aNum%bNum);
      case '$lt': return out(BigInt(Number(aNum < bNum)));
      case '$le': return out(BigInt(Number(aNum <= bNum)));
      case '$gt': return out(BigInt(Number(aNum > bNum)));
      case '$ge': return out(BigInt(Number(aNum >= bNum)));
      case '$eq': return out(BigInt(Number(aNum === bNum)));
      case '$ne': return out(BigInt(Number(aNum !== bNum)));
      case '$shl': case '$sshl': return out(uB > 64n ? 0n : (param(cell,'A_SIGNED') ? signed(a) : uA) << uB);
      case '$shr': { const value = param(cell,'A_SIGNED') ? signed(a) & mask(Math.max(width,a.length)) : uA; return out(uB > 64n ? 0n : value >> uB); }
      case '$sshr': { const value = param(cell,'A_SIGNED') ? signed(a) : uA; return out(uB > 64n ? value < 0 ? -1n : 0n : value >> uB); }
      case '$shift': case '$shiftx': {
        const amount = param(cell,'B_SIGNED') ? signed(b) : uB;
        if (type === '$shiftx') return Array.from({length:width},(_,i) => {const index = BigInt(i)+amount; return index < 0n || index >= BigInt(a.length) ? null : a[Number(index)];});
        if (amount > 64n) return out(0n);
        if (amount < -64n) return out(0n);
        return out(amount < 0n ? uA << -amount : uA >> amount);
      }
      default: throw new Error(`Unimplemented cell ${type}`);
    }
  }

  settle() {
    this.values.clear();
    for (const [name,bits] of this.inputs) this._write(this.module.ports[name].bits,bits);
    for (const cell of this.sequential) this._write(cell.connections.Q,this.registers.get(cell.id));
    for (const cell of this.combinational) this._write(cell.connections.Y,this._evaluate(cell));
    let resetChanged = false;
    for (const cell of this.sequential) {
      if (!cell.type.startsWith('$adff')) continue;
      const active = this._active(cell,'ARST','ARST_POLARITY');
      if (active === true || active === null) {
        const value = active === null ? Array(cell.connections.Q.length).fill(null) : bitArray(param(cell,'ARST_VALUE'),cell.connections.Q.length);
        if (!same(value,this.registers.get(cell.id))) { this.registers.set(cell.id,value); resetChanged = true; }
      }
    }
    if (resetChanged) {
      for (const cell of this.sequential) this._write(cell.connections.Q,this.registers.get(cell.id));
      for (const cell of this.combinational) this._write(cell.connections.Y,this._evaluate(cell));
    }
    return this;
  }

  tick() {
    if (this.clockInput) this.setInput(this.clockInput,0);
    this.settle();
    const next = new Map();
    for (const cell of this.sequential) {
      let value = this._read(cell.connections.D);
      const previous = this.registers.get(cell.id);
      const enabled = cell.connections.EN ? this._active(cell,'EN','EN_POLARITY') : true;
      const syncReset = cell.connections.SRST ? this._active(cell,'SRST','SRST_POLARITY') : false;
      if (enabled === false) value = previous;
      else if (enabled === null) value = value.map((bit,i) => bit === previous[i] ? bit : null);
      if (syncReset === true && !(cell.type === '$sdffce' && enabled === false)) value = bitArray(param(cell,'SRST_VALUE'),cell.connections.Q.length);
      else if (syncReset === null) value = Array(cell.connections.Q.length).fill(null);
      if (cell.connections.ARST) {
        const asyncReset = this._active(cell,'ARST','ARST_POLARITY');
        if (asyncReset === true) value = bitArray(param(cell,'ARST_VALUE'),cell.connections.Q.length);
        else if (asyncReset === null) value = Array(cell.connections.Q.length).fill(null);
      }
      next.set(cell.id,[...value]);
    }
    this.registers = next;
    this.cycle++;
    if (this.clockInput) this.setInput(this.clockInput,1);
    this.settle();
    return this;
  }

  reset() {
    this.cycle = 0;
    for (const [name,bits] of this.inputs) this.inputs.set(name,Array(bits.length).fill(0));
    const initial = new Map();
    for (const net of Object.values(this.module.netnames || {})) {
      const init = net.attributes?.init;
      if (typeof init === 'string') [...init].reverse().forEach((bit,i) => { if (typeof net.bits[i] === 'number') initial.set(net.bits[i],bit === '0' ? 0 : bit === '1' ? 1 : null); });
    }
    this.registers = new Map(this.sequential.map(cell => [cell.id,cell.connections.Q.map(bit => initial.get(bit) ?? null)]));
    return this.settle();
  }
  snapshot() { return {cycle:this.cycle,inputs:[...this.inputs].map(([id,value]) => [id,[...value]]),registers:[...this.registers].map(([id,value]) => [id,[...value]])}; }
  restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.registers) || !Array.isArray(snapshot.inputs)) throw new Error('Invalid circuit snapshot');
    this.cycle = snapshot.cycle;
    this.inputs = new Map(snapshot.inputs.map(([id,value]) => [id,[...value]]));
    this.registers = new Map(snapshot.registers.map(([id,value]) => [id,[...value]]));
    return this.settle();
  }
}
