/** A deterministic, high-level OoO teaching model, separate from the RTL CPU. */
const MODEL = 'silicon-trails-ooo-v1';
const ARCH_REGS = 8;
const LOG_LIMIT = 512;
const clone = value => JSON.parse(JSON.stringify(value));
const integer = (value,min,max) => Number.isInteger(value) && value >= min && value <= max;
const CONFIG = {robSize:12,rsSize:8,lsqSize:6,physicalCount:24,mulLatency:5,memoryLatency:3};
const STATE_KEYS = ['cycle','pc','halted','fetchStopped','nextId','architecturalMap','renameMap','physical','freeList','rob','reservationStations','lsq','units','display','input','events','lastEvents','trace','stats'];

export const OOO_PROGRAMS = [
  {id:'rename-forward',name:'Rename, execute, forward',description:'A long multiply waits while younger arithmetic finishes. Register renaming preserves the old R1, and a load forwards from a store before that store commits.',source:'LI R1, 3\nLI R2, 4\nMUL R3, R1, R2\nLI R1, 7\nADD R4, R1, R2\nSTORE R4, [R0 + 0x40]\nLOAD R5, [R0 + 0x40]\nADD R6, R5, R3\nSTORE R6, [R0 + 0xFE]\nHALT'},
  {id:'dependencies',name:'True dependencies and independent work',description:'An independent ADD finishes while an older multiply executes. Dependent instructions wake only after their physical source is ready.',source:'LI R1, 6\nLI R2, 7\nMUL R3, R1, R2\nADD R4, R1, R2\nADD R5, R3, R4\nSTORE R5, [0xFE]\nHALT'},
  {id:'store-order',name:'Wait for an older store address',description:'A younger load cannot pass a store whose address is still unknown. When that store resolves to the same address, the load receives its value.',source:'LI R1, 8\nLI R2, 8\nLI R3, 21\nMUL R4, R1, R2\nSTORE R3, [R4]\nLOAD R5, [0x40]\nSTORE R5, [0xFE]\nHALT'},
];

function assemble(source) {
  if (typeof source !== 'string' || source.length > 65536) throw new Error('OoO assembly must be text of at most 64 KiB.');
  const instructions = [];
  const register = (token,line) => {
    if (!/^R[0-7]$/i.test(token || '')) throw new Error(`Line ${line}: expected a register R0 through R7.`);
    return Number(token.slice(1));
  };
  const number = (token,line,negative = false) => {
    if (!(negative ? /^-?(?:0x[\da-f]+|\d+)$/i : /^(?:0x[\da-f]+|\d+)$/i).test(token || '')) throw new Error(`Line ${line}: invalid immediate ${token || ''}.`);
    const value = token.startsWith('-') ? -Number(token.slice(1)) : Number(token);
    if (!integer(value,negative ? -255 : 0,255)) throw new Error(`Line ${line}: immediate must be ${negative ? '-255' : '0'} through 255.`);
    return value;
  };
  for (const [index,raw] of source.split(/\r?\n/).entries()) {
    const text = raw.replace(/;.*/,'').trim();
    if (!text) continue;
    const line = index + 1;
    const match = text.match(/^(\w+)\s*(.*)$/);
    if (!match) throw new Error(`Line ${line}: expected an instruction.`);
    const op = match[1].toUpperCase(),rest = match[2].trim();
    const instruction = {pc:instructions.length,line,op,text};
    const args = rest.split(/\s*,\s*|\s+/).filter(Boolean);
    if (op === 'LI') {
      if (args.length !== 2) throw new Error(`Line ${line}: use LI Rd, immediate.`);
      instruction.dest = register(args[0],line);instruction.imm = number(args[1],line);
    } else if (['ADD','SUB','MUL','ADDI'].includes(op)) {
      if (args.length !== 3) throw new Error(`Line ${line}: use ${op} Rd, Rs, ${op === 'ADDI' ? 'immediate' : 'Rt'}.`);
      instruction.dest = register(args[0],line);instruction.src1 = register(args[1],line);
      if (op === 'ADDI') instruction.imm = number(args[2],line,true);
      else instruction.src2 = register(args[2],line);
    } else if (op === 'LOAD' || op === 'STORE') {
      const memory = rest.match(/^(R[0-7])\s*,?\s*\[\s*(R[0-7]|0x[\da-f]+|\d+)\s*(?:([+-])\s*(0x[\da-f]+|\d+))?\s*\]$/i);
      if (!memory) throw new Error(`Line ${line}: use ${op} Rn, [Rb + offset] or [address].`);
      const reg = register(memory[1],line);
      if (op === 'LOAD') instruction.dest = reg;else instruction.data = reg;
      if (/^R/i.test(memory[2])) {instruction.base = register(memory[2],line);instruction.offset = memory[4] ? number(memory[4],line) * (memory[3] === '-' ? -1 : 1) : 0;}
      else {
        if (memory[3]) throw new Error(`Line ${line}: an absolute address cannot have an additional offset.`);
        instruction.base = 0;instruction.offset = number(memory[2],line);
      }
    } else if (op === 'NOP' || op === 'HALT') {
      if (rest) throw new Error(`Line ${line}: ${op} takes no operands.`);
    } else throw new Error(`Line ${line}: unsupported OoO instruction ${op}. This teaching model has no branches or branch speculation.`);
    if (instruction.dest === 0) throw new Error(`Line ${line}: R0 is the constant zero register and cannot be a destination.`);
    if (instructions.length >= 256) throw new Error('OoO programs are limited to 256 instructions.');
    instructions.push(instruction);
  }
  if (!instructions.length) throw new Error('Enter at least one OoO instruction.');
  return instructions;
}

