import {CircuitSimulator} from './simulator.js';
import {assemble, disassemble} from './assembler.js';

const REQUIRED = ['clk','reset','instruction','mem_ready','mem_resp_valid','mem_rdata','pc','a','ir','z','c','state','mem_valid','mem_write','mem_addr','mem_wdata','mem_resp_ready','retired','retire_pc','halted','fault'];
const clonePending = pending => pending ? {...pending} : null;

/** Memory, ROM and debugging surround a synthesized circuit; all CPU execution is RTL. */
export class CpuLab {
  constructor(netlist, {latency = 3, cache = false} = {}) {
    if (!Number.isInteger(latency) || latency < 1 || latency > 1000) throw new Error('Memory latency must be between 1 and 1000 clocks');
    this.sim = new CircuitSimulator(netlist);
    const missing = REQUIRED.filter(name => !this.sim.module.ports[name]);
    if (missing.length) throw new Error(`CPU interface is missing: ${missing.join(', ')}`);
    this.latency = latency;
    this.cache = Boolean(cache);
    this.input = 0;
    this.program = {words:[],listing:[]};
    this.programSource = '';
    this.rom = new Uint16Array(256).fill(0xFF00);
    this.ram = new Uint8Array(256);
    this.history = [];
    this.reset();
  }
  get cycle() { return this.sim.cycle; }
  get halted() { return this.sim.getPort('halted') === 1 || this.sim.getPort('fault') === 1; }

  loadProgram(text) {
    const compiled = assemble(text);
    this.program = compiled;
    this.programSource = String(text);
    this.rom.fill(0xFF00);
    this.rom.set(compiled.words);
    this.reset();
    return compiled;
  }

  _drive() {
    const pc = this.sim.getPort('pc');
    this.sim.setInput('instruction',pc === null ? null : this.rom[pc]);
    this.sim.setInput('mem_ready',this.pending ? 0 : 1);
    this.sim.setInput('mem_resp_valid',this.pending && this.pending.remaining === 0 ? 1 : 0);
    this.sim.setInput('mem_rdata',this.pending?.responseData ?? 0);
    this.sim.settle();
  }

  reset() {
    this.ram.fill(0);
    this.display = 0;
    this.pending = null;
    this.events = [];
    this.trace = [];
    this.history = [];
    this.transactionId = 0;
    this.cacheStats = {hits:0,misses:0,reads:0,writes:0};
    this.cacheLines = Array.from({length:4},() => ({valid:false,tag:0,data:new Uint8Array(4)}));
    this.sim.reset();
    this.sim.setInput('reset',1);
    this.sim.setInput('instruction',this.rom[0]);
    this.sim.setInput('mem_ready',0);
    this.sim.setInput('mem_resp_valid',0);
    this.sim.setInput('mem_rdata',0);
    this.sim.tick();
    this.sim.setInput('reset',0);
    this.sim.cycle = 0; // Reset edge is setup, not an executed program clock.
    this._drive();
    return this.getState();
  }

  _save() {
    this.history.push({sim:this.sim.snapshot(),ram:[...this.ram],display:this.display,input:this.input,pending:clonePending(this.pending),eventsLength:this.events.length,traceLength:this.trace.length,transactionId:this.transactionId,cacheStats:{...this.cacheStats},cacheLines:this.cacheLines.map(line => ({valid:line.valid,tag:line.tag,data:[...line.data]}))});
    if (this.history.length > 4096) this.history.shift();
  }

