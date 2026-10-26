import test from 'node:test';
import assert from 'node:assert/strict';
import {CircuitBuilder} from '../src/ui/builder.js';
import {CircuitSimulator} from '../src/core/simulator.js';
import {getGraphSignals} from '../src/ui/circuit-graph.js';

const copy = value => JSON.parse(JSON.stringify(value));
function simulate(builder) {
  const sim = new CircuitSimulator(builder.getNetlist());
  for (const [name,value] of Object.entries(builder.getInputs())) sim.setInput(name,value);
  return sim.settle();
}

function packagePair(builder = new CircuitBuilder()) {
  const nodeIds = ['add1','register1'];
  const preview = builder.previewModule(nodeIds);
  const names = [['add1','A','A'],['add1','B','B'],['register1','EN','EN'],['register1','Q','Q']];
  const portNames = {};
  for (const [nodeId,port,name] of names) {
    const boundary = preview.ports.find(candidate => candidate.bindings.some(binding=>binding.nodeId===nodeId&&binding.port===port));
    assert.ok(boundary,`preview must expose ${nodeId}.${port}`);
    portNames[boundary.name] = name;
  }
  return {builder,...builder.createModule({name:'Enabled sum',nodeIds,portNames})};
}

function nestedPair() {
  const {builder,moduleId:innerDefinition,instanceId:inner} = packagePair();
  const secondRegister = builder.add('register',[6,0,7]);
  builder.connect({from:inner,fromPort:'Q',to:secondRegister,toPort:'D'});
  builder.connect({from:'inputEnable',to:secondRegister,toPort:'EN'});
  builder.connect({from:secondRegister,fromPort:'Q',to:'output1',toPort:'A'});
  const nodeIds = [inner,secondRegister],preview = builder.previewModule(nodeIds),portNames = {};
  for (const port of preview.ports) {
    const binding = port.bindings[0];
    if (port.direction==='output') portNames[port.name]='Q';
    else if (port.bindings.some(binding=>binding.nodeId===inner&&binding.port==='A')) portNames[port.name]='A';
    else if (port.bindings.some(binding=>binding.nodeId===inner&&binding.port==='B')) portNames[port.name]='B';
    else portNames[port.name]=binding.nodeId===inner?'EN':'EN2';
  }
  const outer = builder.createModule({name:'Two-stage sum',nodeIds,portNames});
  return {builder,inner,innerDefinition,secondRegister,...outer};
}

test('packaging a selected adder and register preserves boundary drivers, output wiring and clocked behavior',() => {
  const original = new CircuitBuilder();
  const outside = ['inputA','inputB','inputEnable','output1'].map(id=>copy(original.nodes.get(id)));
  const {builder,moduleId,instanceId} = packagePair(original);
  assert.equal(builder.nodes.has('add1'),false);
  assert.equal(builder.nodes.has('register1'),false);
  for (const node of outside) assert.deepEqual(builder.nodes.get(node.id),node);
  assert.equal(builder.listModules().length,1);
  assert.equal(builder.listModules()[0].id,moduleId);
  assert.deepEqual(builder.getSpec(instanceId).ports.map(({name,direction,width})=>({name,direction,width})).sort((a,b)=>a.name.localeCompare(b.name)),[
    {name:'A',direction:'input',width:8},{name:'B',direction:'input',width:8},{name:'EN',direction:'input',width:1},{name:'Q',direction:'output',width:8},
  ]);
  const sim = simulate(builder);
  assert.equal(sim.getPort('output1'),null);
  sim.tick();assert.equal(sim.getPort('output1'),12);
  sim.setInput('inputA',20).setInput('inputEnable',0).tick();assert.equal(sim.getPort('output1'),12);
  sim.setInput('inputEnable',1).tick();assert.equal(sim.getPort('output1'),25);
  const cells = builder.getNetlist().modules.top.cells;
  assert.ok(cells[`${instanceId}/add1`]);
  assert.ok(cells[`${instanceId}/register1`]);
  assert.equal(Object.keys(cells).length,2,'packaging creates hierarchy without extra simulation cells');
});

test('two instances of one saved definition own independent registers under one shared clock',() => {
  const {builder,moduleId,instanceId:first} = packagePair();
  const second = builder.addModule(moduleId,[14,0,0]);
  const enable = builder.add('switch',[7,0,7]),output = builder.add('output',[19,0,0]);
  builder.setInput(enable,1);
  builder.connect({from:'inputA',to:second,toPort:'A'});
  builder.connect({from:'inputB',to:second,toPort:'B'});
  builder.connect({from:enable,to:second,toPort:'EN'});
  builder.connect({from:second,fromPort:'Q',to:output});
  const sim = simulate(builder);
  assert.equal(sim.sequential.length,2);
  assert.deepEqual(sim.sequential.map(cell=>cell.connections.CLK),[[2],[2]]);
  assert.notDeepEqual(sim.module.cells[`${first}/register1`].connections.Q,sim.module.cells[`${second}/register1`].connections.Q);
  sim.tick();assert.deepEqual([sim.getPort('output1'),sim.getPort(output)],[12,12]);
  sim.setInput('inputA',20).setInput('inputEnable',0).tick();
  assert.deepEqual([sim.getPort('output1'),sim.getPort(output)],[12,25]);
  sim.setInput('inputA',1).setInput('inputEnable',1).setInput(enable,0).tick();
  assert.deepEqual([sim.getPort('output1'),sim.getPort(output)],[6,25]);
});