export class OoOLab {
  constructor(options = {}) {
    this.config = {...CONFIG};
    for (const key of Object.keys(CONFIG)) if (options[key] !== undefined) this.config[key] = options[key];
    for (const key of ['robSize','rsSize','lsqSize']) if (!integer(this.config[key],1,64)) throw new Error(`${key} must be between 1 and 64.`);
    if (!integer(this.config.physicalCount,9,128)) throw new Error('physicalCount must be between 9 and 128.');
    for (const key of ['mulLatency','memoryLatency']) if (!integer(this.config[key],1,100)) throw new Error(`${key} must be between 1 and 100.`);
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this.loadProgram(options.source ?? OOO_PROGRAMS[0].source);
  }

  loadProgram(source) {
    const program = assemble(source);
    this.programSource = source;
    this.source = source;
    this.program = program;
    this.reset();
    return {instructions:clone(program),listing:clone(program)};
  }

  reset() {
    this.cycle = 0;this.pc = 0;this.halted = false;this.fetchStopped = false;this.nextId = 1;
    this.architecturalMap = Array.from({length:ARCH_REGS},(_,i) => i);
    this.renameMap = [...this.architecturalMap];
    this.physical = Array.from({length:this.config.physicalCount},() => ({value:0,ready:true}));
    this.freeList = Array.from({length:this.config.physicalCount-ARCH_REGS},(_,i) => i+ARCH_REGS);
    this.rob = [];this.reservationStations = [];this.lsq = [];
    this.units = {alu:null,mul:null,lsu:null};
    this.ram = new Uint8Array(256);this.display = 0;this.input = 0;
    this.events = [];this.lastEvents = [];this.trace = [];this.history = [];
    this.stats = {dispatched:0,issued:0,completed:0,committed:0,forwarded:0,stalls:0};
    this.onChange?.(this.getState());
    return this.getState();
  }

  _emit(type,unit,detail = {}) {
    const event = {cycle:this.cycle,type,unit,...detail};
    this.lastEvents.push(event);this.events.push(event);
    if (this.events.length > LOG_LIMIT) this.events.shift();
    return event;
  }
  _operand(tag) { return {tag,ready:this.physical[tag].ready,value:this.physical[tag].ready ? this.physical[tag].value : null}; }
  _ready(tag) { return tag === null || tag === undefined || this.physical[tag].ready; }
  _value(tag) { return tag === null || tag === undefined ? 0 : this.physical[tag].value; }
  _rob(id) { return this.rob.find(entry => entry.id === id); }

