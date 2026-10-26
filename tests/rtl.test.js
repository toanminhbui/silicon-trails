import test from 'node:test';
import assert from 'node:assert/strict';
import { compileVerilog } from '../src/rtl/compiler.js';
import { RTL_EXAMPLES } from '../src/rtl/examples.js';
import { CircuitSimulator } from '../src/core/simulator.js';
import { CircuitBuilder } from '../src/ui/builder.js';

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

test('exported builder control and arithmetic preserve behavior after actual RTL synthesis', async () => {
  const builder=new CircuitBuilder({empty:true});
  const a=builder.add('input'),b=builder.add('input');
  const eq=builder.add('eq'),lt=builder.add('lt'),mux=builder.add('mux'),reg=builder.add('register');
  const outputs=[];
  for(const type of ['sub','mul','shl','shr']){
    const operation=builder.add(type),output=builder.add('output');
    builder.connect({from:a,to:operation,toPort:'A'});builder.connect({from:b,to:operation,toPort:'B'});
    builder.connect({from:operation,to:output});outputs.push(output);
  }
  for(const id of [eq,lt,mux]){builder.connect({from:a,to:id,toPort:'A'});builder.connect({from:b,to:id,toPort:'B'});}
  builder.connect({from:lt,to:mux,toPort:'S'});builder.connect({from:eq,to:reg,toPort:'EN'});builder.connect({from:mux,to:reg,toPort:'D'});
  for(const source of [mux,reg]){const output=builder.add('output');builder.connect({from:source,to:output});outputs.push(output);}
  const compiled=await compileVerilog(builder.toVerilog());
  const direct=new CircuitSimulator(builder.getNetlist()),synthesized=new CircuitSimulator(compiled.netlist);
  for(const [left,right] of [[7,7],[128,127],[1,2],[255,7],[128,8],[255,255]]){
    for(const sim of [direct,synthesized])sim.setInput(a,left).setInput(b,right).tick();
    for(const output of outputs)assert.equal(synthesized.getPort(output),direct.getPort(output),`${left}, ${right}: ${output}`);
  }
});

test('nested reusable modules export real hierarchy and synthesize into independent shared-clock state', async () => {
  const builder=new CircuitBuilder();
  const preview=builder.previewModule(['add1','register1']),portNames={};
  for(const [nodeId,port,name] of [['add1','A','A'],['add1','B','B'],['register1','EN','EN'],['register1','Q','Q']]){
    const boundary=preview.ports.find(p=>p.bindings.some(b=>b.nodeId===nodeId&&b.port===port));
    assert.ok(boundary);portNames[boundary.name]=name;
  }
  const inner=builder.createModule({name:'Enabled sum',nodeIds:['add1','register1'],portNames}).instanceId;
  const secondRegister=builder.add('register');
  builder.connect({from:inner,fromPort:'Q',to:secondRegister,toPort:'D'});
  builder.connect({from:'inputEnable',to:secondRegister,toPort:'EN'});
  builder.connect({from:secondRegister,fromPort:'Q',to:'output1'});
  const outerPreview=builder.previewModule([inner,secondRegister]),outerNames={};
  for(const p of outerPreview.ports){
    if(p.direction==='output')outerNames[p.name]='Q';
    else if(p.bindings.some(b=>b.nodeId===inner&&b.port==='A'))outerNames[p.name]='A';
    else if(p.bindings.some(b=>b.nodeId===inner&&b.port==='B'))outerNames[p.name]='B';
    else outerNames[p.name]=p.bindings.some(b=>b.nodeId===inner)?'EN':'EN2';
  }
  const packed=builder.createModule({name:'Two-stage sum',nodeIds:[inner,secondRegister],portNames:outerNames});
  const second=builder.addModule(packed.moduleId,[10,0,0]);
  const enable=builder.add('switch'),output=builder.add('output');
  builder.setInput(enable,1);
  for(const p of builder.getSpec(second).ports.filter(p=>p.direction==='input')){
    builder.connect({from:p.name==='A'?'inputA':p.name==='B'?'inputB':enable,to:second,toPort:p.name});
  }
  builder.connect({from:second,fromPort:'Q',to:output});
  const compiled=await compileVerilog(builder.toVerilog());
  assert.ok(Object.keys(compiled.hierarchy.modules).length>=3,'pre-flatten synthesis retains top, outer and inner module definitions');
  const moduleNames=new Set(Object.keys(compiled.hierarchy.modules));
  assert.ok(Object.values(compiled.hierarchy.modules.top.cells).some(cell=>moduleNames.has(cell.type)),'top instantiates native child modules');
  const direct=new CircuitSimulator(builder.getNetlist()),synthesized=new CircuitSimulator(compiled.netlist);
  assert.equal(direct.sequential.length,4);
  assert.equal(synthesized.sequential.length,4);
  const scenarios=[
    {a:7,b:5,first:1,second:1,expected:[null,null]},
    {a:20,b:5,first:1,second:1,expected:[12,12]},
    {a:1,b:2,first:0,second:1,expected:[12,25]},
    {a:8,b:9,first:1,second:0,expected:[25,25]},
    {a:250,b:10,first:1,second:1,expected:[17,3]},
  ];
  for(const row of scenarios){
    for(const sim of [direct,synthesized])sim.setInput('inputA',row.a).setInput('inputB',row.b).setInput('inputEnable',row.first).setInput(enable,row.second).tick();
    const expected=row.expected;
    assert.deepEqual([direct.getPort('output1'),direct.getPort(output)],expected,'constructed nested instances keep their own two-stage state');
    assert.deepEqual([synthesized.getPort('output1'),synthesized.getPort(output)],expected,'real hierarchical RTL has equivalent clock and enable behavior');
  }
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
