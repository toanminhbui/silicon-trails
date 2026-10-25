import './styles.css';
import { EditorView, basicSetup } from 'codemirror';
import { StreamLanguage } from '@codemirror/language';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';
import { oneDark } from '@codemirror/theme-one-dark';
import { CircuitWorld } from './world/world.js';
import { CircuitSimulator } from './core/simulator.js';
import { CpuLab } from './core/cpu-lab.js';
import { PROGRAMS, assemble, disassemble } from './core/assembler.js';
import { RTL_EXAMPLES } from './rtl/examples.js';
import { compileVerilog } from './rtl/compiler.js';
import { makeNetlistGraph, getGraphSignals } from './ui/circuit-graph.js';
import { CircuitBuilder, BUILDER_TYPES } from './ui/builder.js';
import { makeCpuOverview, getCpuOverviewSignals } from './ui/cpu-overview.js';
import { icon, escapeHtml as esc, hex } from './ui/icons.js';

const BASE = import.meta.env.BASE_URL;
const STORAGE = 'silicon-trails-project-v1';
const $ = (selector) => document.querySelector(selector);
const phases = ['FETCH', 'EXECUTE', 'REQUEST', 'WAIT', 'HALTED'];
const state = {
  mode: 'explore', view: 'overview', compiled: null, exampleId: 'cpu',
  lab: null, sim: null, builder: new CircuitBuilder(), graph: null,
  selected: 'overview:a', panel: 'trace', memoryAddress: 0x40, running: false,
  speed: 8, cache: false, latency: 3, breakpoint: null, watchAddress: null,
  programSource: PROGRAMS[0].source, programName: PROGRAMS[0].name,
  genericHistory: [], genericTrace: [], dirty: false, compiling: false,
  tool: null, lastUpdate: 0, storedCompiled: null, scope: null,
};
let world, editor, toastTimer, saveTimer, suppressEditor = false;
let lastFrame = 0, clockBudget = 0;

$('#app').innerHTML = `<div class="app-shell">
  <header class="topbar">
    <a class="brand" href="/" aria-label="Silicon Trails home"><span class="brand-mark">${icon('cube',26)}</span><span>silicon<span>trails</span></span><span class="beta">LAB</span></a>
    <nav class="mode-tabs" aria-label="Workshop modes">
      <button class="mode-tab active" data-mode="explore">${icon('compass',16)} Explore</button>
      <button class="mode-tab" data-mode="build">${icon('blocks',16)} Build</button>
      <button class="mode-tab" data-mode="rtl">${icon('code',17)} RTL studio</button>
    </nav>
    <div class="top-actions"><span class="save-state"><span class="dot"></span><span id="save-label">Saved locally</span></span>
      <button class="btn ghost icon-only" data-action="import" title="Open project" aria-label="Open project">${icon('upload',16)}</button>
      <button class="btn" data-action="export">${icon('download',14)}<span>Save project</span></button>
      <a class="btn ghost icon-only" href="https://github.com/toanminhbui/silicon-trails" target="_blank" rel="noopener" aria-label="Open GitHub repository" title="Source on GitHub">${icon('external',16)}</a>
    </div>
  </header>
  <main class="workspace">
    <aside class="sidebar" id="sidebar" aria-label="Machine navigator"></aside>
    <section class="stage" aria-label="Circuit workshop">
      <div class="editor-pane">
        <div class="editor-header"><span class="editor-file">${icon('code',14)} processor.v <span class="unsaved-dot" id="editor-dot"></span></span><button class="btn primary small" data-action="compile" id="compile-button">${icon('play',12)} Synthesize</button></div>
        <select class="editor-select" id="rtl-example" aria-label="RTL example"><option value="custom">Custom Verilog</option>${RTL_EXAMPLES.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
        <div class="code-editor" id="code-editor" aria-label="Verilog source editor"></div>
        <div class="compile-status" id="compile-status">Yosys · synthesizable Verilog · runs locally in your browser</div>
      </div>
      <div class="world-container" id="world"></div>
      <div class="stage-toolbar"><div><div class="breadcrumb"><span>WORKSHOP</span>${icon('chevron',10)}<span id="scene-breadcrumb">8-BIT PROCESSOR</span></div><h1 class="stage-title" id="scene-title">Small parts. A working computer.</h1><div class="stage-subtitle" id="scene-subtitle">Follow the bits. Find out what makes an instruction happen.</div></div>
        <div class="stage-tools"><button class="btn icon-only active" data-action="orbit" aria-label="Orbit view" title="Orbit view">${icon('compass',16)}</button><button class="btn icon-only" data-action="walk" aria-label="Walk mode" title="Walk · WASD, Q/E, drag to look">${icon('walk',16)}</button><button class="btn icon-only" data-action="fit" aria-label="Fit circuit in view" title="Fit circuit · F">${icon('expand',15)}</button></div>
      </div>
      <div class="world-caption"><span class="chip-pill" id="world-view-label">ARCHITECTURE VIEW</span><span id="world-hint">Drag to orbit · scroll to zoom · click a component</span></div>
      <div class="world-legend"><span style="--legend:#80bdf0"><i></i>State</span><span style="--legend:#e9b579"><i></i>Arithmetic</span><span style="--legend:#bc9ae6"><i></i>Control</span><span style="--legend:#90cca2"><i></i>Memory</span></div>
      <div class="build-palette" id="build-palette"></div>
      <div class="transport" aria-label="Simulation controls">
        <button class="btn primary" data-action="run" id="run-button">${icon('play',14)} Run</button>
        <button class="btn" data-action="instruction" id="instruction-button" title="Step one instruction · .">${icon('step',14)} Instruction</button>
        <button class="btn" data-action="clock" title="Step one clock edge · Shift + .">${icon('clock',14)} Clock</button>
        <span class="separator"></span>
        <button class="btn ghost icon-only" data-action="rewind" title="Rewind one clock" aria-label="Rewind one clock">${icon('rewind',15)}</button>
        <button class="btn ghost icon-only" data-action="reset" title="Restore initial state · R" aria-label="Reset execution">${icon('reset',16)}</button>
        <span class="separator"></span>
        <div class="speed-control"><select id="speed" aria-label="Clock speed"><option value="8">8 Hz</option><option value="24">24 Hz</option><option value="120">120 Hz</option><option value="600">600 Hz</option></select></div>
        <div class="cycle-counter"><label>CLOCK</label><strong id="cycle">00000</strong></div>
      </div>
    </section>
    <aside class="inspector" id="inspector" aria-label="Component inspector"></aside>
    <section class="bottom-panel" aria-label="Execution and memory">
      <div class="bottom-tabs"><button class="bottom-tab active" data-panel="trace">${icon('code',13)}<span id="trace-tab-label">EXECUTION</span></button><button class="bottom-tab" data-panel="memory">${icon('memory',13)} MEMORY</button><button class="bottom-tab" data-panel="cache">${icon('chip',13)} CACHE</button><div class="bottom-tools"><span id="panel-status">READY TO RUN</span><button class="btn ghost small" data-action="program">${icon('folder',12)} Load program</button></div></div>
      <div class="panel-content" id="panel-content"></div>
    </section>
  </main>
  <footer class="footer"><span class="footer-live"><span class="dot"></span><span id="footer-engine">Circuit simulation</span></span><span id="footer-design">8-bit · single clock · 256-byte address space</span><div class="footer-right"><span id="footer-status">All systems ready</span><span>Made of small, understandable things.</span></div></footer>
</div><div class="toast" id="toast" role="status" aria-live="polite"></div><input type="file" id="project-file" accept="application/json,.json" hidden>`;