  _commit() {
    for (let width = 0; width < 2; width++) {
      const entry = this.rob[0];
      if (!entry?.ready) break;
      let memory = null;
      if (entry.op === 'STORE') {
        const store = this.lsq.find(item => item.robId === entry.id);
        const previous = this.ram[store.address];
        if (store.address !== 0xFF) this.ram[store.address] = store.value;
        if (store.address === 0xFE) this.display = store.value;
        memory = {address:store.address,value:store.value,previous,ignored:store.address === 0xFF};
        this._emit('memory-write','memory',{id:entry.id,pc:entry.pc,...memory});
      }
      if (entry.dest !== null) {
        const previous = this.architecturalMap[entry.dest];
        this.architecturalMap[entry.dest] = entry.physDest;
        this.freeList.push(previous);
        this._emit('architectural-map','architectural-map',{id:entry.id,register:entry.dest,physical:entry.physDest,freed:previous});
      }
      this.rob.shift();
      this.lsq = this.lsq.filter(item => item.robId !== entry.id);
      this.stats.committed++;
      const retirement = {cycle:this.cycle,id:entry.id,pc:entry.pc,op:entry.op,instruction:entry.text,dest:entry.dest,physical:entry.physDest,value:entry.value,memory};
      this.trace.push(retirement);if (this.trace.length > LOG_LIMIT) this.trace.shift();
      this._emit('commit','commit',retirement);
      if (entry.op === 'HALT') {this.halted = true;this._emit('halt','commit',{id:entry.id});break;}
    }
  }

  _finish(job,unit) {
    const entry = this._rob(job.robId);
    if (!entry) throw new Error('OoO invariant: an execution result lost its reorder-buffer entry.');
    entry.ready = true;entry.value = job.value;entry.completedAt = this.cycle;
    if (entry.physDest !== null) {
      this.physical[entry.physDest] = {ready:true,value:job.value};
      this._emit('writeback','physical-registers',{id:entry.id,physical:entry.physDest,value:job.value});
      for (const consumer of this.reservationStations) if (consumer.src1===entry.physDest||consumer.src2===entry.physDest) this._emit('wakeup','reservation-stations',{id:consumer.robId,producer:entry.id,physical:entry.physDest,value:job.value});
      for (const consumer of this.lsq) if (consumer.baseTag===entry.physDest||consumer.dataTag===entry.physDest) this._emit('wakeup','lsq',{id:consumer.robId,producer:entry.id,physical:entry.physDest,value:job.value});
    }
    const memory = this.lsq.find(item => item.robId === entry.id);
    if (memory) {memory.done = true;memory.value = job.value;}
    this.stats.completed++;
    this._emit('complete',unit,{id:entry.id,pc:entry.pc,op:entry.op,value:job.value,physical:entry.physDest});
  }

  _complete() {
    for (const unit of ['alu','mul','lsu']) {
      const job = this.units[unit];
      if (job && job.doneAt <= this.cycle) {this._finish(job,unit);this.units[unit] = null;}
    }
    // Store data may wake after its address has already been generated.
    for (const entry of this.lsq) {
      if (entry.op !== 'STORE' || entry.done || entry.address === null || !this._ready(entry.dataTag)) continue;
      entry.value = this._value(entry.dataTag);entry.done = true;entry.blockedBy = null;
      const rob = this._rob(entry.robId);rob.ready = true;rob.value = entry.value;rob.completedAt = this.cycle;
      this.stats.completed++;
      this._emit('store-ready','lsq',{id:entry.robId,address:entry.address,value:entry.value});
    }
  }

  _issueArithmetic() {
    for (const unit of ['alu','mul']) {
      if (this.units[unit]) continue;
      const index = this.reservationStations.findIndex(entry => (entry.op === 'MUL' ? 'mul' : 'alu') === unit && this._ready(entry.src1) && this._ready(entry.src2));
      if (index < 0) continue;
      const [entry] = this.reservationStations.splice(index,1);
      const left = this._value(entry.src1),right = entry.imm ?? this._value(entry.src2);
      const raw = entry.op === 'LI' ? entry.imm : entry.op === 'MUL' ? left * right : entry.op === 'SUB' ? left - right : left + right;
      this.units[unit] = {robId:entry.robId,op:entry.op,pc:entry.pc,physical:entry.physDest,value:raw & 255,startedAt:this.cycle,doneAt:this.cycle+(unit === 'mul' ? this.config.mulLatency : 1)};
      this.stats.issued++;
      this._emit('issue',unit,{id:entry.robId,pc:entry.pc,op:entry.op,sources:[entry.src1,entry.src2].filter(tag => tag !== null),value:raw & 255});
    }
  }

