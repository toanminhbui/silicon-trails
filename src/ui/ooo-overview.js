// Logical teaching-model channels, not synthesized nets or transistor timing.
const nodeId = name => `ooo:${name}`;
const DEFINITIONS = [
  ['decode','Fetch / decode','control',[-12,0,-12],'The next program instruction is decoded for in-order dispatch. This high-level model has no branches or branch speculation.'],
  ['dispatch','2-wide dispatch','control',[0,0,-12],'Dispatch up to two instructions per cycle, in program order. Full ROB, reservation stations, LSQ or physical-register resources apply backpressure.'],
  ['rename','Speculative register map','control',[12,0,-12],'Capture physical source tags before allocating a fresh destination. Even the second instruction in a dispatch bundle sees the first instruction’s new mapping.'],
  ['rob','Reorder buffer','control',[12,0,-4],'Every dispatched instruction has an entry. Results can complete early, but only ready entries at the head can retire. The displayed value is occupied entries.'],
  ['rs','Reservation stations','control',[-12,0,-4],'Instructions wait on their actual physical source tags. The oldest ready instruction for each functional unit issues. Displayed value: waiting entries.'],
  ['physical','Physical registers','register',[0,0,-4],'Finite physical registers hold values and ready bits. Completion wakes dependent work. Old committed versions are returned to the free list at retirement. Displayed value: free registers.'],
  ['alu','Integer ALU','alu',[-12,0,4],'A single integer unit executes LI, ADD, SUB and ADDI with one-cycle latency. Displayed value: cycles remaining on the active operation.'],
  ['mul','Multiply unit','alu',[0,0,4],'A separate, nonpipelined multicycle multiplier lets younger independent ALU work complete first. Displayed value: cycles remaining.'],
  ['lsq','Load / store queue','memory',[12,0,4],'Compute addresses, wait for unknown older stores, bypass known nonaliases and forward from the youngest matching older store. Stores retain data until retirement. Displayed value: occupied entries.'],
  ['commit','In-order retirement','control',[-12,0,12],'Retire at most two ready ROB-head instructions per cycle. Architectural mappings and RAM stores change here. Displayed value: total retired instructions.'],
  ['architectural-map','Architectural map','register',[0,0,12],'The committed R0–R7 map describes precise architectural state. It can differ from the speculative rename map. Displayed value: the committed physical tag for R1.'],
  ['memory','Data memory','memory',[12,0,12],'256-byte external memory. Store effects occur only at retirement; uncommitted store forwarding does not modify RAM. FE is the display and FF is input. Displayed value: RAM at the latest accessed address.'],
];

export function makeOooOverview(lab) {
  const nodes = DEFINITIONS.map(([name,label,kind,position,description]) => ({
    id:nodeId(name),label,kind,type:'OoO teaching unit',width:8,position,
    unit:name,source:'src/core/ooo-lab.js',description:`${description} This is a high-level teaching model, separate from the synthesized RTL CPU.`,
    scope:'Out-of-order teaching model',model:'teaching-ooo',cellIds:[],ports:[],
  }));
  const channel = (name,from,to,label,select,width = 8) => ({id:`ooo:channel:${name}`,from:nodeId(from),to:nodeId(to),label,width,select,conceptual:true,source:'src/core/ooo-lab.js',description:'Logical model event channel; its displayed number is a real tag, byte, address or count rather than an electrical bus net.'});
  const edges = [
    channel('decode','decode','dispatch','Instruction PC','decode'),
    channel('rename','dispatch','rename','Allocate physical tag','rename',7),
    channel('tags','rename','physical','Destination tag','rename',7),
    channel('enqueue-rs','dispatch','rs','RS instruction PC','enqueue-rs'),
    channel('enqueue-lsq','dispatch','lsq','LSQ instruction PC','enqueue-lsq'),
    channel('enqueue-rob','dispatch','rob','ROB sequence ID','enqueue-rob',16),
    channel('alu-issue','rs','alu','ALU input ready','alu-issue',1),
    channel('mul-issue','rs','mul','MUL input ready','mul-issue',1),
    channel('alu-writeback','alu','physical','Completed byte','alu-complete'),
    channel('mul-writeback','mul','physical','Completed byte','mul-complete'),
    channel('wakeup','physical','rs','Ready physical tag','writeback',7),
    channel('memory-address','lsq','memory','Load address','load-issue'),
    channel('load-value','memory','physical','Completed load byte','load-complete'),
    channel('forward','lsq','physical','Forwarded store byte','forward'),
    channel('store-ready','lsq','rob','Store prepared','store-ready',1),
    channel('completion','physical','rob','Instruction completed','complete',1),
    channel('retire','rob','commit','Retired sequence ID','commit',16),
    channel('committed-map','commit','architectural-map','Committed physical tag','architectural-map',7),
    channel('reclaim','architectural-map','physical','Reclaimed tag','reclaim',7),
    channel('commit-store','commit','memory','Committed store byte','memory-write'),
  ];
  return {nodes,edges,model:'teaching-ooo',overview:true,description:'Logical event channels in a high-level out-of-order processor model. No RTL synthesis or physical timing is implied.',config:lab?.getState().config};
}

