import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CpuLab} from '../src/core/cpu-lab.js';
import {assemble,PROGRAMS} from '../src/core/assembler.js';

const fixture = JSON.parse(await readFile(new URL('../public/examples/cpu.json',import.meta.url),'utf8'));
const netlist = fixture.netlist || fixture;

// Independent architectural oracle, used only to check the synthesized circuit.
function reference(words,input = 0) {
  const ram = new Uint8Array(256), trace = [];
  let a = 0,pc = 0,z = 1,c = 0,display = 0;
  for (let count = 0; count < 2000; count++) {
    const instructionPc = pc,word = words[pc] ?? 0xFF00,op = word >>> 8,arg = word & 255;
    pc = (pc + 1) & 255;
    const read = address => address === 0xFF ? input : address === 0xFE ? display : ram[address];
    let result;
    switch (op) {
      case 0: break;
      case 1: a = arg; z = Number(a === 0); break;
      case 2: a = read(arg); z = Number(a === 0); break;
      case 3: if (arg !== 0xFF) ram[arg] = a; if (arg === 0xFE) display = a; break;
      case 4: case 5: result = a + (op === 4 ? read(arg) : arg); a = result & 255; c = Number(result > 255); z = Number(a === 0); break;
      case 6: result = a - arg; c = Number(result >= 0); a = result & 255; z = Number(a === 0); break;
      case 7: pc = arg; break;
      case 8: if (z) pc = arg; break;
      case 9: if (!z) pc = arg; break;
      case 255: trace.push({pc:instructionPc,a,nextPc:pc,z,c}); return {a,pc,z,c,display,ram,trace};
      default: throw new Error(`Bad oracle opcode ${op}`);
    }
    trace.push({pc:instructionPc,a,nextPc:pc,z,c});
  }
  throw new Error('Reference exceeded instruction limit');
}

function run(lab,limit = 2000) {
  for (let i = 0; i < limit && !lab.halted; i++) lab.stepInstruction();
  assert.equal(lab.halted,true,'CPU should halt before the instruction limit');
  assert.equal(lab.getState().fault,0,'valid program must not fault');
  return lab;
}

function compare(lab,expected) {
  const state = lab.getState();
  for (const name of ['a','pc','z','c','display']) assert.equal(state[name],expected[name],name);
  assert.deepEqual([...lab.ram],[...expected.ram]);
  assert.deepEqual(lab.trace.map(({pc,a,nextPc,z,c}) => ({pc,a,nextPc,z,c})),expected.trace);
}

test('all programs execute in the actual synthesized CPU and match an independent ISA oracle',() => {
  for (const program of PROGRAMS) for (const cache of [false,true]) for (const latency of [1,3,7]) {
    const lab = new CpuLab(netlist,{latency,cache});
    lab.input = 42;
    lab.loadProgram(program.source);
    compare(run(lab),reference(assemble(program.source).words,42));
    const requests = lab.events.filter(event => event.type === 'request');
    const completions = lab.events.filter(event => event.type !== 'request');
    assert.equal(requests.length,completions.length,'each accepted transaction completes exactly once');
    assert.equal(new Set(completions.map(event => event.id)).size,completions.length);
  }
});

test('stores remain pending until acknowledgement, and rewind restores and replays that edge',() => {
  const lab = new CpuLab(netlist,{latency:5,cache:true});
  lab.loadProgram('LDI 12\nSTORE 0x40\nHALT');
  for (let clocks = 0; clocks < 50 && !lab.pending; clocks++) lab.stepClock();
  assert.equal(lab.pending.write,true);
  const accepted = lab.cycle;
  assert.equal(lab.ram[0x40],0);
  while (lab.pending.remaining > 0) {lab.stepClock(); assert.equal(lab.ram[0x40],0);}
  const before = lab.getState();
  lab.stepClock();
  const after = lab.getState();
  assert.equal(lab.cycle - accepted,5);
  assert.equal(lab.ram[0x40],12);
  assert.equal(lab.events.filter(event => event.type === 'write').length,1);
  lab.rewind();
  assert.equal(lab.ram[0x40],0);
  assert.deepEqual(lab.getState(),before);
  lab.stepClock();
  assert.deepEqual(lab.getState(),after);
  assert.equal(lab.events.filter(event => event.type === 'write').length,1);
});

test('cache preserves results, accelerates repeated reads, and keeps write-through store latency',() => {
  const program = PROGRAMS.find(program => program.id === 'cache').source;
  const plain = new CpuLab(netlist,{latency:8}); plain.loadProgram(program); run(plain);
  const cached = new CpuLab(netlist,{latency:8,cache:true}); cached.loadProgram(program); run(cached);
  assert.deepEqual([...cached.ram],[...plain.ram]);
  assert.equal(cached.display,plain.display);
  assert.ok(cached.cycle < plain.cycle);
  assert.ok(cached.cacheStats.hits > 0);
  assert.ok(cached.cacheStats.misses > 0);
  for (const request of cached.events.filter(event => event.type === 'request' && event.write)) {
    const response = cached.events.find(event => event.type === 'write' && event.id === request.id);
    assert.equal(response.cycle-request.cycle,8);
  }
});

test('arithmetic wrap, carry, borrow and branches match the oracle',() => {
  let seed = 0x1234;
  const random = () => {seed = (seed * 1664525 + 1013904223) >>> 0; return seed & 255;};
  for (let i = 0; i < 12; i++) {
    const source = `LDI ${random()}\nADDI ${random()}\nSTORE 0x40\nSUBI ${random()}\nSTORE 0x41\nADD 0x40\nJZ zero\nADDI 1\nJMP end\nzero: SUBI 1\nend: STORE 0xFE\nHALT`;
    const lab = new CpuLab(netlist,{latency:1+i%5,cache:i%2 === 0});
    lab.loadProgram(source);
    compare(run(lab),reference(assemble(source).words));
  }
});

test('full reset cancels an accepted transaction and restores the initial image',() => {
  const lab = new CpuLab(netlist,{latency:7,cache:true});
  lab.loadProgram('LDI 9\nSTORE 0x40\nHALT');
  while (!lab.pending) lab.stepClock();
  lab.reset();
  assert.equal(lab.pending,null);
  assert.equal(lab.cycle,0);
  assert.equal(lab.trace.length,0);
  assert.equal(lab.events.length,0);
  assert.equal(lab.ram[0x40],0);
  compare(run(lab),reference(assemble('LDI 9\nSTORE 0x40\nHALT').words));
});


test('reset zero flag controls a branch before the first accumulator write',() => {
  const source = 'JZ zero\nLDI 99\nJMP end\nzero: LDI 7\nend: HALT';
  const lab = new CpuLab(netlist);
  assert.equal(lab.getState().z,1);
  lab.loadProgram(source);
  compare(run(lab),reference(assemble(source).words));
  assert.equal(lab.getState().a,7);
});