  _issueMemory() {
    if (this.units.lsu) return;
    let generatedAddress = false;
    for (const entry of this.lsq) {
      if (entry.done || entry.started) continue;
      if (entry.address === null) {
        if (generatedAddress) continue;
        if (!this._ready(entry.baseTag)) {entry.blockedBy = 'base-register';continue;}
        entry.address = (this._value(entry.baseTag)+entry.offset) & 255;
        generatedAddress = true;
        this._emit('address','lsq',{id:entry.robId,address:entry.address});
        // One address generation / memory launch per cycle. A store can wait
        // for data without consuming the memory execution unit.
        if (entry.op === 'STORE') {
          this.stats.issued++;
          this._emit('issue','lsq',{id:entry.robId,pc:entry.pc,op:'STORE',address:entry.address});
          if (this._ready(entry.dataTag)) {
            entry.value = this._value(entry.dataTag);entry.done = true;entry.blockedBy = null;
            const rob = this._rob(entry.robId);rob.ready = true;rob.value = entry.value;rob.completedAt = this.cycle;
            this.stats.completed++;
            this._emit('store-ready','lsq',{id:entry.robId,address:entry.address,value:entry.value});
          } else entry.blockedBy = 'store-data';
          return;
        }
      }
      if (entry.op === 'STORE') {entry.blockedBy = 'store-data';continue;}
      const olderStores = this.lsq.filter(store => store.robId < entry.robId && store.op === 'STORE');
      if (olderStores.some(store => store.address === null)) {
        entry.blockedBy = 'older-store-address';
        this._emit('load-stall','lsq',{id:entry.robId,reason:entry.blockedBy});continue;
      }
      const match = olderStores.filter(store => store.address === entry.address).at(-1);
      if (match && !match.done) {
        entry.blockedBy = 'older-store-data';
        this._emit('load-stall','lsq',{id:entry.robId,reason:entry.blockedBy,storeId:match.robId});continue;
      }
      // Device reads wait until ROB head: speculative I/O is deliberately absent.
      if (entry.address >= 0xFE && this.rob[0]?.id !== entry.robId) {entry.blockedBy = 'io-at-retirement';continue;}
      const value = match ? match.value : entry.address === 0xFF ? this.input & 255 : entry.address === 0xFE ? this.display : this.ram[entry.address];
      entry.started = true;entry.blockedBy = null;entry.forwardedFrom = match?.robId ?? null;
      const latency = match ? 1 : this.config.memoryLatency;
      this.units.lsu = {robId:entry.robId,pc:entry.pc,op:'LOAD',address:entry.address,physical:entry.physDest,value,startedAt:this.cycle,doneAt:this.cycle+latency,forwardedFrom:entry.forwardedFrom};
      this.stats.issued++;
      if (match) {this.stats.forwarded++;this._emit('forward','lsq',{id:entry.robId,storeId:match.robId,address:entry.address,value});}
      this._emit('issue','lsu',{id:entry.robId,pc:entry.pc,op:'LOAD',address:entry.address,value,forwardedFrom:entry.forwardedFrom});
      return;
    }
  }

  _dispatch() {
    for (let width = 0; width < 2 && !this.fetchStopped && this.pc < this.program.length; width++) {
      const instruction = this.program[this.pc];
      const memory = instruction.op === 'LOAD' || instruction.op === 'STORE';
      const arithmetic = !memory && !['NOP','HALT'].includes(instruction.op);
      const needsPhysical = instruction.dest !== undefined;
      const reason = this.rob.length >= this.config.robSize ? 'reorder-buffer-full' : arithmetic && this.reservationStations.length >= this.config.rsSize ? 'reservation-stations-full' : memory && this.lsq.length >= this.config.lsqSize ? 'load-store-queue-full' : needsPhysical && !this.freeList.length ? 'physical-registers-full' : null;
      if (reason) {this.stats.stalls++;this._emit('dispatch-stall','dispatch',{pc:this.pc,reason});break;}
      const src1 = instruction.src1 === undefined ? null : this.renameMap[instruction.src1];
      const src2 = instruction.src2 === undefined ? null : this.renameMap[instruction.src2];
      const baseTag = instruction.base === undefined ? null : this.renameMap[instruction.base];
      const dataTag = instruction.data === undefined ? null : this.renameMap[instruction.data];
      const oldPhys = needsPhysical ? this.renameMap[instruction.dest] : null;
      const physDest = needsPhysical ? this.freeList.shift() : null;
      if (needsPhysical) {
        this.physical[physDest] = {ready:false,value:0};this.renameMap[instruction.dest] = physDest;
        this._emit('rename','rename',{register:instruction.dest,previous:oldPhys,physical:physDest,sources:[src1,src2,baseTag,dataTag].filter(tag => tag !== null)});
      }
      const id = this.nextId++;
      this.rob.push({id,pc:this.pc,op:instruction.op,text:instruction.text,dest:instruction.dest ?? null,physDest,oldPhys,ready:!arithmetic&&!memory,value:null,dispatchedAt:this.cycle,completedAt:null});
      if (arithmetic) this.reservationStations.push({id,robId:id,pc:this.pc,op:instruction.op,src1,src2,imm:instruction.imm ?? null,physDest});
      if (memory) this.lsq.push({id,robId:id,pc:this.pc,op:instruction.op,baseTag,dataTag,offset:instruction.offset,physDest,address:null,value:null,started:false,done:false,forwardedFrom:null,blockedBy:null});
      this.stats.dispatched++;
      this._emit('decode','decode',{id,pc:this.pc,op:instruction.op});
      this._emit('dispatch','dispatch',{id,pc:this.pc,op:instruction.op,physical:physDest,destination:memory?'lsq':arithmetic?'reservation-stations':'rob'});
      this.pc++;
      if (instruction.op === 'HALT') this.fetchStopped = true;
    }
  }