export function getOooOverviewSignals(graph,lab) {
  const state = lab.getState();
  const events = state.lastEvents;
  const latest = predicate => [...events].reverse().find(predicate);
  const access = [...lab.events].reverse().find(event => event.address !== undefined);
  const values = {
    decode:state.pc,dispatch:events.filter(event=>event.type==='dispatch').length,rename:state.renameMap[1],
    rob:state.rob.length,rs:state.rs.length,physical:state.freeList.length,
    alu:state.units.alu ? Math.max(0,state.units.alu.doneAt-state.cycle) : 0,
    mul:state.units.mul ? Math.max(0,state.units.mul.doneAt-state.cycle) : 0,
    lsq:state.lsq.length,commit:state.stats.committed,'architectural-map':state.architecturalMap[1],memory:lab.ram[access?.address ?? 0x40],
  };
  const active = {
    decode:events.some(event=>event.type==='decode'),dispatch:events.some(event=>event.unit==='dispatch'),rename:events.some(event=>event.type==='rename'),
    rob:events.some(event=>['dispatch','complete','store-ready','commit'].includes(event.type)),rs:events.some(event=>event.type==='dispatch'&&event.destination==='reservation-stations'||event.type==='issue'&&['alu','mul'].includes(event.unit)),
    physical:events.some(event=>event.type==='writeback'||event.type==='rename'||event.type==='architectural-map'),
    alu:!!state.units.alu||events.some(event=>event.unit==='alu'),mul:!!state.units.mul||events.some(event=>event.unit==='mul'),
    lsq:events.some(event=>event.unit==='lsq'||event.unit==='lsu'||event.type==='dispatch'&&event.destination==='lsq'),
    commit:events.some(event=>event.type==='commit'),'architectural-map':events.some(event=>event.type==='architectural-map'),memory:events.some(event=>event.type==='memory-write'||event.type==='issue'&&event.unit==='lsu'),
  };
  const select = name => {
    let event,field;
    if (name==='decode') {event=latest(event=>event.type==='decode');field='pc';}
    if (name==='rename') {event=latest(event=>event.type==='rename');field='physical';}
    if (name==='enqueue-rs'||name==='enqueue-lsq') {event=latest(event=>event.type==='dispatch'&&event.destination===(name==='enqueue-rs'?'reservation-stations':'lsq'));field='pc';}
    if (name==='enqueue-rob') {event=latest(event=>event.type==='dispatch');field='id';}
    if (name==='alu-issue'||name==='mul-issue') {event=latest(event=>event.type==='issue'&&event.unit===(name==='alu-issue'?'alu':'mul'));return event?1:null;}
    if (name==='alu-complete'||name==='mul-complete'||name==='load-complete') {event=latest(event=>event.type==='complete'&&event.unit===(name==='alu-complete'?'alu':name==='mul-complete'?'mul':'lsu'));field='value';}
    if (name==='load-issue') {event=latest(event=>event.type==='issue'&&event.unit==='lsu');field='address';}
    if (name==='writeback') {event=latest(event=>event.type==='writeback');field='physical';}
    if (name==='forward') {event=latest(event=>event.type==='forward');field='value';}
    if (name==='store-ready') {event=latest(event=>event.type==='store-ready');return event?1:null;}
    if (name==='complete') {event=latest(event=>event.type==='writeback');return event?1:null;}
    if (name==='commit') {event=latest(event=>event.type==='commit');field='id';}
    if (name==='architectural-map'||name==='reclaim') {event=latest(event=>event.type==='architectural-map');field=name==='reclaim'?'freed':'physical';}
    if (name==='memory-write') {event=latest(event=>event.type==='memory-write');field='value';}
    return event?event[field]??null:null;
  };
  return {
    nodeValues:Object.fromEntries(graph.nodes.map(node=>[node.id,{value:values[node.unit]??null,active:!!active[node.unit]}])),
    edgeValues:Object.fromEntries(graph.edges.map(edge=>{const value=select(edge.select);return [edge.id,{value,active:value!==null}];})),
  };
}