editor = new EditorView({
  doc: RTL_EXAMPLES[0].source,
  extensions: [basicSetup, StreamLanguage.define(verilog), oneDark, EditorView.lineWrapping,
    EditorView.updateListener.of(update => {
      if (update.docChanged && !suppressEditor) {
        state.dirty = editor.state.doc.toString() !== state.compiled?.source;
        $('#editor-dot').textContent = state.dirty ? '●' : '';
        if (state.dirty) compileStatus('Source changed · synthesize to update the circuit.');
        scheduleSave();
      }
    })],
  parent: $('#code-editor'),
});

world = new CircuitWorld($('#world'), {
  onSelect(id) { state.selected = id; renderInspector(); renderTree(); },
  onPlace({type,position}) {
    if (state.mode !== 'build') return;
    try { state.selected = state.builder.add(type,position); rebuildBuilder(); toast('Component placed. Connect its ports to add it to the circuit.'); }
    catch(error) { toast(error.message,true); }
  },
  onConnect(connection) {
    if (state.mode !== 'build') return;
    const previous = state.builder.toJSON();
    try { state.builder.connect(connection); rebuildBuilder(); toast('Ports connected. Execution state reset.'); }
    catch(error) { state.builder = CircuitBuilder.fromJSON(previous); toast(error.message,true); }
  },
});

function toast(message,error=false) {
  clearTimeout(toastTimer); const el=$('#toast');
  el.textContent=message;el.className=`toast show${error?' error':''}`;
  toastTimer=setTimeout(()=>el.classList.remove('show'),error?7000:3600);
}
function compileStatus(message,kind='') { const el=$('#compile-status');el.textContent=message;el.className=`compile-status ${kind}`; }
function setEditor(source) { suppressEditor=true;editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:source}});suppressEditor=false;state.dirty=false;$('#editor-dot').textContent=''; }
function activeSim() { return state.lab?.sim || state.sim; }
function isCpu() { return !!state.lab; }
function stop() { state.running=false;clockBudget=0;updateTransport(); }
function currentCycle() { return activeSim()?.cycle || 0; }

function useCompiled(compiled,{exampleId=state.exampleId,preserveSource=false}={}) {
  const testSim=new CircuitSimulator(compiled.netlist,{top:compiled.top});
  const cpu=['instruction','mem_valid','mem_resp_ready','retired','retire_pc','halted','fault'].every(x=>testSim.module.ports[x]);
  let nextLab=null;
  if(cpu) { nextLab=new CpuLab(compiled.netlist,{latency:state.latency,cache:state.cache});nextLab.loadProgram(state.programSource); }
  stop();state.compiled=compiled;state.exampleId=exampleId;state.lab=nextLab;state.sim=cpu?null:testSim;
  state.genericHistory=[];state.genericTrace=[];state.scope=null;state.selected=cpu?'overview:a':null;
  if(!preserveSource)setEditor(compiled.source || RTL_EXAMPLES.find(x=>x.id===exampleId)?.source || '');
  if(!cpu) resetGeneric(RTL_EXAMPLES.find(x=>x.id===exampleId)?.inputs || {});
  $('#rtl-example').value=exampleId;
  state.view=cpu?'overview':'cells';
  buildScene();renderAll();scheduleSave();
}

async function loadExample(id) {
  stop();
  try {
    const response=await fetch(`${BASE}examples/${id}.json`);
    if(!response.ok)throw new Error('Example fixture could not be loaded.');
    const compiled=await response.json();useCompiled(compiled,{exampleId:id});
    compileStatus('Example loaded · edit Verilog and synthesize your own version.');
  }catch(error){toast(error.message,true);}
}

function resetGeneric(inputValues) {
  const sim=state.sim;if(!sim)return;
  const previous=inputValues || Object.fromEntries(Object.entries(sim.module.ports).filter(([,p])=>p.direction==='input').map(([name])=>[name,sim.getPort(name)]));
  sim.reset();
  for(const [name,value] of Object.entries(previous))if(sim.module.ports[name]?.direction==='input')sim.setInput(name,value);
  sim.settle();
  if(sim.module.ports.reset?.direction==='input'){sim.setInput('reset',1);sim.tick();sim.setInput('reset',previous.reset || 0);sim.cycle=0;sim.settle();}
  state.genericHistory=[];state.genericTrace=[];
}

function rebuildBuilder() {
  const next=new CircuitSimulator(state.builder.getNetlist());
  for(const [name,value] of Object.entries(state.builder.getInputs()))next.setInput(name,value);
  next.settle();stop();state.sim=next;state.lab=null;state.genericHistory=[];state.genericTrace=[];
  buildScene();renderAll();scheduleSave();
}

function buildScene() {
  let graph;
  if(state.mode==='build') graph=state.builder.getDesign();
  else if(state.lab && state.view==='overview') graph=makeCpuOverview(state.compiled);
  else {
    graph=makeNetlistGraph(state.compiled);
    if(state.scope?.length){
      const chosen=new Set(state.scope);
      const visible=new Set(graph.nodes.filter(n=>chosen.has(n.cellId||n.id)).map(n=>n.id));
      for(const edge of graph.edges)if(visible.has(edge.from)||visible.has(edge.to)){visible.add(edge.from);visible.add(edge.to);}
      graph={...graph,nodes:graph.nodes.filter(n=>visible.has(n.id)),edges:graph.edges.filter(e=>visible.has(e.from)&&visible.has(e.to))};
    }
  }
  state.graph=graph;world.setDesign(graph);
  if(state.selected && graph.nodes.some(n=>n.id===state.selected))world.select(state.selected);
  else{state.selected=graph.nodes.find(n=>n.kind==='register')?.id || graph.nodes[0]?.id;world.select(state.selected);}
  updateSceneLabels();updateSignals();
}