  stepClock() {
    if (this.halted) return this.getState();
    this.history.push(this._capture());if (this.history.length > 256) this.history.shift();
    this.cycle++;this.lastEvents = [];
    // Commit reads readiness from the preceding cycle. Writeback can wake an
    // instruction for issue this cycle; freshly dispatched work issues later.
    this._commit();
    if (!this.halted) {this._complete();this._issueArithmetic();this._issueMemory();this._dispatch();}
    if (this.pc >= this.program.length && !this.rob.length) this.halted = true;
    this.onChange?.(this.getState());
    return this.getState();
  }

  stepInstruction(maxClocks = 1000) {
    if (!integer(maxClocks,1,100000)) throw new Error('The commit clock limit must be 1 through 100000.');
    const before = this.stats.committed;
    for (let count = 0; count < maxClocks && !this.halted; count++) {this.stepClock();if (this.stats.committed > before) return this.getState();}
    if (!this.halted && this.stats.committed === before) throw new Error(`No OoO instruction committed after ${maxClocks} clocks.`);
    return this.getState();
  }

  getState() {
    const rs = this.reservationStations.map(entry => ({...entry,src1:this._operandOrNull(entry.src1),src2:this._operandOrNull(entry.src2),status:this._ready(entry.src1)&&this._ready(entry.src2)?'ready':'waiting'}));
    const lsq = this.lsq.map(entry => ({...entry,base:this._operandOrNull(entry.baseTag),data:this._operandOrNull(entry.dataTag),status:entry.done?'complete':entry.started?'executing':entry.blockedBy||'waiting-address'}));
    const free = new Set(this.freeList);
    return {kind:'ooo',model:MODEL,cycle:this.cycle,pc:this.pc,halted:this.halted,display:this.display,input:this.input,config:{...this.config},programSource:this.programSource,
      registers:this.architecturalMap.map(tag => this.physical[tag].value),architecturalMap:[...this.architecturalMap],renameMap:[...this.renameMap],freeList:[...this.freeList],
      physicalRegisters:this.physical.map((entry,id) => ({id,...entry,free:free.has(id)})),rob:clone(this.rob),reservationStations:rs,rs,lsq,units:clone(this.units),lastEvents:clone(this.lastEvents),stats:{...this.stats}};
  }
  _operandOrNull(tag) { return tag === null ? null : this._operand(tag); }

  _capture() {
    const state = Object.fromEntries(STATE_KEYS.map(key => [key,clone(this[key])]));
    state.ram = [...this.ram];
    return state;
  }
  _apply(state) {for (const key of STATE_KEYS) this[key] = clone(state[key]);this.ram = new Uint8Array(state.ram);}
  snapshot() {return {version:1,model:MODEL,programSource:this.programSource,config:{...this.config},state:this._capture()};}

