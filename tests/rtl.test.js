import test from 'node:test';
import assert from 'node:assert/strict';
import { compileVerilog } from '../src/rtl/compiler.js';
import { RTL_EXAMPLES } from '../src/rtl/examples.js';
import { CircuitSimulator } from '../src/core/simulator.js';

test('real synthesis preserves source hierarchy and executes every full-adder input', async () => {
  const example = RTL_EXAMPLES.find(item => item.id === 'fulladder');
  const result = await compileVerilog(example.source);
  assert.deepEqual(Object.keys(result.hierarchy.modules).sort(), ['full_adder', 'top']);
  assert.equal(result.hierarchy.modules.top.cells.bit_slice.type, 'full_adder');
  assert.ok(Object.values(result.netlist.modules.top.cells).some(cell => cell.attributes.src.includes('design.v:')));
  assert.ok(Object.values(result.netlist.modules.top.cells).every(cell => cell.type.startsWith('$')));
  const sim = new CircuitSimulator(result.netlist);
  for (let a = 0; a <= 1; a++) for (let b = 0; b <= 1; b++) for (let cin = 0; cin <= 1; cin++) {
    sim.setInput('a', a).setInput('b', b).setInput('cin', cin).settle();
    assert.equal(sim.getPort('sum'), (a + b + cin) & 1);
    assert.equal(sim.getPort('cout'), (a + b + cin) >> 1);
  }
});

test('editing RTL changes the synthesized circuit and its output', async () => {
  const first = await compileVerilog('module top(input [7:0] a,b, output [7:0] y); assign y=a+b; endmodule');
  const edited = await compileVerilog('module top(input [7:0] a,b, output [7:0] y); assign y=a-b; endmodule');
  const run = result => {
    const sim = new CircuitSimulator(result.netlist);
    sim.setInput('a', 7).setInput('b', 5).settle();
    return sim.getPort('y');
  };
  assert.equal(run(first), 12);
  assert.equal(run(edited), 2);
  assert.ok(Object.values(edited.netlist.modules.top.cells).some(cell => cell.type === '$sub'));
});

test('synthesized enabled counter resets, holds, and advances on clocks', async () => {
  const example = RTL_EXAMPLES.find(item => item.id === 'counter');
  const { netlist } = await compileVerilog(example.source);
  const sim = new CircuitSimulator(netlist);
  sim.setInput('reset', 1).tick();
  assert.equal(sim.getPort('count'), 0);
  sim.setInput('reset', 0).setInput('enable', 1).tick();
  assert.equal(sim.getPort('count'), 1);
  sim.setInput('enable', 0).tick();
  assert.equal(sim.getPort('count'), 1);
  sim.setInput('enable', 1).tick();
  assert.equal(sim.getPort('count'), 2);
});

test('malformed source and missing top modules return source diagnostics', async () => {
  await assert.rejects(compileVerilog('module top(input a, output y); assign y = ; endmodule'), /design\.v:1.*syntax error/i);
  await assert.rejects(compileVerilog('module other(input a, output y); assign y=a; endmodule'), /top.*not found/i);
  await assert.rejects(compileVerilog('module top(input a, output y); assign y=typo; endmodule'), /typo/);
});

test('unsupported latch, tristate, and multiple-clock circuits fail explicitly', async () => {
  await assert.rejects(compileVerilog('module top(input en,d, output reg q); always @* if(en) q=d; endmodule'), /latch|\$dlatch/i);
  await assert.rejects(compileVerilog("module top(input en,d, output y); assign y=en ? d : 1'bz; endmodule"), /tri|\$tribuf/i);
  await assert.rejects(compileVerilog('module top(input c1,c2,d, output reg q1,q2); always @(posedge c1) q1<=d; always @(posedge c2) q2<=d; endmodule'), /multiple.*clocks/i);
});