test('nested modules flatten to simultaneous shared-clock state rather than ticking child simulators separately',() => {
  const {builder,instanceId:outer,inner,secondRegister} = nestedPair();
  const sim = simulate(builder);
  assert.equal(builder.listModules().length,2);
  assert.equal(sim.sequential.length,2);
  assert.ok(sim.module.cells[`${outer}/${inner}/register1`]);
  assert.ok(sim.module.cells[`${outer}/${secondRegister}`]);
  assert.deepEqual(Object.keys(sim.module.ports).sort(),['clk','inputA','inputB','inputEnable','output1'].sort());
  sim.tick();assert.equal(sim.getPort('output1'),null,'second stage captures the first stage’s old unknown value');
  sim.setInput('inputA',20).tick();assert.equal(sim.getPort('output1'),12);
  sim.setInput('inputA',1).tick();assert.equal(sim.getPort('output1'),25);
  assert.ok(sim.sequential.every(cell=>cell.connections.CLK[0]===2));
});

test('drilling into a nested instance binds its cells, ports and signals to the existing full simulation',() => {
  const {builder,instanceId:outer,inner} = nestedPair();
  const sim = simulate(builder).tick();
  const path = [outer,inner],graph = builder.getDesign({path});
  const register = graph.nodes.find(node=>node.localId==='register1');
  const adder = graph.nodes.find(node=>node.localId==='add1');
  assert.ok(register&&adder);
  assert.equal(register.id,`${outer}/${inner}/register1`);
  assert.equal(register.cellId,register.id);
  assert.equal(adder.cellId,adder.id);
  assert.deepEqual(register.bits,sim.module.cells[register.cellId].connections.Q);
  const q = builder.getInstancePorts(path).find(port=>port.name==='Q');
  assert.ok(q);
  assert.deepEqual(q.bits,register.bits);
  assert.equal(sim.getBits(q.bits),12);
  let signals = getGraphSignals(graph,sim);
  assert.equal(signals.nodeValues[register.id].value,12);
  assert.equal(signals.nodeValues[adder.id].value,12);
  sim.setInput('inputA',20).settle();
  signals = getGraphSignals(graph,sim);
  assert.equal(signals.nodeValues[adder.id].value,25);
  assert.equal(signals.nodeValues[register.id].value,12,'drilldown reads the original register before the edge');
  sim.tick();assert.equal(getGraphSignals(graph,sim).nodeValues[register.id].value,25);
  assert.equal(builder.getDefinitionForPath(path).name,'Enabled sum');
});

test('custom module ports enforce widths and directions, and flattened feedback validation crosses the boundary',() => {
  const {builder,instanceId} = packagePair();
  const before = copy(builder.edges);
  assert.throws(()=>builder.connect({from:'inputA',to:instanceId,toPort:'EN'}),/width mismatch/i);
  assert.throws(()=>builder.connect({from:'inputEnable',to:instanceId,toPort:'A'}),/width mismatch/i);
  assert.throws(()=>builder.connect({from:instanceId,fromPort:'A',to:'output1'}),/output/i);
  assert.deepEqual(builder.edges,before);
  const combinational = new CircuitBuilder();
  const packed = combinational.createModule({name:'Adder',nodeIds:['add1']});
  const ports = combinational.getSpec(packed.instanceId).ports;
  const input = ports.find(port=>port.direction==='input'),output = ports.find(port=>port.direction==='output');
  const originalEdges = copy(combinational.edges);
  assert.throws(()=>combinational.connect({from:packed.instanceId,fromPort:output.name,to:packed.instanceId,toPort:input.name}),/feedback|loop/i);
  assert.deepEqual(combinational.edges,originalEdges);
});