function updateSceneLabels() {
  const build=state.mode==='build', cpu=isCpu();
  $('#scene-breadcrumb').textContent=build?'CIRCUIT WORKBENCH':cpu?'8-BIT PROCESSOR':(RTL_EXAMPLES.find(x=>x.id===state.exampleId)?.name || 'CUSTOM CIRCUIT').toUpperCase();
  $('#scene-title').textContent=build?'Make something that computes.':state.mode==='rtl'?'Your code, made tangible.':'Small parts. A working computer.';
  $('#scene-subtitle').textContent=build?'Place components. Connect ports. Watch your wiring compute.':'Follow the bits. Find out what makes an instruction happen.';
  $('#world-view-label').textContent=build?'BLOCK WORKBENCH':state.view==='overview'?'ARCHITECTURE VIEW':state.scope?'IMPLEMENTATION DETAIL':'RTL STRUCTURE';
  $('#world-hint').textContent=build?(state.tool==='wire'?'Click an output port, then an input port.':state.tool?'Click the board to place a component.':'Select a component or choose a tool below.'):'Drag to orbit · scroll to zoom · click a component';
  $('#footer-design').textContent=build?'Your connections drive the simulator':cpu?'8-bit · single clock · 256-byte address space':`${Object.keys(activeSim()?.module.cells||{}).length} cells · single clock · real synthesized RTL`;
  $('#footer-engine').textContent='Live circuit simulation';
}

function updateSignals() {
  const sim=activeSim();if(!sim||!state.graph)return;
  let signals;
  if(state.lab && state.view==='overview' && state.mode!=='build')signals=getCpuOverviewSignals(state.graph,state.lab);
  else signals=getGraphSignals(state.graph,sim);
  world.updateSignals(signals);
}

function step(kind='clock',render=true) {
  const sim=activeSim();if(!sim)return;
  try{
    if(state.lab){
      if(state.lab.halted){stop();return;}
      if(kind==='instruction')state.lab.stepInstruction();else state.lab.stepClock();
      if(state.lab.halted){stop();toast(state.lab.getState().fault?'Processor fault: inspect the opcode and controller.':`Program complete · display ${state.lab.display} · ${state.lab.cycle} clocks`,!!state.lab.getState().fault);}
    }else{
      state.genericHistory.push({sim:sim.snapshot(),traceLength:state.genericTrace.length});if(state.genericHistory.length>512)state.genericHistory.shift();
      sim.tick();state.genericTrace.push({cycle:sim.cycle,outputs:Object.fromEntries(Object.entries(sim.module.ports).filter(([,p])=>p.direction==='output').map(([name])=>[name,sim.getPort(name)]))});if(state.genericTrace.length>512)state.genericTrace.shift();
    }
  }catch(error){stop();toast(error.message,true);}
  if(render)renderLive();
}

function updateTransport() {
  $('#run-button').innerHTML=`${icon(state.running?'pause':'play',14)} ${state.running?'Pause':'Run'}`;
  $('#instruction-button').disabled=!state.lab;
  $('#cycle').textContent=String(currentCycle()).padStart(5,'0');
  $('#panel-status').textContent=state.lab?.pending?`MEMORY ${state.lab.pending.write?'WRITE':'READ'} · WAIT ${state.lab.pending.remaining+1}`:state.lab?.halted?'PROGRAM COMPLETE':state.running?'CLOCK RUNNING':currentCycle()?'PAUSED':'READY TO RUN';
  $('#footer-status').textContent=state.lab?.getState().fault?'Processor fault':state.lab?.halted?`Display: ${state.lab.display}`:state.lab?.pending?'Waiting for memory':state.running?'Simulation running':'All systems ready';
}

function setMode(mode) {
  if(mode===state.mode)return;
  stop();const previous=state.mode;state.mode=mode;
  if(mode==='build')rebuildBuilder();
  else if(previous==='build')useCompiled(state.compiled,{exampleId:state.exampleId,preserveSource:true});
  $('.app-shell').classList.toggle('rtl-mode',mode==='rtl');$('.app-shell').classList.toggle('build-mode',mode==='build');
  document.querySelectorAll('[data-mode]').forEach(el=>el.classList.toggle('active',el.dataset.mode===mode));
  world.setMode(mode==='build'?'build':'orbit');world.setTool(null);state.tool=null;
  buildScene();renderAll();renderPalette();scheduleSave();
  requestAnimationFrame(()=>{world.resize?.();world.resetCamera();});
}

function renderAll(){renderSidebar();renderInspector();renderPanel();updateTransport();updateSceneLabels();renderPalette();}
function renderLive(){updateSignals();updateTransport();renderTree();if(!$('#inspector')?.contains(document.activeElement))renderInspector();if(!$('#panel-content')?.contains(document.activeElement))renderPanel();}

