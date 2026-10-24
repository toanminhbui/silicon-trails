import test from 'node:test';
import assert from 'node:assert/strict';
import {CircuitSimulator} from '../src/core/simulator.js';
import {assemble,disassemble,PROGRAMS} from '../src/core/assembler.js';

const bits = (start,width) => Array.from({length:width},(_,i) => start+i);
const cell = (type,connections,parameters = {}) => ({type,connections,parameters,port_directions:Object.fromEntries(Object.keys(connections).map(name => [name,['Y','Q'].includes(name) ? 'output' : 'input']))});
const netlist = (ports,cells,netnames = {}) => ({modules:{top:{ports,cells,netnames}}});
const port = (direction,start,width = 1) => ({direction,bits:bits(start,width)});

test('assembler resolves labels, literal bases and comments and rejects malformed programs',() => {
  const result = assemble('start: LDI 7 ; seven\n ADDI 0x05\n STORE 64\n JNZ start\nHALT');
  assert.deepEqual(result.words,[0x0107,0x0505,0x0340,0x0900,0xFF00]);
  assert.equal(disassemble(0x0340),'STORE 0x40');
  assert.throws(() => assemble('LDI 256'),/between 0 and 255/);
  assert.throws(() => assemble('HALT 1'),/expects 0/);
  assert.throws(() => assemble('JMP absent'),/unknown label/);
  assert.throws(() => assemble('x: NOP\nx: HALT'),/duplicate label/);
  assert.throws(() => assemble(Array(257).fill('NOP').join('\n')),/exceeds/);
  for (const program of PROGRAMS) assert.ok(assemble(program.source).words.length);
});

test('32-bit unsigned arithmetic retains the high bit and wraps without JS signed coercion',() => {
  const sim = new CircuitSimulator(netlist({a:port('input',2,32),b:port('input',34,32),y:port('output',66,32)}, {add:cell('$add',{A:bits(2,32),B:bits(34,32),Y:bits(66,32)})}));
  sim.setInput('a',0xFFFFFFFF).setInput('b',2).settle();
  assert.equal(sim.getPort('y'),1);
  sim.setInput('a',0x80000000).setInput('b',0).settle();
  assert.equal(sim.getPort('y'),0x80000000);
  assert.throws(() => sim.setInput('a',-1),/unsigned/);
});

test('signed arithmetic and comparisons sign-extend operands',() => {
  const sim = new CircuitSimulator(netlist({a:port('input',2,8),b:port('input',10,16),sum:port('output',26,16),lt:port('output',42)}, {
    sum:cell('$add',{A:bits(2,8),B:bits(10,16),Y:bits(26,16)},{A_SIGNED:1,B_SIGNED:1}),
    lt:cell('$lt',{A:bits(2,8),B:bits(10,16),Y:[42]},{A_SIGNED:1,B_SIGNED:1})
  }));
  sim.setInput('a',255).setInput('b',1).settle();
  assert.equal(sim.getPort('sum'),0);
  assert.equal(sim.getPort('lt'),1);
});

test('registers sample their old neighbors simultaneously and snapshots restore state',() => {
  const sim = new CircuitSimulator(netlist({clk:port('input',2),a:port('output',3),b:port('output',4)}, {
    first:cell('$dff',{CLK:[2],D:[4],Q:[3]},{CLK_POLARITY:1}),
    second:cell('$dff',{CLK:[2],D:[3],Q:[4]},{CLK_POLARITY:1})
  },{a:{bits:[3],attributes:{init:'0'}},b:{bits:[4],attributes:{init:'1'}}}));
  const snapshot = sim.snapshot();
  sim.tick();
  assert.equal(sim.getPort('a'),1);
  assert.equal(sim.getPort('b'),0);
  sim.tick();
  assert.equal(sim.getPort('a'),0);
  assert.equal(sim.getPort('b'),1);
  sim.restore(snapshot);
  assert.equal(sim.cycle,0);
  assert.equal(sim.getPort('a'),0);
});

test('synchronous reset takes priority over disabled enable for sdffe',() => {
  const sim = new CircuitSimulator(netlist({clk:port('input',2),reset:port('input',3),enable:port('input',4),d:port('input',5,8),q:port('output',13,8)}, {
    register:cell('$sdffe',{CLK:[2],SRST:[3],EN:[4],D:bits(5,8),Q:bits(13,8)},{CLK_POLARITY:1,SRST_POLARITY:1,EN_POLARITY:1,SRST_VALUE:'00000101'})
  }));
  sim.setInput('reset',1).setInput('enable',0).tick();
  assert.equal(sim.getPort('q'),5);
  sim.setInput('reset',0).setInput('d',77).tick();
  assert.equal(sim.getPort('q'),5);
  sim.setInput('enable',1).tick();
  assert.equal(sim.getPort('q'),77);
});

test('unknown values propagate with useful masking through gates and muxes',() => {
  const sim = new CircuitSimulator(netlist({a:port('input',2),b:port('input',3),s:port('input',4),and:port('output',5),mux:port('output',6)}, {
    gate:cell('$and',{A:[2],B:[3],Y:[5]}),mux:cell('$mux',{A:[2],B:[3],S:[4],Y:[6]})
  }));
  sim.setInput('a',null).setInput('b',0).setInput('s',1).settle();
  assert.equal(sim.getPort('and'),0);
  assert.equal(sim.getPort('mux'),0);
  sim.setInput('s',0).settle();
  assert.equal(sim.getPort('mux'),null);
});

test('unsupported cells, multiple drivers, combinational loops and oversized buses fail explicitly',() => {
  assert.throws(() => new CircuitSimulator(netlist({},{bad:cell('$mem_v2',{Y:[2]})})),/Unsupported RTL cell/);
  assert.throws(() => new CircuitSimulator(netlist({a:port('input',2),y:port('output',3)},{one:cell('$not',{A:[2],Y:[3]}),two:cell('$pos',{A:[2],Y:[3]})})),/Multiple drivers/);
  assert.throws(() => new CircuitSimulator(netlist({y:port('output',3)},{loop:cell('$not',{A:[3],Y:[3]})})),/feedback/);
  assert.throws(() => new CircuitSimulator(netlist({huge:port('input',2,33)},{})),/32 bits/);
});
