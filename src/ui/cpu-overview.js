// A curated architectural map of the real synthesized default CPU. This view
// groups cells for learning; it does not claim these blocks are RTL hierarchy.
const id = name => `overview:${name}`;
const sameBits = (a = [], b = []) => a.length === b.length && a.every((bit,i) => bit === b[i]);
const outputBits = cell => Object.entries(cell.port_directions || {}).filter(([,direction]) => direction === 'output').flatMap(([name]) => cell.connections[name] || []);
const regCell = cell => /^\$(?:a|s)?dff/.test(cell.type);

export function makeCpuOverview(compiled) {
  const netlist = compiled.netlist || compiled;
  const top = compiled.top || Object.keys(netlist.modules).find(name => Number(netlist.modules[name].attributes?.top) === 1) || Object.keys(netlist.modules)[0];
  const module = netlist.modules[top];
  const cells = Object.entries(module.cells || {});
  const bits = name => module.ports[name]?.bits || module.netnames?.[name]?.bits || [];
  const sourceLine = (pattern,fallback) => {
    const index = (compiled.source || '').split('\n').findIndex(line => pattern.test(line));
    return `design.v:${index < 0 ? fallback : index + 1}`;
  };
  const groups = Object.fromEntries(['pc','a','ir','flags','controller','decoder','alu','rom','ram','display'].map(name => [name,[]]));
  const registerPorts = {};
  for (const [cellId,cell] of cells) {
    const outputs = outputBits(cell);
    let group;
    if (/arithmetic(?:[.$\\]|$)/.test(cellId) || /arithmetic/.test(cell.attributes?.hdlname || '')) group = 'alu';
    else if (regCell(cell)) {
      group = ['pc','a','ir'].find(name => outputs.some(bit => bits(name).includes(bit)));
      if (!group && outputs.some(bit => [...bits('z'),...bits('c')].includes(bit))) group = 'flags';
      group ||= 'controller';
      if (['pc','a','ir'].includes(group)) registerPorts[group] = cell.connections;
    } else if (cell.type === '$add' && sameBits(cell.connections.A,bits('pc'))) group = 'pc';
    else group = 'decoder';
    groups[group].push(cellId);
  }
  const src = (name,fallback) => {
    const sources = groups[name].map(cellId => module.cells[cellId].attributes?.src).filter(Boolean);
    return sources.length ? [...new Set(sources)].join(' | ') : fallback;
  };
  const port = (name,direction,net,portBits = bits(net)) => ({name,direction,width:portBits.length || 1,bits:portBits,signalName:net});
  const node = (name,label,kind,width,position,signalName,ports,description,source) => ({
    id:id(name),label,kind,type:kind,width,position,signalName,ports,
    cellIds:groups[name],source:src(name,source),description,
    overview:true,scope:'Architecture overview',mapping:'Curated group of actual synthesized cells',
    ...(signalName ? {bits:bits(signalName)} : {}),
  });
  const flags = [...bits('z'),...bits('c')];
  const nodes = [
    node('rom','Program ROM','memory',16,[-12,0,-8],'instruction',[
      port('address','input','pc'),port('instruction','output','instruction'),
    ],'External program service: PC selects a 16-bit instruction asynchronously. The CPU captures that instruction on the FETCH edge. This block is supplied by the simulator.', 'src/core/cpu-lab.js'),
    node('pc','Program counter','register',8,[-12,0,0],'pc',[
      port('pc','output','pc'),port('branch_target','input','operand'),port('enable','input',null,registerPorts.pc?.EN || []),
    ],'The actual PC register and its incrementer. FETCH increments PC; a taken jump writes the operand as the next instruction address.',sourceLine(/output reg \[7:0\] pc/,24)),
    node('ir','Instruction register','register',16,[-4,0,-8],'ir',[
      port('instruction','input','instruction'),port('opcode','output','opcode'),port('operand','output','operand'),port('enable','input',null,registerPorts.ir?.EN || []),
    ],'Captures the 16-bit ROM word. The high byte selects the operation and the low byte is an immediate or memory address.',sourceLine(/output reg \[15:0\] ir/,25)),
    node('decoder','Decode & routing','control',8,[4,0,-8],'opcode',[
      port('opcode','input','opcode'),port('state','input','state'),port('operand','input','operand'),port('selected_right','output','alu_right'),
    ],'A curated group containing the synthesized instruction comparators, selectors and remaining control logic. Expand it to inspect the actual cells; this is an overview grouping rather than an RTL module.',sourceLine(/wire \[7:0\] opcode/,40)),
    node('controller','Controller','control',4,[12,0,-8],'state',[
      port('state','output','state'),port('request','output','mem_valid'),port('response','input','mem_resp_valid'),port('retired','output','retired'),port('fault','output','fault'),
    ],'Actual state, fetched-address and fault registers. State 0 FETCH, 1 EXEC, 2 DATA_REQ, 3 DATA_WAIT, 4 STOPPED. Combinational next-state and enable logic is grouped under Decode & routing.',sourceLine(/output reg \[3:0\] state/,27)),
    node('a','Accumulator A','register',8,[-4,0,0],'a',[
      port('a','output','a'),port('alu_result','input','alu_result'),port('read_data','input','mem_rdata'),port('enable','input',null,registerPorts.a?.EN || []),
    ],'The processor’s 8-bit working register. Loads, immediate values and arithmetic results update A only at the corresponding clock edge.',sourceLine(/output reg \[7:0\] pc/,24)),
    node('alu','Arithmetic unit','alu',8,[4,0,0],'alu_result',[
      port('left','input','arithmetic.left'),port('right','input','arithmetic.right'),port('subtract','input','arithmetic.subtract'),port('result','output','alu_result'),port('zero','output','alu_zero'),port('carry','output','alu_carry'),
    ],'The real alu8 arithmetic module: addition, subtraction, result selection, zero and carry. ADD selects memory response data; ADDI and SUBI select the instruction operand.',sourceLine(/module alu8/,3)),
    {...node('flags','Zero / carry flags','register',2,[12,0,0],null,[
      port('zero','output','z'),port('carry','output','c'),port('alu_zero','input','alu_zero'),port('alu_carry','input','alu_carry'),
    ],'Two actual one-bit registers, shown as [carry, zero]. Branches test zero. Stores preserve flags; carry describes addition overflow or subtraction with no borrow.',sourceLine(/output reg z, c/,26)),bits:flags},
    {...node('ram','Data RAM / cache','memory',8,[4,0,9],null,[
      port('address','input','mem_addr'),port('write_data','input','mem_wdata'),port('read_data','output','mem_rdata'),port('request','input','mem_valid'),port('response','output','mem_resp_valid'),
    ],'External 256-byte memory service with an optional four-line cache. The shown byte is the current or last accessed RAM address. Accepted requests wait for a response; stores commit exactly once at acknowledgement.', 'src/core/cpu-lab.js'),mapping:'External memory service; no synthesized cells',external:true},
    {...node('display','Numeric display','output',8,[-4,0,9],null,[
      port('write_data','input','mem_wdata'),
    ],'External memory-mapped output at address FE. A completed STORE FE saves A to the display. The display remains visible after the processor halts.', 'src/core/cpu-lab.js'),mapping:'External memory-mapped output; no synthesized cells',external:true},
  ];
  nodes.find(item => item.id === id('rom')).external = true;
  nodes.find(item => item.id === id('rom')).mapping = 'External asynchronous program service; no synthesized cells';
  const edge = (name,from,to,label,signalName,activity,extra = {}) => {
    const wireBits = extra.bits || bits(signalName);
    return {id:`overview:wire:${name}`,from:id(from),to:id(to),label,signalName,bits:wireBits,width:wireBits.length || 1,activity,kind:extra.kind || 'data',source:signalName ? module.netnames?.[signalName]?.attributes?.src || module.attributes?.src : 'src/core/cpu-lab.js',overview:true,...extra};
  };
  const edges = [
    edge('fetch-address','pc','rom','ROM address','pc','fetch'),
    edge('fetch-word','rom','ir','Instruction','instruction','fetch'),
    edge('opcode','ir','decoder','Opcode','opcode','decode'),
    edge('decode-state','decoder','controller','Decode','opcode','decode',{kind:'control'}),
    edge('immediate','ir','a','Load immediate','operand','ldi'),
    edge('alu-immediate','ir','alu','Immediate operand','operand','immediate'),
    edge('jump','ir','pc','Jump target','operand','branch'),
    edge('memory-address','ir','ram','RAM address','mem_addr','memory'),
    edge('alu-left','a','alu','ALU left','a','arithmetic'),
    edge('alu-result','alu','a','ALU result','alu_result','arithmetic'),
    edge('alu-flags','alu','flags','Zero / carry',null,'arithmetic',{bits:[...bits('alu_zero'),...bits('alu_carry')]}),
    edge('branch-flags','flags','controller','Branch flags',null,'conditional',{bits:flags,kind:'control'}),
    edge('pc-enable','controller','pc','PC enable',null,'pc-enable',{bits:registerPorts.pc?.EN || [],kind:'control'}),
    edge('ir-enable','controller','ir','IR enable',null,'fetch',{bits:registerPorts.ir?.EN || [],kind:'control'}),
    edge('a-enable','controller','a','A enable',null,'a-enable',{bits:registerPorts.a?.EN || [],kind:'control'}),
    edge('memory-request','controller','ram','Request','mem_valid','request',{kind:'control'}),
    edge('memory-response','ram','controller','Response','mem_resp_valid','response',{kind:'control'}),
    edge('store-data','a','ram','Store byte','mem_wdata','store'),
    edge('load-data','ram','a','Load byte','mem_rdata','load'),
    edge('add-data','ram','alu','ADD byte','mem_rdata','add-memory'),
    edge('display-data','ram','display','STORE FE','mem_wdata','display'),
  ];
  return {nodes,edges,overview:true,description:'Architecture overview mapped to the actual synthesized CPU. External ROM, RAM/cache and display are simulator services.'};
}