function renderSidebar(){
  const cpu=isCpu(),build=state.mode==='build';
  const example=RTL_EXAMPLES.find(x=>x.id===state.exampleId);
  $('#sidebar').innerHTML=`<div class="side-section"><div class="eyebrow">YOUR WORKSHOP</div><h2 class="side-title">${build?'Circuit workbench':cpu?'The little processor':esc(example?.name || 'Custom circuit')}</h2><p class="side-description">${build?'Small blocks. Real computation. Build a circuit and make every connection count.':cpu?'A whole computer, small enough to understand. Every connection has a purpose.':'Explore the hardware your Verilog describes. Change an input and follow the result.'}</p><div class="project-chip"><span class="project-icon">${icon(build?'blocks':'chip',18)}</span><div><strong>${build?'My first circuit':cpu?'ST-8 / Accumulator CPU':'Synthesized from Verilog'}</strong><small>${build?'Editable · 8-bit buses':cpu?'8-bit data · 16-bit instructions':'Yosys · word-level netlist'}</small></div></div>${!build?`<div class="view-toggle"><button class="btn small ${state.view==='overview'?'active':''}" data-action="overview" ${cpu?'':'disabled'}>Overview</button><button class="btn small ${state.view==='cells'?'active':''}" data-action="cells">Circuit cells</button></div>`:''}</div>
  <div class="side-section"><div class="side-header"><span class="eyebrow">${build?'COMPONENTS':'MACHINE EXPLORER'}</span><span class="count">${state.graph?.nodes.length||0}</span></div><div class="tree" id="machine-tree"></div>${cpu?`<div class="breakpoint-control"><label for="breakpoint">Break at PC</label><input id="breakpoint" placeholder="0x04" value="${state.breakpoint===null?'':`0x${hex(state.breakpoint)}`}" aria-label="Program counter breakpoint" /></div>`:''}</div>
  <div class="learning-card"><div class="learning-icon">${icon('light',19)}<span class="eyebrow" style="color:#91b18d">LEARN BY DOING</span></div><h3>${build?'Make a number stay.':'Where does a number go?'}</h3><p>${build?'Connect an adder to a register. Step the clock, then change an input. The stored value waits for the next edge.':'Run a few instructions. Follow the accumulator into RAM, then load the same value back.'}</p><button class="btn small" data-action="lesson">Open field guide ${icon('arrow',13)}</button></div>
  <div class="sidebar-bottom"><div><span class="kbd">Space</span> run / pause <span class="kbd">.</span> step</div><div style="margin-top:8px">${icon('info',11)} Logical layout · wire length has no delay</div></div>`;
  renderTree();
}
function renderTree(){
  const tree=$('#machine-tree');if(!tree||!state.graph)return;
  const nodes=state.graph.nodes;
  tree.innerHTML=nodes.slice(0,80).map(node=>{const value=nodeValue(node);return `<button class="tree-item ${state.selected===node.id?'active':''}" data-node="${esc(node.id)}"><span class="swatch" style="--swatch:${kindColor(node.kind)}"></span><span>${esc(shortLabel(node.label||node.id,22))}</span><span class="tree-value">${value===undefined?'':hex(value,(node.width||8)>8?4:2)}</span></button>`;}).join('')+(nodes.length>80?`<p class="side-description">${nodes.length-80} more cells in the world.</p>`:'');
}
function kindColor(kind){return ({register:'#90bbed',alu:'#edb877',control:'#bfaae9',memory:'#9bd6a9',input:'#87cfc6',output:'#e9a393'})[kind]||'#92a9ba';}
function shortLabel(label,len){return label.length>len?`${label.slice(0,len-1)}…`:label;}
function nodeValue(node){
  if(!node)return undefined;
  const sim=activeSim();
  try{
    if(node.signalName && sim.module.ports[node.signalName])return sim.getPort(node.signalName);
    if(node.id==='ram' || node.id==='memory')return state.lab?.ram[state.memoryAddress];
    if(node.id==='display')return state.lab?.display;
    if(node.inputName)return sim.getPort(node.inputName);
    if(node.outputName)return sim.getPort(node.outputName);
    if(node.bits)return sim.getBits(node.bits);
    const id=node.cellId||node.id;
    if(sim.module.cells[id]){const cell=sim.module.cells[id];const out=Object.keys(cell.port_directions).find(p=>cell.port_directions[p]==='output');return sim.getCellPorts(id)[out];}
    if(sim.module.ports[node.id])return sim.getPort(node.id);
    const signals=getCpuOverviewSignals(state.graph,state.lab);const value=signals.nodeValues[node.id];return typeof value==='object'&&value?value.value:value;
  }catch{return undefined;}
}

function renderInspector(){
  const node=state.graph?.nodes.find(n=>n.id===state.selected),cpu=state.lab?.getState(),sim=activeSim();
  if(!node||!sim){$('#inspector').innerHTML='<div class="empty-state">Select a component in the world to inspect its live values and connections.</div>';return;}
  const width=Math.min(node.width||8,32),value=nodeValue(node),bits=value==null?'X'.repeat(Math.min(width,16)):Number(value).toString(2).padStart(width,'0').slice(-16);
  const inputName=node.inputName || (sim.module.ports[node.id]?.direction==='input'?node.id:null);
  let ports=[];
  const cell=sim.module.cells[node.cellId||node.id];
  if(cell)ports=Object.entries(sim.getCellPorts(node.cellId||node.id)).map(([name,val])=>({name,value:val,width:cell.connections[name].length}));
  else if(node.ports)ports=node.ports.map(p=>({name:p.name,value:p.name==='Q'||p.direction==='output'?value:undefined,width:p.width}));
  const source=String(node.source||cell?.attributes?.src||'');
  const description=node.description || (node.kind==='register'?'Captures its input at the active clock edge and holds the value between edges.':node.kind==='alu'?'Transforms its current inputs. Inspect the output before capturing it in a register.':node.kind==='memory'?'Addressed storage. Values change only when a write commits.':'Part of the live circuit. Its value follows its inputs and connections.');
  $('#inspector').innerHTML=`<div class="inspector-top"><div class="inspector-heading"><h2>Component inspector</h2><span class="status-badge ${cpu?.halted?'halted':''}">${cpu?.halted?'HALTED':state.running?'RUNNING':'LIVE'}</span></div></div>
    <div class="selected-card"><div class="selected-icon" style="color:${kindColor(node.kind)}">${icon(node.kind==='memory'?'memory':node.kind==='alu'?'plus':node.kind==='output'?'light':'chip',22)}</div><h3 class="selected-name">${esc(shortLabel(node.label||node.id,30))}</h3><div class="selected-type">${esc(node.type||node.kind||'circuit component')} · ${width}-bit</div>
    <div class="value-display"><div class="value-heading"><span>CURRENT VALUE</span><span>${width} BITS</span></div><div class="big-value"><strong>${value===undefined?'—':value===null?'X':value}</strong><span>${value==null?'unknown':`0x${hex(value,Math.ceil(width/4))}`}</span></div><div class="bit-row">${[...bits].map(b=>`<span class="bit ${b==='1'?'on':b==='X'?'unknown':''}">${b}</span>`).join('')}</div></div>
    <div class="details"><div class="detail-row"><span>Kind</span><span>${esc(node.kind||'logic')}</span></div><div class="detail-row"><span>State changes</span><span>${node.kind==='register'?'Clock edge':'Input / service'}</span></div>${source?`<div class="detail-row"><span>Source</span><span title="${esc(source)}">${esc(source.split('|')[0])}</span></div>`:''}</div><p class="side-description" style="margin-top:15px">${esc(description)}</p>
    <div style="display:flex;gap:6px;margin-top:14px"><button class="btn small" data-action="focus">${icon('target',12)} Focus</button>${state.mode==='build'?`<button class="btn small danger" data-action="delete">${icon('trash',12)} Remove</button>`:`<button class="btn small" data-action="source">${icon('code',12)} View RTL</button>`}</div>${node.cellIds?.length?`<button class="btn small" data-action="expand-node" style="width:100%;margin-top:7px">${icon('blocks',12)} Explore ${node.cellIds.length} implementing cells</button>`:''}</div>
    ${inputName?`<div class="inspector-section"><div class="eyebrow">DRIVE THIS INPUT</div><div class="port-row"><span>${esc(inputName)}</span><input data-input="${esc(inputName)}" data-builder-input="${state.mode==='build'?esc(node.id):''}" type="number" min="0" max="${2**width-1}" value="${sim.getPort(inputName)??''}" placeholder="X" aria-label="Value of ${esc(inputName)}" /></div></div>`:''}
    ${cpu?`<div class="inspector-section"><div class="eyebrow">PROCESSOR STATE</div><div class="registers"><div class="register"><label>ACCUMULATOR A</label><strong>${cpu.a??'X'}</strong><small>0x${hex(cpu.a)}</small></div><div class="register"><label>PROGRAM COUNTER</label><strong>${hex(cpu.pc)}</strong><small>instruction address</small></div><div class="register"><label>ZERO / CARRY</label><strong>${cpu.z} / ${cpu.c}</strong><small>condition flags</small></div><div class="register"><label>OUTPUT DISPLAY</label><strong>${cpu.display}</strong><small>mapped at 0xFE</small></div></div></div><div class="inspector-section"><div class="eyebrow">${phases[cpu.state]||'CONTROLLER'}</div><div class="instruction-card"><code>${esc(disassemble(cpu.ir))}</code><p>${cpu.pending?`A ${cpu.pending.write?'write':'read'} at 0x${hex(cpu.pending.address)} is pending. ${cpu.pending.remaining+1} clock${cpu.pending.remaining?'s':''} until completion.`:'Select Instruction to advance through every microstep of the current operation.'}</p></div><div class="port-row" style="margin-top:12px"><span>Input port 0xFF</span><input id="cpu-input" type="number" min="0" max="255" value="${state.lab.input}" aria-label="Memory mapped input byte" /></div></div>`:`<div class="inspector-section"><div class="eyebrow">COMPONENT PORTS</div><div class="port-list">${ports.map(p=>`<div class="port-row"><span>${esc(p.name)} [${p.width}]</span><span class="port-value">${p.value===undefined?'—':p.value===null?'X':`0x${hex(p.value)}`}</span></div>`).join('')||'<p class="side-description">Select an input to change its value.</p>'}</div></div>`}
    ${state.mode==='build'?`<div class="inspector-section">${(node.ports||[]).filter(p=>p.direction==='input').map(p=>`<div class="port-row"><span>${esc(p.name)} [${p.width}]</span><button class="btn ghost small" style="margin-left:auto" data-action="disconnect" data-port="${esc(p.name)}" ${state.builder.edges.some(e=>e.to===node.id&&e.toPort===p.name)?'':'disabled'}>Disconnect</button></div>`).join('')}<button class="btn small" data-action="export-rtl" style="width:100%">${icon('code',12)} Open this circuit as Verilog</button><p class="side-description" style="margin-top:10px">Changing connections restarts execution. Unconnected inputs remain unknown.</p></div>`:''}`;
}

