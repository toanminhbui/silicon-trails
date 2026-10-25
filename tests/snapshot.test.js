import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CircuitSimulator} from '../src/core/simulator.js';
import {CpuLab} from '../src/core/cpu-lab.js';
import {captureExecution,restoreExecution} from '../src/game/snapshot.js';

const fixture = JSON.parse(readFileSync(new URL('../public/examples/cpu.json',import.meta.url),'utf8'));
const program = 'LDI 7\nADDI 5\nSTORE 0x40\nLOAD 0x40\nSTORE 0xFE\nHALT';
const makeLab = (options = {}) => {const lab = new CpuLab(fixture.netlist,options);lab.loadProgram(program);return lab;};
const json = value => JSON.parse(JSON.stringify(value));

test('CPU save restores registers, RAM, cache, devices, trace and future execution in a cold lab',() => {
  const source = makeLab({latency:5,cache:true});
  source.input = 42;
  for (let i = 0; i < 4; i++) source.stepInstruction();
  assert.equal(source.ram[0x40],12);
  assert.equal(source.cacheLines[0].valid,true);
  const saved = json(captureExecution({lab:source}));
  const restored = makeLab();
  restored.stepClock();
  assert.ok(restored.history.length);
  assert.equal(restoreExecution(saved,{lab:restored}),true);
  assert.deepEqual(restored.getState(),source.getState());
  assert.deepEqual(restored.sim.snapshot(),source.sim.snapshot());
  assert.deepEqual([...restored.ram],[...source.ram]);
  assert.deepEqual(restored.cacheLines,source.cacheLines);
  assert.deepEqual(restored.cacheStats,source.cacheStats);
  assert.deepEqual(restored.events,source.events);
  assert.deepEqual(restored.trace,source.trace);
  assert.equal(restored.input,42);
  assert.equal(restored.latency,5);
  assert.equal(restored.cache,true);
  assert.equal(restored.history.length,0);
  while (!source.halted) {source.stepInstruction();restored.stepInstruction();}
  assert.deepEqual(captureExecution({lab:restored}),captureExecution({lab:source}));
  assert.equal(restored.display,12);
});

test('a restored pending STORE stays pending and commits once at the original acknowledgement edge',() => {
  const source = makeLab({latency:7,cache:true});
  while (!source.pending) source.stepClock();
  source.stepClock(); source.stepClock();
  const saved = json(captureExecution({lab:source}));
  const restored = makeLab();
  restoreExecution(saved,{lab:restored});
  assert.equal(restored.ram[0x40],0);
  assert.ok(restored.pending.remaining > 0);
  while (source.pending) {
    source.stepClock(); restored.stepClock();
    assert.deepEqual(restored.getState(),source.getState());
    assert.deepEqual([...restored.ram],[...source.ram]);
  }
  assert.equal(restored.ram[0x40],12);
  const writes = restored.events.filter(event => event.type === 'write' && event.address === 0x40);
  assert.equal(writes.length,1);
  assert.equal(writes[0].id,saved.pending.id);
  restored.stepInstruction();
  assert.equal(restored.events.filter(event => event.type === 'write' && event.address === 0x40).length,1);
});

test('program and circuit mismatches reject before changing the live machine',() => {
  const source = makeLab(); source.stepInstruction();
  const saved = captureExecution({lab:source});
  const otherProgram = makeLab(); otherProgram.loadProgram('LDI 99\nHALT');
  const before = captureExecution({lab:otherProgram});
  assert.throws(() => restoreExecution(saved,{lab:otherProgram}),/saved program differs/i);
  assert.deepEqual(captureExecution({lab:otherProgram}),before);
  const otherNetlist = json(fixture.netlist);
  const addition = Object.values(otherNetlist.modules.top.cells).find(cell => cell.type === '$add');
  addition.type = '$sub';
  const otherCircuit = new CpuLab(otherNetlist); otherCircuit.loadProgram(program);
  const beforeCircuit = captureExecution({lab:otherCircuit});
  assert.throws(() => restoreExecution(saved,{lab:otherCircuit}),/saved circuit differs/i);
  assert.deepEqual(captureExecution({lab:otherCircuit}),beforeCircuit);
});

test('corrupted bytes, register identities, bit values and memory timing reject atomically',() => {
  const source = makeLab({latency:4}); while (!source.pending) source.stepClock();
  const saved = captureExecution({lab:source});
  const target = makeLab(); target.stepInstruction();
  const before = captureExecution({lab:target});
  const corruptions = [
    data => {data.ram[0] = 256;},
    data => {data.ram.pop();},
    data => {data.sim.registers[0][0] = 'unknown-register';},
    data => {data.sim.registers[0][1][0] = 2;},
    data => {data.sim.inputs[0][1][0] = 'x';},
    data => {data.sim.cycle = -1;},
    data => {data.pending.remaining = data.pending.latency;},
    data => {data.pending.responseData = -1;},
    data => {data.cacheLines[0].tag = 16;},
    data => {data.cacheStats.reads++;},
    data => {data.events[0].type = 'maybe-store';},
  ];
  for (const corrupt of corruptions) {
    const data = json(saved); corrupt(data);
    assert.throws(() => restoreExecution(data,{lab:target}),/Saved execution cannot be restored/);
    assert.deepEqual(captureExecution({lab:target}),before);
  }
});

test('generic circuit saves retain unknown registers and unknown driven inputs',() => {
  const netlist = {modules:{top:{
    attributes:{top:1},
    ports:{clk:{direction:'input',bits:[2]},d:{direction:'input',bits:[3]},q:{direction:'output',bits:[4]}},
    cells:{state:{type:'$dff',parameters:{CLK_POLARITY:1},port_directions:{CLK:'input',D:'input',Q:'output'},connections:{CLK:[2],D:[3],Q:[4]}}},
  }}};
  const source = new CircuitSimulator(netlist);
  source.setInput('d',null).tick();
  const saved = json(captureExecution({sim:source}));
  const restored = new CircuitSimulator(json(netlist));
  restored.setInput('d',1).tick();
  assert.equal(restored.getPort('q'),1);
  assert.equal(restoreExecution(saved,{sim:restored}),true);
  assert.equal(restored.getPort('q'),null);
  assert.equal(restored.getPort('d'),null);
  assert.equal(restored.cycle,1);
  assert.deepEqual(restored.snapshot(),source.snapshot());
  restored.setInput('d',0).tick();
  assert.equal(restored.getPort('q'),0);
});

test('snapshot logs are bounded, detached JSON data and missing snapshots are harmless',() => {
  const lab = makeLab();lab.stepInstruction();lab.stepInstruction();lab.stepInstruction();
  const lastEvent = lab.events.at(-1),lastTrace = lab.trace.at(-1);
  lab.events = Array.from({length:1200},() => ({...lastEvent}));
  lab.trace = Array.from({length:1200},() => ({...lastTrace,memory:{...lastTrace.memory}}));
  const saved = captureExecution({lab});
  assert.equal(saved.events.length,1024);
  assert.equal(saved.trace.length,1024);
  assert.ok(JSON.stringify(saved).length < 500*1024);
  saved.ram[0x40] = 99;
  assert.equal(lab.ram[0x40],12);
  assert.equal(restoreExecution(null,{lab}),false);
  assert.equal(restoreExecution(undefined,{lab}),false);
  assert.equal(captureExecution(),null);
});