  _accept(address,write,value) {
    if (![address,value].every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('The CPU requested memory with unknown address or data');
    const io = address >= 0xFE;
    const line = this.cacheLines[(address >>> 2) & 3];
    const hit = this.cache && !io && line.valid && line.tag === (address >>> 4);
    let cache = io ? 'bypass' : !this.cache ? 'disabled' : hit ? 'hit' : 'miss';
    if (write) this.cacheStats.writes++;
    else {
      this.cacheStats.reads++;
      if (this.cache && !io) this.cacheStats[hit ? 'hits' : 'misses']++;
    }
    // Write-through stores always wait for backing RAM, even on a cache hit.
    const delay = !write && hit ? 1 : this.latency;
    const responseData = write ? 0 : address === 0xFF ? this.input & 255 : address === 0xFE ? this.display : hit ? line.data[address & 3] : this.ram[address];
    const pending = {id:++this.transactionId,address,write,value,responseData,remaining:delay - 1,latency:delay,cache,acceptedAt:this.cycle};
    this.events.push({cycle:this.cycle,type:'request',address,value:write ? value : responseData,write,cache,id:pending.id,latency:delay});
    return pending;
  }

  _complete(pending) {
    const {address,write,value,cache,id} = pending;
    const line = this.cacheLines[(address >>> 2) & 3];
    if (write) {
      if (address !== 0xFF) this.ram[address] = value;
      if (address === 0xFE) this.display = value;
      if (this.cache && address < 0xFE && line.valid && line.tag === (address >>> 4)) line.data[address & 3] = value;
    } else if (this.cache && address < 0xFE && cache === 'miss') {
      line.valid = true;
      line.tag = address >>> 4;
      const base = address & 0xFC;
      line.data.set(this.ram.subarray(base,base + 4));
    }
    const event = {cycle:this.cycle,type:write ? 'write' : 'read',address,value:write ? value : pending.responseData,cache,id,ignored:write && address === 0xFF};
    this.events.push(event);
    return event;
  }

  stepClock() {
    if (this.halted) return this.getState();
    this._save();
    this._drive();
    const completion = this.pending && this.pending.remaining === 0 && this.sim.getPort('mem_resp_ready') === 1;
    const acceptance = !this.pending && this.sim.getPort('mem_valid') === 1 && this.sim.getPort('mem_ready') === 1;
    const request = acceptance ? {address:this.sim.getPort('mem_addr'),write:this.sim.getPort('mem_write') === 1,value:this.sim.getPort('mem_wdata')} : null;
    const retiring = this.sim.getPort('retired') === 1;
    const retirePc = this.sim.getPort('retire_pc');
    const word = this.sim.getPort('ir');
    this.sim.tick();
    let memoryEvent = null;
    if (completion) { memoryEvent = this._complete(this.pending); this.pending = null; }
    else if (this.pending && this.pending.remaining > 0) this.pending.remaining--;
    if (request) this.pending = this._accept(request.address,request.write,request.value);
    if (retiring) this.trace.push({cycle:this.cycle,pc:retirePc,word,instruction:disassemble(word),a:this.sim.getPort('a'),nextPc:this.sim.getPort('pc'),z:this.sim.getPort('z'),c:this.sim.getPort('c'),memory:memoryEvent});
    this._drive();
    return this.getState();
  }

  stepInstruction(maxClocks = 1000) {
    if (!Number.isInteger(maxClocks) || maxClocks < 1) throw new Error('Instruction clock limit must be a positive integer');
    const count = this.trace.length;
    for (let i = 0; i < maxClocks; i++) {
      if (this.halted) return this.getState();
      this.stepClock();
      if (this.trace.length > count || this.halted) return this.getState();
    }
    throw new Error(`No instruction retired after ${maxClocks} clocks. Inspect the controller and memory handshake.`);
  }

  rewind() {
    const snapshot = this.history.pop();
    if (!snapshot) return this.getState();
    this.sim.restore(snapshot.sim);
    this.ram.set(snapshot.ram);
    this.display = snapshot.display;
    this.input = snapshot.input;
    this.pending = clonePending(snapshot.pending);
    this.events.length = snapshot.eventsLength;
    this.trace.length = snapshot.traceLength;
    this.transactionId = snapshot.transactionId;
    this.cacheStats = {...snapshot.cacheStats};
    this.cacheLines = snapshot.cacheLines.map(line => ({...line,data:new Uint8Array(line.data)}));
    this._drive();
    return this.getState();
  }

  getState() {
    const value = name => this.sim.getPort(name);
    return {a:value('a'),pc:value('pc'),ir:value('ir'),z:value('z'),c:value('c'),state:value('state'),cycle:this.cycle,halted:this.halted,fault:value('fault'),display:this.display,pending:clonePending(this.pending)};
  }
}