function renderPanel(){
  const panel=$('#panel-content'),lab=state.lab;
  document.querySelectorAll('[data-panel]').forEach(el=>el.classList.toggle('active',el.dataset.panel===state.panel));
  $('#trace-tab-label').textContent=lab?'EXECUTION':'LIVE I/O';
  if(!lab){renderGenericPanel(panel);return;}
  if(state.panel==='memory'){renderMemory(panel);return;}
  if(state.panel==='cache'){renderCache(panel);return;}
  const rows=lab.trace.slice(-60).reverse();
  panel.innerHTML=rows.length?`<table class="trace-table"><colgroup><col style="width:13%"><col style="width:12%"><col style="width:29%"><col style="width:15%"><col style="width:31%"></colgroup><thead><tr><th>CLOCK</th><th>PC</th><th>INSTRUCTION</th><th>A</th><th>MEMORY / EFFECT</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${String(row.cycle).padStart(4,'0')}</td><td>0x${hex(row.pc)}</td><td class="instruction">${esc(row.instruction)}</td><td>${row.a??'X'}</td><td class="${row.memory?'changed':''}">${row.memory?`${row.memory.type.toUpperCase()} [${hex(row.memory.address)}] ${row.memory.type==='write'?'←':'→'} ${row.memory.value}`:row.instruction==='HALT'?'Program complete':`PC → ${hex(row.nextPc)}`}</td></tr>`).join('')}</tbody></table>`:`<div class="trace-empty">${icon('code',25)}<div><strong>Your first instruction is waiting.</strong>Press Instruction to follow one operation, or Run to start the clock.</div></div>`;
}
function renderMemory(panel){
  const lab=state.lab,selected=state.memoryAddress,last=lab.events.filter(e=>e.type==='write'&&e.address===selected).at(-1),reads=lab.events.filter(e=>e.type==='read'&&e.address===selected).length;
  const written=new Set(lab.events.filter(e=>e.type==='write').map(e=>e.address));
  let grid='<span></span>'+Array.from({length:16},(_,i)=>`<span class="memory-col">${hex(i,1)}</span>`).join('');
  for(let row=0;row<16;row++){
    grid+=`<span class="memory-row-label">${hex(row*16)}</span>`;
    for(let col=0;col<16;col++){const address=row*16+col;grid+=`<button class="memory-cell ${written.has(address)?'changed':''} ${address===selected?'selected':''}" data-address="${address}" title="Address 0x${hex(address)} · ${lab.ram[address]}" aria-label="Memory address 0x${hex(address)}, value ${lab.ram[address]}">${hex(lab.ram[address])}</button>`;}
  }
  panel.innerHTML=`<div class="memory-wrap"><div class="memory-grid">${grid}</div><div class="memory-detail"><span class="eyebrow">ADDRESS 0x${hex(selected)}</span><strong>${lab.ram[selected]} <span class="muted" style="font-size:10px">/ 0x${hex(lab.ram[selected])}</span></strong><code>${lab.ram[selected].toString(2).padStart(8,'0')}</code><p>${selected===0xFE?'Numeric output device. Writes update the display.':selected===0xFF?'Input device. Reads return the configured input byte.':last?`Written at clock ${last.cycle}.<br>Previous writes: ${lab.events.filter(e=>e.type==='write'&&e.address===selected).length-1}.`:'Initial zero value. No committed writes yet.'}</p><span>${reads} completed read${reads===1?'':'s'} · values persist until overwritten or reset.</span><button class="btn small" data-action="watch-memory" style="margin-top:12px">${icon('target',12)} ${state.watchAddress===selected?'Watching writes':'Watch writes here'}</button></div></div>`;
}
function renderCache(panel){
  const lab=state.lab,s=lab.cacheStats;
  panel.innerHTML=`<div class="cache-settings"><label><input type="checkbox" id="cache-enabled" ${state.cache?'checked':''} /> Enable simulated cache</label><label>RAM latency <input type="number" id="ram-latency" min="1" max="100" value="${state.latency}" /> clocks</label><span class="cache-stats">${s.hits} hits · ${s.misses} misses · ${s.reads} reads</span></div><table class="cache-table"><thead><tr><th>INDEX</th><th>VALID</th><th>TAG</th><th>DATA · FOUR BYTES</th></tr></thead><tbody>${lab.cacheLines.map((line,i)=>`<tr><td>${i.toString(2).padStart(2,'0')}</td><td>${line.valid?'1':'0'}</td><td>${line.valid?hex(line.tag,1):'—'}</td><td>${[...line.data].map(v=>hex(v)).join(' &nbsp; ')}</td></tr>`).join('')}</tbody></table><div class="empty-state" style="padding:9px 16px;font-size:9px">4 lines × 4 bytes · tag[7:4], index[3:2], offset[1:0] · write-through / no write allocation · I/O bypasses cache. Changing settings restarts the program.</div>`;
}
function renderGenericPanel(panel){
  const sim=activeSim();if(!sim)return;
  if(state.panel==='cache'||state.panel==='memory'){panel.innerHTML='<div class="empty-state">Memory and cache inspection are available when a circuit exposes the processor memory interface. This circuit can be explored through its live inputs and outputs.</div>';return;}
  const ports=Object.entries(sim.module.ports);
  panel.innerHTML=`<div class="generic-io">${ports.filter(([n,p])=>p.direction==='input'&&n!==sim.clockInput&&!(state.mode==='build'&&n==='clk')).map(([name,p])=>`<div class="io-card"><label>IN · ${esc(name)} [${p.bits.length}]</label><input type="number" data-input="${esc(name)}" data-builder-input="${state.mode==='build'?esc(name):''}" min="0" max="${2**p.bits.length-1}" value="${sim.getPort(name)??''}" placeholder="X" aria-label="Input ${esc(name)}" /></div>`).join('')}${ports.filter(([,p])=>p.direction==='output').map(([name,p])=>`<div class="io-card"><label>OUT · ${esc(name)} [${p.bits.length}]</label><strong data-output="${esc(name)}">${sim.getPort(name)??'X'}</strong></div>`).join('')}</div>${state.genericTrace.length?`<table class="trace-table"><thead><tr><th style="width:15%">CLOCK</th><th>OUTPUTS AFTER EDGE</th></tr></thead><tbody>${state.genericTrace.slice(-12).reverse().map(row=>`<tr><td>${row.cycle}</td><td class="changed">${esc(Object.entries(row.outputs).map(([k,v])=>`${k}=${v??'X'}`).join(' · '))}</td></tr>`).join('')}</tbody></table>`:'<div class="empty-state" style="padding-top:0;font-size:10px">Change an input to evaluate combinational logic. Step Clock to capture register state.</div>'}`;
}
function renderPalette(){
  $('#build-palette').innerHTML=Object.entries(BUILDER_TYPES).map(([type,meta])=>`<button class="palette-item ${state.tool===type?'active':''}" data-tool="${type}" title="Place ${esc(meta.label||type)}">${type==='add'?'+':type==='register'?'REG':type==='switch'?'1b':esc((meta.label||type).toUpperCase().slice(0,5))}</button>`).join('')+`<button class="palette-item ${state.tool==='wire'?'active':''}" data-tool="wire" title="Connect output to input">${icon('wire',13)}</button><span class="build-help">Select tool → click board</span>`;
}

function showModal(title,body,actions=''){
  $('.modal-backdrop')?.remove();const backdrop=document.createElement('div');backdrop.className='modal-backdrop';backdrop.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="btn ghost icon-only" data-action="close-modal" aria-label="Close dialog">${icon('close',18)}</button></div>${body}${actions?`<div class="modal-actions">${actions}</div>`:''}</div>`;
  document.body.appendChild(backdrop);backdrop.addEventListener('click',event=>{if(event.target===backdrop)closeModal();});backdrop.querySelector('button,input,select,textarea')?.focus();
}
function closeModal(){$('.modal-backdrop')?.remove();}
function showProgram(){
  if(!state.lab){toast('Open the processor example to load an instruction program.');return;}
  stop();showModal('Load a program',`<p>Assembly is loaded into instruction ROM. Your synthesized processor executes it through its own datapath and controller.</p><select id="program-example" aria-label="Example program"><option value="custom">Current program</option>${PROGRAMS.map(p=>`<option value="${p.id}">${esc(p.name)} — ${esc(p.description)}</option>`).join('')}</select><textarea id="assembly-source" spellcheck="false" aria-label="Assembly program" style="margin-top:14px">${esc(state.programSource)}</textarea><p style="font-size:10px">Instructions: NOP, LDI, LOAD, STORE, ADD, ADDI, SUBI, JMP, JZ, JNZ, HALT. Byte 0xFE is the display; 0xFF is the input device.</p>`,`<button class="btn" data-action="check-program">Check syntax</button><button class="btn primary" data-action="load-program">${icon('play',13)} Load and reset</button>`);
}
function showLesson(){
  stop();showModal('Field guide · a number that stays',`<p>A wire shows a current value. A register captures a value at a clock edge. RAM keeps a value at an address across instructions.</p><ol class="lesson-steps"><li>Load <strong>Save 7 + 5</strong> and select the accumulator in the world.</li><li>Step instructions. Watch <code>LDI 7</code> capture 7, then <code>ADDI 5</code> capture 12.</li><li>Step through <code>STORE 0x40</code> with Clock. The memory request waits before its write commits.</li><li>Open Memory and select address <code>0x40</code>. Its value is <strong>0C</strong> in hexadecimal, or 12 in decimal.</li><li>Try <strong>Sum 1 through 10</strong>. Branches repeat the circuit's work until the result is 55.</li></ol><h3>From blocks to RTL</h3><p>In Build, connect the adder to a register. In RTL studio, explore the enabled accumulator example. Both use the same circuit simulator.</p><h3>Explore the implementation</h3><p>Choose Circuit cells to inspect the synthesized logic. The architecture view groups hardware by function; its layout is an educational arrangement. Wire length does not create delay.</p>`,`<button class="btn" data-action="validate">${icon('check',13)} Test processor</button><button class="btn primary" data-action="program">Load a program ${icon('arrow',13)}</button>`);
}