export function getCpuOverviewSignals(graph,lab) {
  const state = lab.getState();
  const sim = lab.sim;
  const read = name => {
    if (!name) return null;
    const bits = sim.module.ports[name]?.bits || sim.module.netnames?.[name]?.bits;
    return bits?.length ? sim.getBits(bits) : null;
  };
  const readBits = bits => bits?.length ? sim.getBits(bits) : null;
  const opcode = state.ir === null ? null : state.ir >>> 8;
  const exec = state.state === 1;
  const response = state.state === 3 && read('mem_resp_valid') === 1;
  const immediate = exec && (opcode === 5 || opcode === 6);
  const addMemory = response && opcode === 4;
  const arithmetic = immediate || addMemory;
  const conditional = exec && (opcode === 8 || opcode === 9);
  const branch = exec && (opcode === 7 || opcode === 8 && state.z === 1 || opcode === 9 && state.z === 0);
  const memory = state.state === 2 || state.state === 3;
  const load = response && opcode === 2;
  const ldi = exec && opcode === 1;
  const activity = {
    fetch:state.state === 0 && !state.halted,decode:exec || memory,ldi,immediate,branch,memory,arithmetic,conditional,
    'pc-enable':state.state === 0 && !state.halted || branch,'a-enable':ldi || load || arithmetic,
    request:read('mem_valid') === 1,response,
    store:memory && opcode === 3,load,'add-memory':addMemory,
    display:response && opcode === 3 && read('mem_addr') === 0xFE,
  };
  const lastMemory = [...lab.events].reverse().find(event => event.type !== 'request');
  const address = lab.pending?.address ?? lastMemory?.address ?? read('mem_addr') ?? 0;
  const nodeActive = {pc:activity['pc-enable'],a:activity['a-enable'],ir:activity.fetch,flags:arithmetic || ldi || load,controller:!state.halted,decoder:activity.decode,alu:arithmetic,rom:activity.fetch,ram:memory,display:activity.display};
  const nodeValues = Object.fromEntries(graph.nodes.map(node => {
    const name = node.id.replace('overview:','');
    const value = name === 'display' ? lab.display : name === 'ram' ? address === 0xFF ? lab.input & 255 : lab.ram[address] : node.signalName ? read(node.signalName) : readBits(node.bits);
    return [node.id,{value,active:Boolean(nodeActive[name])}];
  }));
  const edgeValues = Object.fromEntries(graph.edges.map(edge => [edge.id,{value:edge.signalName ? read(edge.signalName) : readBits(edge.bits),active:Boolean(activity[edge.activity])}]));
  return {nodeValues,edgeValues};
}