test('version-one legacy projects and module-library JSON round trips preserve behavior and independent definitions',() => {
  const legacy = {
    version:1,serial:0,edgeSerial:5,
    nodes:[
      {id:'inputA',type:'input',position:[-10,0,-4],value:250},
      {id:'inputB',type:'input',position:[-10,0,3],value:5},
      {id:'inputEnable',type:'switch',position:[-3,0,8],value:1},
      {id:'add1',type:'add',position:[-3,0,-3]},
      {id:'register1',type:'register',position:[4,0,0]},
      {id:'output1',type:'output',position:[11,0,0]},
    ],
    edges:[
      {id:'cable_1',from:'inputA',fromPort:'Y',to:'add1',toPort:'A'},
      {id:'cable_2',from:'inputB',fromPort:'Y',to:'add1',toPort:'B'},
      {id:'cable_3',from:'add1',fromPort:'Y',to:'register1',toPort:'D'},
      {id:'cable_4',from:'inputEnable',fromPort:'Y',to:'register1',toPort:'EN'},
      {id:'cable_5',from:'register1',fromPort:'Q',to:'output1',toPort:'A'},
    ],
  };
  const original = CircuitBuilder.fromJSON(legacy);
  assert.equal(simulate(original).tick().getPort('output1'),255);
  packagePair(original);
  const exported = original.toJSON(),restored = CircuitBuilder.fromJSON(JSON.stringify(exported));
  assert.equal(exported.version,1);
  assert.deepEqual(restored.getNetlist(),original.getNetlist());
  assert.deepEqual(restored.listModules(),original.listModules());
  assert.equal(simulate(restored).tick().getPort('output1'),255);
  const listed = restored.listModules();listed[0].ports[0].name='changed';
  assert.notEqual(restored.listModules()[0].ports[0].name,'changed','library inspection must not mutate saved definitions');
  const savedDefinition = original.listModules()[0].id;
  assert.doesNotThrow(()=>restored.addModule(savedDefinition,[0,0,10]));
});

test('invalid port names, packaging external drivers, recursive definitions and bad references reject',() => {
  const original = new CircuitBuilder();
  assert.throws(()=>original.previewModule(['inputA','add1']),/input|external|functional|select|packag/i);
  const preview = original.previewModule(['add1','register1']);
  const inputs = preview.ports.filter(port=>port.direction==='input');
  assert.throws(()=>original.createModule({name:'Bad ports',nodeIds:['add1','register1'],portNames:{[inputs[0].name]:'same',[inputs[1].name]:'same'}}),/port|duplicate|name/i);
  assert.equal(original.listModules().length,0);
  assert.ok(original.nodes.has('add1')&&original.nodes.has('register1'));
  const {builder} = packagePair();
  const saved = builder.toJSON();
  const corruptions = [
    data=>{data.modules[0].nodes.push(copy(data.modules[0].nodes[0]));},
    data=>{data.modules[0].ports[0].bindings[0].nodeId='missing';},
    data=>{data.modules[0].edges[0].to='missing';},
    data=>{data.modules[0].ports.find(port=>port.width===1).width=8;},
    data=>{data.modules[0].nodes.push({id:'self',type:'module',moduleId:data.modules[0].id,label:'Recursive',position:[0,0,0]});},
    data=>{data.nodes.find(node=>node.type==='module').moduleId='missing-definition';},
  ];
  for (const corrupt of corruptions) {
    const data=copy(saved);corrupt(data);
    assert.throws(()=>CircuitBuilder.fromJSON(data),/module|port|duplicate|unknown|missing|invalid|recursive|cycle|component|endpoint|node/i);
  }
  assert.equal(simulate(builder).tick().getPort('output1'),12,'validation of imported data never modifies the existing construction');
});

test('renamed module ports reject Verilog and SystemVerilog keywords while allowing ordinary names containing them',() => {
  const builder=new CircuitBuilder(),nodeIds=['add1','register1'];
  const input=builder.previewModule(nodeIds).ports.find(port=>port.direction==='input');
  for(const name of ['bit','integer','repeat','posedge','always_ff','and']){
    assert.throws(()=>builder.createModule({name:'Reserved port',nodeIds,portNames:{[input.name]:name}}),/reserved|port|invalid/i);
    assert.equal(builder.listModules().length,0);
    assert.ok(builder.nodes.has('add1')&&builder.nodes.has('register1'));
  }
  const {instanceId}=builder.createModule({name:'Valid port',nodeIds,portNames:{[input.name]:'integer_value'}});
  assert.ok(builder.getSpec(instanceId).ports.some(port=>port.name==='integer_value'));
  assert.equal(simulate(builder).tick().getPort('output1'),12);
});

test('inferred names remain unique when nested instance IDs and custom port names contain overlapping underscores',() => {
  const {builder,instanceId}=packagePair();
  const saved=builder.toJSON(),definition=saved.modules[0];
  definition.ports.find(port=>port.name==='A').name='A_A';
  definition.ports.find(port=>port.name==='B').name='A';
  saved.nodes.find(node=>node.id===instanceId).id='unit';
  for(const edge of saved.edges){
    if(edge.from===instanceId)edge.from='unit';
    if(edge.to===instanceId){
      edge.to='unit';
      if(edge.toPort==='A')edge.toPort='A_A';
      else if(edge.toPort==='B')edge.toPort='A';
    }
  }
  saved.nodes.push({id:'unit_A',type:'module',moduleId:definition.id,position:[15,0,0]});
  const imported=CircuitBuilder.fromJSON(saved),nodeIds=['unit','unit_A'];
  const preview=imported.previewModule(nodeIds);
  assert.equal(new Set(preview.ports.map(port=>port.name)).size,preview.ports.length,'unit.A_A and unit_A.A need distinct exposed names');
  assert.doesNotThrow(()=>imported.createModule({name:'Joined instances',nodeIds}));
  assert.equal(simulate(imported).tick().getPort('output1'),12,'name disambiguation preserves the existing wired instance');
});