async function synthesize(){
  if(state.compiling)return;stop();const source=editor.state.doc.toString();state.compiling=true;
  $('#compile-button').disabled=true;compileStatus('Loading local Yosys compiler… the first run downloads the toolchain.','busy');
  try{
    const compiled=await compileVerilog(source,{top:'top',onProgress:progress=>compileStatus(typeof progress==='string'?progress:progress.message||'Synthesizing locally…','busy')});
    useCompiled(compiled,{exampleId:RTL_EXAMPLES.find(x=>x.source===source)?.id||'custom',preserveSource:true});
    state.dirty=editor.state.doc.toString()!==source;$('#editor-dot').textContent=state.dirty?'●':'';
    compileStatus(state.dirty?'Compiled captured source · editor has newer changes.':`Synthesis complete · ${Object.keys(activeSim().module.cells).length} cells · click a component to inspect.`);
    toast('Your Verilog is now the circuit running in the world.');
  }catch(error){compileStatus(error.message,'error');toast('Synthesis failed. The previous circuit is still available.',true);}
  finally{state.compiling=false;$('#compile-button').disabled=false;scheduleSave();}
}

async function validateCpu(){
  if(!state.compiled)return;stop();showModal('Processor checks','<p id="validation-results">Running real programs through the synthesized circuit…</p>');
  await new Promise(resolve=>setTimeout(resolve,40));
  const expected={sum:12,loop:55,cache:12,input:43};
  const results=[];
  for(const program of PROGRAMS){
    try{
      const lab=new CpuLab(state.compiled.netlist,{latency:state.latency,cache:state.cache});lab.input=42;lab.loadProgram(program.source);
      for(let i=0;i<1200&&!lab.halted;i++)lab.stepInstruction();
      if(!lab.halted||lab.getState().fault||lab.display!==expected[program.id])throw new Error(`Expected display ${expected[program.id]}, received ${lab.display}${lab.halted?'':' (did not halt)'}`);
      results.push(`<p style="color:#b3e4bd">${icon('check',14)} ${esc(program.name)} · display ${lab.display} · ${lab.cycle} clocks</p>`);
    }catch(error){results.push(`<p style="color:#edb0a3">${icon('warning',14)} ${esc(program.name)} · ${esc(error.message)}</p>`);}
  }
  const target=$('#validation-results');if(target)target.outerHTML=results.join('')+'<p>Your current execution was preserved. Automated repository tests additionally compare every retired instruction against an independent reference.</p>';
}