  restore(snapshot) {
    if (!snapshot || snapshot.version !== 1 || snapshot.model !== MODEL || !snapshot.state) throw new Error('Invalid OoO snapshot version or model.');
    const prepared = new OoOLab({...snapshot.config,source:snapshot.programSource});
    const state = clone(snapshot.state),p = prepared.config.physicalCount;
    const validTag = tag => integer(tag,0,p-1);
    if (!integer(state.cycle,0,Number.MAX_SAFE_INTEGER) || !integer(state.pc,0,prepared.program.length) || typeof state.halted !== 'boolean' || typeof state.fetchStopped !== 'boolean' || !integer(state.nextId,1,Number.MAX_SAFE_INTEGER)) throw new Error('Invalid OoO snapshot clock or program position.');
    for (const key of ['architecturalMap','renameMap']) if (!Array.isArray(state[key]) || state[key].length !== ARCH_REGS || !state[key].every(validTag) || new Set(state[key]).size !== ARCH_REGS || state[key][0] !== 0) throw new Error('Invalid OoO register map.');
    if (!Array.isArray(state.physical) || state.physical.length !== p || state.physical.some(entry => !entry || typeof entry.ready !== 'boolean' || !integer(entry.value,0,255)) || state.physical[0].value !== 0 || !state.physical[0].ready) throw new Error('Invalid OoO physical register state.');
    if (!Array.isArray(state.freeList) || !state.freeList.every(tag => validTag(tag)&&tag!==0) || new Set(state.freeList).size !== state.freeList.length || [...state.architecturalMap,...state.renameMap].some(tag => state.freeList.includes(tag))) throw new Error('Invalid OoO free list.');
    if (!Array.isArray(state.ram) || state.ram.length !== 256 || !state.ram.every(value => integer(value,0,255)) || !integer(state.display,0,255) || !integer(state.input,0,255)) throw new Error('Invalid OoO memory or device state.');
    const capacities = {rob:prepared.config.robSize,reservationStations:prepared.config.rsSize,lsq:prepared.config.lsqSize};
    for (const [key,capacity] of Object.entries(capacities)) if (!Array.isArray(state[key]) || state[key].length > capacity) throw new Error(`Invalid OoO ${key} capacity.`);
    const ids = new Set(state.rob.map(entry => entry.id));
    if (ids.size !== state.rob.length || state.rob.some((entry,i) => !integer(entry.id,1,state.nextId-1) || i>0&&entry.id<=state.rob[i-1].id || !integer(entry.pc,0,prepared.program.length-1) || entry.op !== prepared.program[entry.pc].op || typeof entry.ready !== 'boolean' || entry.physDest!==null&&!validTag(entry.physDest) || entry.dest!==null&&!integer(entry.dest,1,7))) throw new Error('Invalid OoO reorder buffer.');
    const allocated = new Set([...state.architecturalMap,...state.rob.filter(entry => entry.physDest!==null).map(entry => entry.physDest)]);
    if (allocated.size+state.freeList.length!==p || state.freeList.some(tag => allocated.has(tag)) || state.renameMap.some(tag => !allocated.has(tag))) throw new Error('Invalid OoO physical register ownership.');
    for (const entry of state.reservationStations) if (!ids.has(entry.robId) || !validTag(entry.physDest) || entry.op!==state.rob.find(rob=>rob.id===entry.robId).op || [entry.src1,entry.src2].some(tag => tag!==null&&!validTag(tag)) || entry.imm!==null&&!integer(entry.imm,-255,255)) throw new Error('Invalid OoO reservation station.');
    for (const entry of state.lsq) if (!ids.has(entry.robId) || !['LOAD','STORE'].includes(entry.op) || entry.op!==state.rob.find(rob=>rob.id===entry.robId).op || !validTag(entry.baseTag) || entry.dataTag!==null&&!validTag(entry.dataTag) || entry.address!==null&&!integer(entry.address,0,255) || entry.value!==null&&!integer(entry.value,0,255) || !integer(entry.offset,-255,255) || typeof entry.done!=='boolean' || typeof entry.started!=='boolean') throw new Error('Invalid OoO load/store queue.');
    if (!state.units || ['alu','mul','lsu'].some(unit => state.units[unit]!==null&&(!state.units[unit]||!ids.has(state.units[unit].robId)||!integer(state.units[unit].value,0,255)||!integer(state.units[unit].doneAt,state.cycle,Number.MAX_SAFE_INTEGER)))) throw new Error('Invalid OoO execution unit state.');
    for (const key of ['events','lastEvents','trace']) if (!Array.isArray(state[key]) || state[key].length > LOG_LIMIT || state[key].some(event => !event || !integer(event.cycle,0,state.cycle))) throw new Error('Invalid OoO event history.');
    if (!state.stats || ['dispatched','issued','completed','committed','forwarded','stalls'].some(key => !integer(state.stats[key],0,Number.MAX_SAFE_INTEGER))) throw new Error('Invalid OoO counters.');
    this.config = prepared.config;this.programSource = prepared.programSource;this.source = prepared.source;this.program = prepared.program;
    this._apply(state);this.history = [];this.onChange?.(this.getState());return this.getState();
  }
  rewind() {const state = this.history.pop();if (state) this._apply(state);this.onChange?.(this.getState());return this.getState();}
}