function projectData(){
  return {format:'silicon-trails',version:1,name:'Silicon Trails workshop',mode:state.mode,view:state.view,exampleId:state.exampleId,source:editor.state.doc.toString(),compiled:state.compiled,program:state.programSource,programName:state.programName,builder:state.builder.toJSON(),config:{cache:state.cache,latency:state.latency,breakpoint:state.breakpoint,watchAddress:state.watchAddress}};
}
function scheduleSave(){
  clearTimeout(saveTimer);$('#save-label').textContent='Saving…';
  saveTimer=setTimeout(()=>{try{localStorage.setItem(STORAGE,JSON.stringify(projectData()));$('#save-label').textContent='Saved locally';}catch{$('#save-label').textContent='Use Save project';}},400);
}
function downloadProject(){const url=URL.createObjectURL(new Blob([JSON.stringify(projectData(),null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='silicon-trails-workshop.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Project saved: source, circuit, build, and settings. Execution restarts on restore.');}
function restoreProject(data){
  if(data?.format!=='silicon-trails'||data.version!==1)throw new Error('This is not a supported Silicon Trails project.');
  if(typeof data.source!=='string'||data.source.length>131072)throw new Error('Project source is missing or too large.');
  if(typeof data.program!=='string')throw new Error('Project program is missing.');assemble(data.program);
  const builder=CircuitBuilder.fromJSON(data.builder);new CircuitSimulator(builder.getNetlist());
  if(!data.compiled?.netlist)throw new Error('Project compiled circuit is missing.');new CircuitSimulator(data.compiled.netlist);
  state.mode='explore';$('.app-shell').classList.remove('rtl-mode','build-mode');document.querySelectorAll('[data-mode]').forEach(el=>el.classList.toggle('active',el.dataset.mode==='explore'));world.setMode('orbit');world.setTool(null);state.tool=null;
  state.builder=builder;state.cache=!!data.config?.cache;state.latency=Math.max(1,Math.min(100,Number(data.config?.latency)||3));state.breakpoint=Number.isInteger(data.config?.breakpoint)?data.config.breakpoint:null;state.watchAddress=Number.isInteger(data.config?.watchAddress)?data.config.watchAddress:null;
  state.programSource=data.program;state.programName=data.programName||'My program';
  useCompiled(data.compiled,{exampleId:data.exampleId||'cpu'});setEditor(data.source);state.dirty=data.source!==data.compiled.source;$('#editor-dot').textContent=state.dirty?'●':'';
  const mode=['explore','build','rtl'].includes(data.mode)?data.mode:'explore';
  if(mode!==state.mode)setMode(mode);else if(mode==='build')rebuildBuilder();
  if(data.view==='cells'&&mode!=='build'){state.view='cells';buildScene();renderAll();}
}

function setInput(name,value,builderId){
  stop();const sim=activeSim();if(value!==null&&!Number.isInteger(value))throw new Error('Enter a whole unsigned number, or leave blank for unknown.');
  sim.setInput(name,value);sim.settle();if(builderId)state.builder.setInput(builderId,value);
  renderLive();scheduleSave();
}

// All dynamic controls share these handlers, keeping state updates predictable.
document.addEventListener('click',event=>{
  const mode=event.target.closest('[data-mode]');if(mode){setMode(mode.dataset.mode);return;}
  const selected=event.target.closest('[data-node]');if(selected){state.selected=selected.dataset.node;world.select(state.selected);world.focus(state.selected);renderTree();renderInspector();return;}
  const tab=event.target.closest('[data-panel]');if(tab){state.panel=tab.dataset.panel;renderPanel();return;}
  const memory=event.target.closest('[data-address]');if(memory){state.memoryAddress=Number(memory.dataset.address);renderPanel();if(['ram','memory','overview:ram'].includes(state.selected))renderInspector();return;}
  const tool=event.target.closest('[data-tool]');if(tool){world.setMode('build');state.tool=state.tool===tool.dataset.tool?null:tool.dataset.tool;world.setTool(state.tool);renderPalette();updateSceneLabels();return;}
  const action=event.target.closest('[data-action]')?.dataset.action;if(!action)return;
  try{
    switch(action){
      case 'run': if(state.lab?.halted){state.lab.reset();renderLive();}state.running=!state.running;state.breakpointSkipCycle=currentCycle();lastFrame=performance.now();clockBudget=0;updateTransport();break;
      case 'instruction':stop();step('instruction');break;
      case 'clock':stop();step();break;
      case 'reset':stop();if(state.lab)state.lab.reset();else resetGeneric();renderLive();toast('Initial execution state restored.');break;
      case 'rewind':stop();if(state.lab)state.lab.rewind();else{const s=state.genericHistory.pop();if(s){state.sim.restore(s.sim);state.genericTrace.length=s.traceLength;}}renderLive();break;
      case 'fit':world.resetCamera();break;
      case 'focus':world.focus(state.selected);break;
      case 'orbit':world.setMode(state.mode==='build'?'build':'orbit');document.querySelectorAll('.stage-tools .active').forEach(e=>e.classList.remove('active'));event.target.closest('button').classList.add('active');break;
      case 'walk':world.setMode('walk');document.querySelectorAll('.stage-tools .active').forEach(e=>e.classList.remove('active'));event.target.closest('button').classList.add('active');toast('Walk: WASD to move, Q/E down/up, drag to look.');break;
      case 'overview':state.view='overview';state.scope=null;state.selected='overview:a';buildScene();renderAll();scheduleSave();break;
      case 'cells':state.view='cells';state.scope=null;buildScene();renderAll();scheduleSave();break;
      case 'expand-node':{const node=state.graph.nodes.find(n=>n.id===state.selected);state.scope=node?.cellIds;state.view='cells';buildScene();renderAll();break;}
      case 'source':{const node=state.graph.nodes.find(n=>n.id===state.selected);const source=String(node?.source||'');setMode('rtl');const m=source.match(/:(\d+)(?:\.\d+)?/);if(m){const line=editor.state.doc.line(Math.min(Number(m[1]),editor.state.doc.lines));editor.dispatch({selection:{anchor:line.from},effects:EditorView.scrollIntoView(line.from,{y:'center'})});editor.focus();}break;}
      case 'compile':synthesize();break;
      case 'lesson':showLesson();break;
      case 'program':closeModal();showProgram();break;
      case 'close-modal':closeModal();break;
      case 'check-program':{const p=assemble($('#assembly-source').value);toast(`Valid program · ${p.words.length} instructions.`);break;}
      case 'load-program':{const source=$('#assembly-source').value;state.lab.loadProgram(source);state.programSource=source;state.programName=PROGRAMS.find(x=>x.id===$('#program-example').value)?.name||'My program';closeModal();renderLive();scheduleSave();toast('Program loaded. The processor is ready.');break;}
      case 'validate':validateCpu();break;
      case 'watch-memory':state.watchAddress=state.watchAddress===state.memoryAddress?null:state.memoryAddress;renderPanel();toast(state.watchAddress===null?'Memory watchpoint cleared.':`Run will pause when address 0x${hex(state.watchAddress)} is written.`);scheduleSave();break;
      case 'disconnect':{const port=event.target.closest('button').dataset.port;state.builder.disconnectInput(state.selected,port);rebuildBuilder();toast(`${port} disconnected. Its input is now unknown.`);break;}
      case 'export':downloadProject();break;
      case 'import':$('#project-file').click();break;
      case 'delete':if(state.mode==='build'&&state.selected){state.builder.remove(state.selected);state.selected=null;rebuildBuilder();toast('Component removed.');}break;
      case 'export-rtl':{const source=state.builder.toVerilog();setMode('rtl');setEditor(source);state.dirty=true;$('#editor-dot').textContent='●';compileStatus('Exported block circuit · synthesize to explore its RTL implementation.');toast('Structural Verilog generated from your actual connections.');break;}
    }
  }catch(error){toast(error.message,true);}
});
document.addEventListener('change',event=>{
  const el=event.target;
  try{
    if(el.matches('[data-input]'))setInput(el.dataset.input,el.value.trim()===''?null:Number(el.value),el.dataset.builderInput);
    else if(el.id==='cpu-input'){const value=Number(el.value);if(!Number.isInteger(value)||value<0||value>255)throw new Error('Input byte must be between 0 and 255.');state.lab.input=value;}
    else if(el.id==='rtl-example'&&el.value!=='custom')loadExample(el.value);
    else if(el.id==='program-example'){const p=PROGRAMS.find(p=>p.id===el.value);if(p)$('#assembly-source').value=p.source;}
    else if(el.id==='speed'){state.speed=Number(el.value);}
    else if(el.id==='breakpoint'){const value=el.value.trim()===''?null:Number(el.value);if(value!==null&&(!Number.isInteger(value)||value<0||value>255))throw new Error('Breakpoint must be a byte address such as 0x04.');state.breakpoint=value;toast(value===null?'Breakpoint cleared.':`Will pause before instruction 0x${hex(value)}.`);scheduleSave();}
    else if(el.id==='cache-enabled'||el.id==='ram-latency'){const cache=$('#cache-enabled').checked,latency=Number($('#ram-latency').value);if(!Number.isInteger(latency)||latency<1||latency>100)throw new Error('RAM latency must be between 1 and 100 clocks.');stop();state.cache=cache;state.latency=latency;state.lab.cache=cache;state.lab.latency=latency;state.lab.reset();renderLive();scheduleSave();toast('Memory settings applied. Program restarted.');}
  }catch(error){toast(error.message,true);}
});
$('#project-file').addEventListener('change',async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>8*1024*1024)throw new Error('Project files must be smaller than 8 MB.');restoreProject(JSON.parse(await file.text()));toast('Project restored at its initial execution state.');}catch(error){toast(error.message,true);}event.target.value='';});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){closeModal();world.setTool(null);state.tool=null;renderPalette();return;}
  if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&state.mode==='rtl'){event.preventDefault();synthesize();return;}
  if(event.target.closest('input,textarea,select,.cm-editor,[contenteditable=true]')||$('.modal-backdrop'))return;
  if(event.code==='Space'){event.preventDefault();$('[data-action=run]').click();}
  if(event.code==='Period'){event.preventDefault();$(`[data-action=${event.shiftKey||!state.lab?'clock':'instruction'}]`).click();}
  if(event.code==='KeyR')$('[data-action=reset]').click();
  if(event.code==='KeyF')world.resetCamera();
});

function animate(now){
  const elapsed=Math.min((now-lastFrame)/1000,.12);lastFrame=now;
  if(state.running){
    clockBudget+=elapsed*state.speed;let count=0;
    while(clockBudget>=1&&state.running&&count<100){
      if(state.lab&&state.breakpoint!==null&&state.lab.getState().state===0&&state.lab.getState().pc===state.breakpoint&&state.lab.cycle>0&&state.lab.cycle!==state.breakpointSkipCycle){stop();toast(`Breakpoint reached at instruction 0x${hex(state.breakpoint)}.`);break;}
      step('clock',false);clockBudget--;count++;
      const event=state.lab?.events.at(-1);if(state.watchAddress!==null&&event?.type==='write'&&event.address===state.watchAddress&&event.cycle===currentCycle()){stop();toast(`Watchpoint: RAM[0x${hex(event.address)}] saved ${event.value}.`);}
      if(currentCycle()>20000){stop();toast('Paused after 20,000 clocks. Inspect the circuit or reset to run again.');}
    }
    if(count)renderLive();
  }
  requestAnimationFrame(animate);
}

async function boot(){
  try{
    const response=await fetch(`${BASE}examples/cpu.json`);if(!response.ok)throw new Error('The processor fixture is unavailable. Run npm run generate:examples.');
    useCompiled(await response.json(),{exampleId:'cpu'});
    try{const saved=localStorage.getItem(STORAGE);if(saved)restoreProject(JSON.parse(saved));}catch(error){console.warn('Could not restore saved project:',error.message);}
    renderAll();requestAnimationFrame(animate);
    window.siliconTrails={getState:()=>state.lab?.getState()||{cycle:currentCycle()},getLab:()=>state.lab,getSimulator:()=>activeSim(),getBuilder:()=>state.builder,getCompiled:()=>state.compiled,getGraph:()=>state.graph,getWorld:()=>world,setMode,step,loadExample,exportProject:projectData,restoreProject};
  }catch(error){$('#panel-content').innerHTML=`<div class="error-panel">${esc(error.message)}</div>`;toast(error.message,true);}
}
boot();
