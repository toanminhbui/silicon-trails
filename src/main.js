import './styles.css';
import { CircuitWorld } from './world/world.js';
import { CircuitSimulator } from './core/simulator.js';
import { CpuLab } from './core/cpu-lab.js';
import { PROGRAMS, assemble, disassemble } from './core/assembler.js';
import { RTL_EXAMPLES } from './rtl/examples.js';
import { compileVerilog } from './rtl/compiler.js';
import { makeNetlistGraph, getGraphSignals } from './ui/circuit-graph.js';
import { CircuitBuilder, BUILDER_TYPES } from './ui/builder.js';
import { makeCpuOverview, getCpuOverviewSignals } from './ui/cpu-overview.js';
import { Tutorial } from './game/tutorial.js';
import { captureExecution, restoreExecution } from './game/snapshot.js';
import { OoOLab, OOO_PROGRAMS } from './core/ooo-lab.js';
import { makeOooOverview, getOooOverviewSignals } from './ui/ooo-overview.js';
import { renderArchitecture } from './ui/architecture-panel.js';
import { moduleCards, moduleAuthoring, moduleBoundaryFields } from './ui/module-workbench.js';
import { icon, escapeHtml as esc, hex } from './ui/icons.js';

const BASE=import.meta.env.BASE_URL;
const STORAGE='silicon-trails-project-v1';
const $=selector=>document.querySelector(selector);
const phaseNames=['FETCH','EXECUTE','REQUEST','WAIT','HALTED'];
const state={
  screen:'start',workbench:null,mode:'explore',view:'overview',ready:false,hasSave:false,
  compiled:null,defaultCompiled:null,exampleId:'cpu',source:RTL_EXAMPLES[0].source,
  lab:null,sim:null,builder:new CircuitBuilder(),graph:null,scope:null,selected:'overview:a',
  panel:'trace',memoryAddress:0x40,running:false,resumeRunning:false,speed:8,
  cache:false,latency:3,breakpoint:null,watchAddress:null,tool:null,
  programSource:PROGRAMS[0].source,programName:PROGRAMS[0].name,
  genericHistory:[],genericTrace:[],dirty:false,compiling:false,guided:false,
  target:null,eventCursor:0,ignoreEscapeUntil:0,builderSource:null,builderSignature:null,
  ooo:null,builderPath:[],builderTrail:[],
};
let world,editor,EditorViewClass,editorPromise,suppressEditor=false,toastTimer,saveTimer,moduleDraft=null;
let lastFrame=0,clockBudget=0,lastHud=0,lastGuideKey='',lastPlayerSave=0,lastExecutionSave=0;

$('#app').innerHTML=`<main id="game" class="game-shell" data-screen="start">
  <div id="world" class="world-container"></div>
  <section id="start-screen" class="start-screen" aria-label="Silicon Trails title screen">
    <div class="title-vignette"></div><div class="title-sunline">EXPLORE THE MACHINE FROM THE INSIDE</div>
    <div class="title-content"><div class="title-icon">${icon('cube',40)}</div><h1 class="game-logo"><span>SILICON</span><span>TRAILS</span></h1><span class="title-splash">Build it. Understand it.</span>
      <p class="title-description">Fly through a processor. Follow a value.<br>Build the logic that makes it work.</p>
      <div class="title-buttons"><button class="game-button gold" data-action="start-guided" disabled>Start guided journey ${icon('arrow',18)}</button><button class="game-button stone" data-action="start-ooo" disabled>Out-of-order architecture lab</button><button class="game-button stone" data-action="start-free" disabled>Explore freely</button><button class="game-button stone" id="continue-button" data-action="continue" hidden>Continue world</button></div>
      <div class="title-small-actions"><button data-action="import">Load a world</button><span>◆</span><button data-action="controls">How to play</button></div>
    </div>
    <div class="title-corner"><span class="pixel-square"></span> LAB 01 <span class="title-corner-line">THE PROCESSOR ATLAS</span></div>
    <div class="title-footer"><span id="title-status">Connecting the circuit…</span><a href="https://github.com/toanminhbui/silicon-trails" target="_blank" rel="noopener">Explore the source ${icon('external',11)}</a><span>v0.4 · browser edition</span></div>
  </section>
  <section id="game-hud" class="game-hud" aria-label="Game heads-up display" hidden>
    <div class="location-plaque"><div class="plaque-icon">${icon('compass',22)}</div><div><strong>THE PROCESSOR ATLAS</strong><span id="location-subtitle">ST-8 PROCESSOR · EXPLORATION</span></div></div>
    <div class="world-coordinates" id="coordinates">X 0 · Z 23</div>
    <div class="top-right-hud"><div class="output-plaque"><span>OUTPUT</span><strong id="hud-output">0</strong></div><button class="pause-button" data-action="pause" aria-label="Pause game" title="Pause · Esc">${icon('pause',22)}<small>ESC</small></button></div>
    <aside id="tutorial-card" class="tutorial-card" aria-label="Guided tutorial" hidden></aside>
    <div id="crosshair" class="crosshair" aria-hidden="true"><i></i><i></i></div>
    <div class="target-prompt" id="target-prompt" hidden><strong id="target-name"></strong><span><kbd>E</kbd> inspect</span></div>
    <div class="walking-help"><div><kbd>W A S D</kbd> fly <kbd>SPACE</kbd> up <kbd>Q / C</kbd> down <kbd>SHIFT</kbd> boost</div><div><kbd>E</kbd> inspect <kbd>R</kbd> run <kbd>N</kbd> navigate <kbd>ESC</kbd> pause</div><span id="look-hint">Click to look around · drag also works</span></div>
    <details class="view-settings"><summary>Viewing scale ${icon('expand',13)}</summary><label>Component size <output id="component-scale-value">1×</output><input id="component-scale" type="range" min="0.4" max="3" step="0.1" value="1" aria-label="Component size" /></label><label>Layout spacing <output id="layout-scale-value">1×</output><input id="layout-scale" type="range" min="0.5" max="3" step="0.1" value="1" aria-label="Layout spacing" /></label><button data-action="reset-view">Reset viewing scale</button><span>View only · circuit behavior stays the same</span></details>
    <div class="processor-hud"><button class="run-switch" data-action="run" aria-label="Run processor" title="Run processor">${icon('play',16)}</button><div><span id="hud-phase">PROCESSOR READY</span><strong id="hud-clock">CLOCK 00000</strong></div><span class="hud-a" id="hud-a">A 00</span></div>
    <div class="held-item" id="held-item">Inspection lens</div><div class="hotbar" id="hotbar" aria-label="Game tools"></div>
    <button id="component-library-button" class="build-library-button" data-action="library" hidden>${icon('blocks',15)} All components <kbd>B</kbd></button>
    <nav id="module-breadcrumb" class="module-breadcrumb" aria-label="Circuit hierarchy" hidden></nav>
    <div class="saved-indicator" id="save-label">WORLD SAVED</div>
    <div id="mobile-controls" class="mobile-controls"><div class="touch-pad"><button data-move="KeyW" aria-label="Move forward">▲</button><button data-move="KeyA" aria-label="Move left">◀</button><button data-move="KeyS" aria-label="Move backward">▼</button><button data-move="KeyD" aria-label="Move right">▶</button></div><button class="touch-jump" data-move="Space" aria-label="Fly up">↑</button><button class="touch-down" data-move="KeyQ" aria-label="Fly down">↓</button><button class="touch-inspect" data-action="interact" aria-label="Inspect target">E</button></div>
  </section>
  <section id="pause-screen" class="pause-screen" role="dialog" aria-modal="true" aria-label="Game paused" hidden>
    <div class="pause-backdrop"></div><div class="pause-frame">
      <aside class="pause-menu"><div class="pause-brand">${icon('cube',23)} SILICON TRAILS</div><h2>GAME<br>PAUSED</h2><p>The world can wait.<br>Take a look under the hood.</p>
        <button class="game-button gold resume-button" data-action="resume">${icon('play',15)} Resume world <small>ESC</small></button>
        <div class="pause-nav" aria-label="Pause menu">
          <button data-station="rtl">${icon('code',17)} Processor RTL</button><button data-station="memory">${icon('memory',17)} Memory bank</button><button data-station="trace">${icon('clock',17)} Execution trace</button><button data-station="cache">${icon('chip',17)} Cache lab</button>
          <button data-station="navigator">${icon('compass',17)} Component navigator</button><button data-action="enter-ooo">${icon('chip',17)} Architecture lab</button><button data-station="architecture">${icon('blocks',17)} Pipeline state</button><button data-action="program">${icon('folder',17)} Load program</button><button data-action="enter-build">${icon('blocks',17)} Build sandbox</button><button data-station="library">${icon('blocks',17)} Component library</button><button data-station="guide">${icon('book',17)} Field guide</button>
        </div><div id="pause-guide" class="pause-guide"></div><div class="pause-bottom"><button data-action="export">${icon('save',14)} Save world</button><button data-action="title">Save &amp; title</button></div>
      </aside>
      <section id="workbench-panel" class="workbench-panel" data-station="rtl" aria-label="Paused workbench">
        <header class="bench-header"><div><span id="bench-kicker">BEHIND THE BLOCKS</span><h3 id="bench-title">Your processor, in Verilog.</h3></div><button class="bench-close" data-action="resume" aria-label="Resume game">${icon('close',21)}</button></header>
        <div id="rtl-station" class="rtl-station"><div class="editor-toolbar"><span>${icon('code',15)} <span id="editor-filename">processor.v</span><i id="editor-dot"></i></span><select id="rtl-example" aria-label="RTL example"><option value="custom">Custom Verilog</option>${RTL_EXAMPLES.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select><button class="btn primary" id="compile-button" data-action="compile">${icon('play',12)} Synthesize</button></div><div id="code-editor" class="code-editor"><div class="editor-loading">Opening your hardware notebook…</div></div><div id="compile-status" class="compile-status">Edit the hardware, synthesize it, then walk through what you made.</div><div id="rtl-io" class="rtl-io" hidden></div><div class="bench-footnote">${icon('info',12)} Verilog describes hardware. Your changes become the circuit in this world.</div></div>
        <div id="data-station" class="data-station" hidden><div class="bench-controls"><button class="btn" data-action="instruction" aria-label="Step instruction">${icon('step',14)} Instruction</button><button class="btn" data-action="clock" aria-label="Step clock">${icon('clock',14)} Clock</button><button class="btn" data-action="rewind" aria-label="Rewind clock">${icon('rewind',14)} Rewind</button><button class="btn ghost" data-action="reset" aria-label="Reset processor">${icon('reset',14)} Reset</button><select id="speed" aria-label="Clock speed"><option value="8">8 Hz</option><option value="24">24 Hz</option><option value="120">120 Hz</option><option value="600">600 Hz</option></select><span id="panel-status">READY</span></div><div id="panel-content" class="panel-content"></div></div>
        <div id="inspect-station" class="inspect-station" hidden><div id="inspector" class="inspector"></div></div>
        <div id="guide-station" class="guide-station" hidden></div>
        <div id="navigator-station" class="navigator-station" hidden></div>
        <div id="architecture-station" class="architecture-station" hidden></div>
        <div id="library-station" class="library-station" hidden></div>
      </section>
    </div>
  </section>
</main><div id="toast" class="toast" role="status" aria-live="polite"></div><input id="project-file" type="file" accept="application/json,.json" hidden>`;

const tutorial=new Tutorial({onChange:()=>{renderTutorial();scheduleSave();},onComplete:()=>toast('Journey complete! You made a computer save a number. What will you build next?')});
world=new CircuitWorld($('#world'),{
  onSelect(id){
    state.selected=id;
    if(!id)return;
    tutorial.observe({type:'inspect',id});
    if(state.screen==='playing'&&!(state.mode==='build'&&state.tool))pauseGame('inspect');
    else if(state.workbench==='inspect')renderInspector();
  },
  onPlace({type,position}){
    if(state.screen!=='playing'||state.mode!=='build'||state.builderPath.length)return;
    try{state.selected=type.startsWith('module:')?state.builder.addModule(type.slice(7),position):state.builder.add(type,position);rebuildBuilder();toast('Component placed. Connect its ports to bring it to life.');}catch(error){toast(error.message,true);}
  },
  onConnect(connection){
    if(state.screen!=='playing'||state.mode!=='build'||state.builderPath.length)return;
    const old=state.builder.toJSON();
    try{state.builder.connect(connection);rebuildBuilder();toast('Connection made. Your wiring is the circuit.');}catch(error){state.builder=CircuitBuilder.fromJSON(old);toast(error.message,true);}
  },
  onPause(){if(state.screen==='playing'){state.ignoreEscapeUntil=performance.now()+160;pauseGame();}},
  onMove(player){
    if(state.screen!=='playing')return;
    tutorial.observe({type:'move',totalDistance:player.distanceWalked});
    const [x,y,z]=player.position;$('#coordinates').textContent=`X ${Math.floor(x)} · Y ${Math.floor(y)} · Z ${Math.floor(z)} · FREE FLIGHT`;
    if(performance.now()-lastPlayerSave>15000){lastPlayerSave=performance.now();scheduleSave();}
  },
  onTarget(target){state.target=target?.id?target:null;renderTarget();},
});

function toast(message,error=false){clearTimeout(toastTimer);const el=$('#toast');el.textContent=message;el.className=`toast show${error?' error':''}`;toastTimer=setTimeout(()=>el.classList.remove('show'),error?7000:4200);}
function source(){return editor?.state.doc.toString()??state.source;}
function setSource(text){state.source=String(text);suppressEditor=true;if(editor)editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:state.source}});suppressEditor=false;state.dirty=state.source!==state.compiled?.source;$('#editor-dot').textContent=state.dirty?'●':'';}
function compileStatus(text,kind=''){const el=$('#compile-status');el.textContent=text;el.className=`compile-status ${kind}`;}
async function ensureEditor(){
  if(editor)return editor;if(editorPromise)return editorPromise;
  editorPromise=(async()=>{
    const [{EditorView,basicSetup},{StreamLanguage},{verilog},{oneDark}]=await Promise.all([import('codemirror'),import('@codemirror/language'),import('@codemirror/legacy-modes/mode/verilog'),import('@codemirror/theme-one-dark')]);
    EditorViewClass=EditorView;$('#code-editor').innerHTML='';
    editor=new EditorView({doc:state.source,extensions:[basicSetup,StreamLanguage.define(verilog),oneDark,EditorView.lineWrapping,EditorView.updateListener.of(update=>{
      if(update.docChanged&&!suppressEditor){state.source=editor.state.doc.toString();if(state.mode==='build'){state.builderSource=state.source;state.builderSignature=state.builder.toVerilog();}state.dirty=state.source!==state.compiled?.source;$('#editor-dot').textContent=state.dirty?'●':'';if(state.dirty)compileStatus('Hardware changed · synthesize to rebuild the world.');scheduleSave();}
    })],parent:$('#code-editor')});return editor;
  })().catch(error=>{editorPromise=null;$('#code-editor').textContent=error.message;throw error;});return editorPromise;
}
function activeSim(){return state.lab?.sim||state.sim;}
function currentCycle(){return state.mode==='ooo'?(state.ooo?.cycle||0):activeSim()?.cycle||0;}
function stop(){state.running=false;clockBudget=0;renderHud();}
function isCpu(){return !!state.lab;}

function useCompiled(compiled,{exampleId=state.exampleId,preserveSource=false}={}){
  const sim=new CircuitSimulator(compiled.netlist,{top:compiled.top});
  const cpu=['instruction','mem_valid','mem_resp_ready','retired','retire_pc','halted','fault'].every(n=>sim.module.ports[n]);
  const lab=cpu?new CpuLab(compiled.netlist,{latency:state.latency,cache:state.cache}):null;
  if(lab)lab.loadProgram(state.programSource);
  stop();state.resumeRunning=false;state.compiled=compiled;state.exampleId=exampleId;state.lab=lab;state.sim=cpu?null:sim;state.mode='explore';state.view=cpu?'overview':'cells';state.scope=null;state.builderPath=[];state.builderTrail=[];
  state.genericHistory=[];state.genericTrace=[];state.eventCursor=0;state.selected=cpu?'overview:a':null;
  if(!preserveSource)setSource(compiled.source||RTL_EXAMPLES.find(x=>x.id===exampleId)?.source||'');
  if(!cpu)resetGeneric(RTL_EXAMPLES.find(x=>x.id===exampleId)?.inputs||{});
  $('#rtl-example').value=exampleId;$('#editor-filename').textContent=cpu?'processor.v':'circuit.v';buildScene();renderHud();if(state.screen==='paused')showWorkbench(state.workbench||'rtl');scheduleSave();
}
async function loadExample(id){
  try{const r=await fetch(`${BASE}examples/${id}.json`);if(!r.ok)throw new Error('This example could not be loaded.');useCompiled(await r.json(),{exampleId:id});if(id!=='cpu'){state.guided=false;tutorial.stop();renderTutorial();}compileStatus('Example loaded. Edit it, synthesize, and return to the world.');}
  catch(error){toast(error.message,true);}
}
function resetGeneric(values){
  const sim=state.sim;if(!sim)return;
  const inputs=values||Object.fromEntries(Object.entries(sim.module.ports).filter(([,p])=>p.direction==='input').map(([n])=>[n,sim.getPort(n)]));
  sim.reset();for(const [n,v] of Object.entries(inputs))if(sim.module.ports[n]?.direction==='input')sim.setInput(n,v);sim.settle();
  if(sim.module.ports.reset?.direction==='input'){sim.setInput('reset',1).tick();sim.setInput('reset',inputs.reset||0);sim.cycle=0;sim.settle();}
  state.genericHistory=[];state.genericTrace=[];
}
function rebuildBuilder(){
  const sim=new CircuitSimulator(state.builder.getNetlist());for(const [n,v] of Object.entries(state.builder.getInputs()))sim.setInput(n,v);sim.settle();
  stop();state.resumeRunning=false;state.sim=sim;state.lab=null;state.genericHistory=[];state.genericTrace=[];state.eventCursor=0;buildScene();renderHud();scheduleSave();
}
function buildScene(){
  let graph;
  if(state.mode==='ooo')graph=makeOooOverview(state.ooo);
  else if(state.mode==='build')graph=state.builder.getDesign({path:state.builderPath});
  else if(state.lab&&state.view==='overview')graph=makeCpuOverview(state.compiled);
  else{
    graph=makeNetlistGraph(state.compiled);
    if(state.scope?.length){const wanted=new Set(state.scope),anchors=new Set(graph.nodes.filter(n=>wanted.has(n.cellId||n.id)).map(n=>n.id)),visible=new Set(anchors);
      for(const e of graph.edges)if(anchors.has(e.from)||anchors.has(e.to)){visible.add(e.from);visible.add(e.to);}graph={...graph,nodes:graph.nodes.filter(n=>visible.has(n.id)),edges:graph.edges.filter(e=>visible.has(e.from)&&visible.has(e.to))};}
  }
  state.graph=graph;world.setDesign(graph);if(!graph.nodes.some(n=>n.id===state.selected))state.selected=graph.nodes.find(n=>n.kind==='register')?.id||graph.nodes[0]?.id;
  world.select(state.selected);updateSignals();renderTutorial();renderBuilderBreadcrumb();
}
function updateSignals(){if(!state.graph)return;if(state.mode==='ooo'){world.updateSignals(getOooOverviewSignals(state.graph,state.ooo));return;}const sim=activeSim();if(!sim)return;world.updateSignals(state.lab&&state.view==='overview'&&state.mode!=='build'?getCpuOverviewSignals(state.graph,state.lab):getGraphSignals(state.graph,sim));}

function syncScreen(){
  $('#game').dataset.screen=state.screen;$('#start-screen').hidden=state.screen!=='start';$('#game-hud').hidden=state.screen!=='playing';$('#pause-screen').hidden=state.screen!=='paused';
  $('#continue-button').hidden=!state.hasSave;renderHud();
}
function startGame(guided=false,{resume=false}={}){
  if(!state.ready)return;closeModal();stop();state.resumeRunning=false;
  if(!resume){state.programSource=PROGRAMS[0].source;state.programName=PROGRAMS[0].name;
    if(state.compiled===state.defaultCompiled&&state.lab&&state.mode==='explore'){
      state.lab.loadProgram(state.programSource);state.eventCursor=0;setSource(state.defaultCompiled.source);state.selected='overview:a';state.scope=null;
      if(state.view!=='overview'){state.view='overview';buildScene();}else{world.select(state.selected);updateSignals();}
    }else useCompiled(state.defaultCompiled,{exampleId:'cpu'});
    tutorial.reset();state.guided=guided;if(guided)tutorial.start();}
  else{state.guided=!!guided;if(guided&&!tutorial.complete)tutorial.start();}
  state.screen='playing';state.workbench=null;state.hasSave=true;state.tool=null;state.target=null;
  world.setTool(null);world.setPaused(false);world.startWalk({reset:true,lock:false});syncScreen();renderHotbar();renderTutorial();scheduleSave();
}
function pauseGame(station='rtl'){
  if(state.screen==='start')return;if(state.mode==='ooo'&&station==='rtl')station='architecture';
  if(state.screen==='playing')state.resumeRunning=state.running;
  state.screen='paused';stop();world.setPaused(true);syncScreen();showWorkbench(station);scheduleSave();
}
function resumeGame(){
  if(state.screen!=='paused')return;closeModal();state.screen='playing';state.workbench=null;state.running=!!state.resumeRunning&&!(state.mode==='ooo'?state.ooo?.halted:state.lab?.halted);state.resumeRunning=false;clockBudget=0;lastFrame=performance.now();
  world.setPaused(false);if(world.mode==='orbit')world.startWalk({reset:false,lock:false});syncScreen();world.canvas?.focus({preventScroll:true});renderHotbar();renderTutorial();scheduleSave();
}
function showWorkbench(station='rtl'){
  if(state.screen==='playing'){pauseGame(station);return;}
  if(state.screen!=='paused')return;
  state.workbench=station;$('#workbench-panel').dataset.station=station;
  for(const [id,visible] of [['rtl-station',station==='rtl'&&state.mode!=='ooo'],['data-station',['memory','trace','cache'].includes(station)&&state.mode!=='ooo'],['inspect-station',station==='inspect'],['guide-station',station==='guide'],['navigator-station',station==='navigator'],['architecture-station',station==='architecture'||state.mode==='ooo'&&['rtl','memory','trace','cache'].includes(station)],['library-station',station==='library']])$('#'+id).hidden=!visible;
  const titles={rtl:['BEHIND THE BLOCKS','Your processor, in Verilog.'],memory:['WHERE A NUMBER STAYS','The memory bank.'],trace:['ONE INSTRUCTION AT A TIME','Follow the execution.'],cache:['MAKE THE WAIT VISIBLE','A little closer to the processor.'],inspect:['A CLOSER LOOK','What does this block do?'],guide:['YOUR FIELD NOTES','A small guide to a big idea.']};
  const [kicker,title]=station==='library'?['BUILD FROM FIRST PRINCIPLES','Choose a circuit component.']:station==='navigator'?['GO STRAIGHT TO A COMPONENT','Navigate the machine.']:station==='architecture'||state.mode==='ooo'&&['rtl','memory','trace','cache'].includes(station)?['OUT-OF-ORDER · TEACHING MODEL','Inside the pipeline.']:titles[station]||titles.rtl;$('#bench-kicker').textContent=kicker;$('#bench-title').textContent=title;
  document.querySelectorAll('[data-station]').forEach(el=>{if(el.tagName==='BUTTON')el.classList.toggle('active',el.dataset.station===station);});
  if(station==='rtl'&&state.mode!=='ooo'){
    if(state.mode==='build'){const generated=state.builder.toVerilog();if(state.builderSignature!==generated||state.builderSource===null){state.builderSignature=generated;state.builderSource=generated;}if(source()!==state.builderSource)setSource(state.builderSource);$('#rtl-example').value='custom';$('#editor-filename').textContent='my-blocks.v';compileStatus('Verilog generated from your blocks. Edit and synthesize to explore a new RTL circuit.');}
    renderRtlIO();ensureEditor().then(()=>editor.requestMeasure()).catch(e=>toast(e.message,true));tutorial.observe({type:'open-rtl'});}
  if(['memory','trace','cache'].includes(station)&&state.mode!=='ooo'){state.panel=station;renderPanel();if(station==='memory')observeMemory();}
  if(station==='inspect')renderInspector();if(station==='guide')renderGuide();if(station==='navigator')renderNavigator();if(station==='library')renderLibrary();if(!$('#architecture-station').hidden)renderOooPanel();renderPauseGuide();
}
function titleScreen(){
  closeModal();stop();state.resumeRunning=false;state.screen='start';state.workbench=null;state.tool=null;world.setTool(null);world.startPanorama();syncScreen();saveNow();
}
function enterBuilder(){
  closeModal();tutorial.stop();state.guided=false;state.mode='build';state.builderPath=[];state.builderTrail=[];state.selected='register1';state.tool=null;rebuildBuilder();state.screen='playing';state.workbench=null;state.hasSave=true;
  world.setTool(null);world.setPaused(false);world.startWalk({reset:true,lock:false});syncScreen();renderHotbar();renderTutorial();toast('Build sandbox. Choose a block from your hotbar, then place it in the world.');scheduleSave();
}
function enterArchitecture({fresh=false}={}){
  closeModal();stop();state.resumeRunning=false;tutorial.stop();state.guided=false;
  if(!state.ooo||fresh)state.ooo=new OoOLab();
  state.mode='ooo';state.lab=null;state.sim=null;state.tool=null;state.selected='ooo:rob';
  state.screen='playing';state.workbench=null;state.hasSave=true;
  world.setTool(null);buildScene();world.setPaused(false);world.startWalk({reset:true});
  syncScreen();renderHotbar();renderTutorial();syncViewControls();scheduleSave();
  toast('Architecture lab. Inspect a unit with E. Step clocks to follow renaming, execution, and retirement.');
}
function setMode(mode){if(mode==='ooo'){enterArchitecture();return;}if(mode==='rtl'){pauseGame('rtl');return;}if(mode==='build'){enterBuilder();return;}if(state.defaultCompiled){useCompiled(state.defaultCompiled,{exampleId:'cpu'});state.tool=null;world.setTool(null);if(state.screen==='playing')world.startWalk({reset:true});}}
function setTool(type){if(state.mode!=='build')return;if(state.builderPath.length){toast('Return to the parent circuit to place parts or change wiring.');return;}state.tool=state.tool===type?null:type;world.setTool(state.tool);renderHotbar();world.canvas?.focus({preventScroll:true});}

function step(kind='clock',render=true){
  if(state.mode==='ooo'){
    if(state.screen==='start')return;if(state.screen==='paused')state.resumeRunning=false;
    try{if(kind==='instruction')state.ooo.stepInstruction();else state.ooo.stepClock();if(state.ooo.halted)stop();}
    catch(error){stop();toast(error.message,true);}
    if(render){renderLive();scheduleSave();}return;
  }
  const sim=activeSim();if(!sim||state.screen==='start')return;
  if(state.screen==='paused')state.resumeRunning=false;
  try{
    if(state.lab){if(state.lab.halted){stop();return;}if(kind==='instruction')state.lab.stepInstruction();else state.lab.stepClock();
      tutorial.observe({type:'step',cpu:state.lab.getState(),retired:state.lab.trace.length});
      for(const event of state.lab.events.slice(state.eventCursor))if(event.type==='write'&&!event.ignored)tutorial.observe({type:'memory-write',address:event.address,value:event.value});state.eventCursor=state.lab.events.length;
      if(state.lab.halted){stop();toast(state.lab.getState().fault?'This processor faulted. Pause to inspect its instructions.':`Program complete. The display holds ${state.lab.display}.`,!!state.lab.getState().fault);}
    }else{state.genericHistory.push({sim:sim.snapshot(),traceLength:state.genericTrace.length});if(state.genericHistory.length>512)state.genericHistory.shift();sim.tick();state.genericTrace.push({cycle:sim.cycle,outputs:Object.fromEntries(Object.entries(sim.module.ports).filter(([,p])=>p.direction==='output').map(([n])=>[n,sim.getPort(n)]))});if(state.genericTrace.length>512)state.genericTrace.shift();}
  }catch(error){stop();toast(error.message,true);}
  if(render){renderLive();scheduleSave();}
}
function runProcessor(){
  if(state.mode==='ooo'){if(state.screen!=='playing')return;if(state.ooo.halted)state.ooo.reset();state.running=!state.running;clockBudget=0;lastFrame=performance.now();renderHud();return;}
  if(state.screen!=='playing')return;if(state.lab?.halted){state.lab.reset();state.eventCursor=0;}state.running=!state.running;clockBudget=0;lastFrame=performance.now();state.breakpointSkipCycle=currentCycle();renderHud();
}
function resetExecution(){stop();state.resumeRunning=false;if(state.mode==='ooo')state.ooo.reset();else if(state.lab)state.lab.reset();else resetGeneric();state.eventCursor=0;renderLive();scheduleSave();toast('Processor reset.');}
function rewind(){stop();state.resumeRunning=false;if(state.mode==='ooo')state.ooo.rewind();else if(state.lab){state.lab.rewind();state.eventCursor=state.lab.events.length;}else{const s=state.genericHistory.pop();if(s){state.sim.restore(s.sim);state.genericTrace.length=s.traceLength;}}renderLive();scheduleSave();}
function renderLive(){updateSignals();renderHud();const editing=document.activeElement?.matches('input,textarea,select')||document.activeElement?.closest('.cm-editor');if(state.screen==='paused'&&!editing)renderWorkbench();else updateOutputText();}
function renderWorkbench(){if(state.screen!=='paused')return;if(!$('#architecture-station').hidden)renderOooPanel();else if(state.workbench==='rtl')renderRtlIO();else if(state.workbench==='inspect')renderInspector();else if(['memory','trace','cache'].includes(state.workbench))renderPanel();else if(state.workbench==='navigator')renderNavigator();renderPauseGuide();}
function updateOutputText(){const sim=activeSim();if(sim)document.querySelectorAll('[data-output]').forEach(el=>{try{el.textContent=sim.getPort(el.dataset.output)??'X';}catch{}});}
function renderHud(){
  const o=state.mode==='ooo'?state.ooo?.getState():null;
  const s=state.lab?.getState();$('#hud-output').textContent=s?s.display:genericOutput();$('#hud-clock').textContent=`CLOCK ${String(currentCycle()).padStart(5,'0')}`;
  $('#hud-phase').textContent=s?(s.halted?'PROGRAM COMPLETE':state.running?phaseNames[s.state]||'RUNNING':'PROCESSOR READY'):'YOUR CIRCUIT';$('#hud-a').textContent=s?`A ${s.a??'X'}`:'LIVE';
  const run=$('[data-action="run"]');run.innerHTML=icon(state.running?'pause':'play',16);run.setAttribute('aria-label',state.running?'Stop processor':'Run processor');run.title=state.running?'Stop processor':'Run processor';
  $('#location-subtitle').textContent=state.mode==='build'?'BUILD SANDBOX · YOUR CIRCUIT':s?'ST-8 PROCESSOR · EXPLORATION':'YOUR VERILOG · MADE TANGIBLE';
  $('#panel-status').textContent=s?.pending?`WAIT ${s.pending.remaining+1}`:s?.halted?'HALTED':`CLOCK ${currentCycle()}`;
  document.querySelectorAll('[data-action="instruction"]').forEach(el=>{el.disabled=!state.lab;});
  if(o){$('#hud-output').textContent=o.display??0;$('#hud-phase').textContent=o.halted?'PROGRAM COMPLETE':state.running?'OUT-OF-ORDER EXECUTION':'ARCHITECTURE LAB';$('#hud-a').textContent=`ROB ${o.rob.length}`;$('#location-subtitle').textContent='OUT-OF-ORDER · CYCLE TEACHING MODEL';document.querySelectorAll('[data-action="instruction"]').forEach(el=>el.disabled=false);}
  document.querySelectorAll('[data-station="architecture"]').forEach(el=>el.hidden=state.mode!=='ooo');
  const rtlButton=$('button[data-station="rtl"]');rtlButton.hidden=state.mode==='ooo';$('button[data-station="cache"]').hidden=state.mode==='ooo';
  $('#component-library-button').hidden=state.mode!=='build';
  if(state.mode==='build'&&state.builderPath.length)$('#location-subtitle').textContent='LIVE MODULE INTERNALS · INSPECTION';
}
function genericOutput(){const sim=activeSim();if(!sim)return 0;const name=Object.keys(sim.module.ports).find(n=>sim.module.ports[n].direction==='output');return name?(sim.getPort(name)??'X'):0;}
function renderTarget(){
  const visible=state.screen==='playing'&&!!state.target;$('#target-prompt').hidden=!visible;$('#target-name').textContent=state.target?.label||'';$('#crosshair').classList.toggle('has-target',visible);
}
const explorerTools=[['interact','target','Inspect'],['instruction','step','Instruction'],['clock','clock','Clock'],['memory','memory','Memory'],['enter-build','blocks','Build'],['processor','chip','Processor'],['guide','book','Guide'],['rtl','code','Source'],['export','save','Save']];
const buildTools=[[null,'target','Inspect'],['wire','wire','Wire'],['input','blocks','Input'],['switch','light','Switch'],['add','plus','Adder'],['register','chip','Register'],['mux','compass','Mux'],['output','light','Output'],['not','blocks','NOT']];
function renderHotbar(){
  const build=state.mode==='build'&&!state.builderPath.length,tools=build?buildTools:state.mode==='build'?[['interact','target','Inspect'],['clock','clock','Clock'],['parent-module','blocks','Parent'],['navigator','compass','Find'],['library','blocks','Library'],['rtl','code','Source'],['guide','book','Guide'],['root-module','chip','Root'],['export','save','Save']]:state.mode==='ooo'?[['interact','target','Inspect'],['instruction','step','Retire'],['clock','clock','Clock'],['architecture','blocks','Pipeline'],['navigator','compass','Units'],['processor','chip','RTL CPU'],['guide','book','Guide'],['ooo-program','code','Program'],['export','save','Save']]:explorerTools;
  $('#hotbar').innerHTML=tools.map(([action,glyph,label],index)=>`<button class="hotbar-item ${(build?state.tool===action:index===0)?'selected':''}" ${build?`data-tool="${action??''}"`:`data-action="${action}"`} aria-label="${esc(build?label:action==='instruction'?'Step instruction':action==='clock'?'Step clock':label)}" title="${index+1} · ${esc(label)}"><small>${index+1}</small>${icon(glyph,23)}<span>${esc(label)}</span></button>`).join('');
  $('#held-item').textContent=build?(state.tool?.startsWith('module:')?state.builder.listModules().find(d=>d.id===state.tool.slice(7))?.name:BUILDER_TYPES[state.tool]?.label||buildTools.find(t=>t[0]===state.tool)?.[2]||'Inspection lens'):'Inspection lens';renderHud();
}
function renderTutorial(){
  const t=tutorial.getCurrent(),visible=state.guided&&(t.active||t.complete);$('#tutorial-card').hidden=!visible;
  if(visible){const key=`${t.index}:${t.active}:${t.complete}`;if(key!==lastGuideKey){lastGuideKey=key;$('#tutorial-card').innerHTML=`<div class="guide-person"><div class="pixel-guide" aria-hidden="true"><i></i></div><div><span>ELI · YOUR FIELD GUIDE</span><small>${t.complete?'JOURNEY COMPLETE':`CHAPTER ${t.index+1} OF ${t.total}`}</small></div></div><div class="quest-pips">${Array.from({length:t.total},(_,i)=>`<i class="${i<t.index?'done':i===t.index?'current':''}"></i>`).join('')}</div><h2>${esc(t.title)}</h2><p>${esc(t.description)}</p><div class="quest-hint">${esc(t.hint)}</div><button class="quest-action" data-action="tutorial-action">${esc(t.actionLabel)} ${icon('arrow',14)}</button>`;}}
  world?.setTutorialTarget?.(visible?t.targetNodeId||null:null);renderPauseGuide();
}
function renderPauseGuide(){const t=tutorial.getCurrent();const el=$('#pause-guide');if(!el)return;el.hidden=!state.guided;el.innerHTML=state.guided?`<small>YOUR JOURNEY · ${t.complete?'COMPLETE':`${t.index+1}/${t.total}`}</small><strong>${esc(t.title)}</strong><span>${esc(t.complete?'The world is yours to explore.':t.id==='open-rtl'?'Choose Processor RTL in this menu to see the hardware.':t.hint)}</span>`:'';}
function tutorialAction(){
  const t=tutorial.getCurrent();if(t.action==='walk'||t.action==='resume'){if(t.complete){state.guided=false;tutorial.stop();renderTutorial();}if(state.screen==='paused')resumeGame();world.canvas?.focus();}
  else if(t.action==='focus-target'){if(state.screen==='paused')resumeGame();world.teleportToNode(t.targetNodeId);}
  else if(t.action==='step-instruction')step('instruction');
  else if(t.action==='inspect-memory'){state.memoryAddress=0x40;pauseGame('memory');}
  else if(t.action==='pause')pauseGame('rtl');
}
function observeMemory(){if(state.lab)tutorial.observe({type:'memory-inspect',address:state.memoryAddress,value:memoryValue(state.memoryAddress)});}
function memoryValue(address){return address===0xFF?(state.lab.input&255):address===0xFE?state.lab.display:state.lab.ram[address];}

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
  if(state.mode==='build'&&node?.type==='module'&&sim){renderModuleInspector(node,sim);return;}
  if(state.mode==='ooo'&&node){$('#inspector').innerHTML=`<div class="selected-card"><div class="eyebrow">ARCHITECTURE TEACHING MODEL</div><h3 class="selected-name">${esc(node.label)}</h3><p class="side-description">${esc(node.description||'')}</p><div class="guide-actions"><button class="btn" data-action="focus">${icon('target',13)} Fly to this unit</button><button class="btn" data-station="architecture">Inspect live pipeline</button></div>${partScaleControl(node)}</div><div class="ooo-unit-state">${renderArchitecture(state.ooo,{section:node.id,compact:true})}</div>`;return;}
  if(!node||!sim){$('#inspector').innerHTML='<div class="empty-state">Select a component in the world to inspect its live values and connections.</div>';return;}
  const width=Math.min(node.width||8,32),value=nodeValue(node),bits=value==null?'X'.repeat(Math.min(width,16)):Number(value).toString(2).padStart(width,'0').slice(-16);
  const inputName=node.inputName || (sim.module.ports[node.id]?.direction==='input'?node.id:null);
  let ports=[];
  const cell=sim.module.cells[node.cellId||node.id];
  if(cell)ports=Object.entries(sim.getCellPorts(node.cellId||node.id)).map(([name,val])=>({name,value:val,width:cell.connections[name].length}));
  else if(node.ports)ports=node.ports.map(p=>({name:p.name,value:p.bits?sim.getBits(p.bits):p.name==='Q'||p.direction==='output'?value:undefined,width:p.width}));
  const source=String(node.source||cell?.attributes?.src||'');
  const description=node.description || (node.kind==='register'?'Captures its input at the active clock edge and holds the value between edges.':node.kind==='alu'?'Transforms its current inputs. Inspect the output before capturing it in a register.':node.kind==='memory'?'Addressed storage. Values change only when a write commits.':'Part of the live circuit. Its value follows its inputs and connections.');
  $('#inspector').innerHTML=`${state.mode==='build'&&state.builderPath.length?moduleInspectionToolbar():''}<div class="inspector-top"><div class="inspector-heading"><h2>Component inspector</h2><span class="status-badge ${cpu?.halted?'halted':''}">${cpu?.halted?'HALTED':state.running?'RUNNING':'LIVE'}</span></div></div>
    <div class="selected-card"><div class="selected-icon" style="color:${kindColor(node.kind)}">${icon(node.kind==='memory'?'memory':node.kind==='alu'?'plus':node.kind==='output'?'light':'chip',22)}</div><h3 class="selected-name">${esc(shortLabel(node.label||node.id,30))}</h3><div class="selected-type">${esc(node.type||node.kind||'circuit component')} · ${width}-bit</div>
    <div class="value-display"><div class="value-heading"><span>CURRENT VALUE</span><span>${width} BITS</span></div><div class="big-value"><strong>${value===undefined?'—':value===null?'X':value}</strong><span>${value==null?'unknown':`0x${hex(value,Math.ceil(width/4))}`}</span></div><div class="bit-row">${[...bits].map(b=>`<span class="bit ${b==='1'?'on':b==='X'?'unknown':''}">${b}</span>`).join('')}</div></div>
    <div class="details"><div class="detail-row"><span>Kind</span><span>${esc(node.kind||'logic')}</span></div><div class="detail-row"><span>State changes</span><span>${node.kind==='register'?'Clock edge':'Input / service'}</span></div>${source?`<div class="detail-row"><span>Source</span><span title="${esc(source)}">${esc(source.split('|')[0])}</span></div>`:''}</div><p class="side-description" style="margin-top:15px">${esc(description)}</p>
    <div style="display:flex;gap:6px;margin-top:14px"><button class="btn small" data-action="focus">${icon('target',12)} Focus</button>${state.mode==='build'?(state.builderPath.length?'':`<button class="btn small danger" data-action="delete">${icon('trash',12)} Remove</button>`):`<button class="btn small" data-action="source">${icon('code',12)} View RTL</button>`}</div>${node.id==='overview:ram'?`<button class="btn small" data-station="memory" style="width:100%;margin-top:8px">${icon('memory',12)} Open memory bank</button>`:''}${node.id==='overview:rom'?`<button class="btn small" data-action="program" style="width:100%;margin-top:8px">${icon('code',12)} Read the program</button>`:''}${node.cellIds?.length?`<button class="btn small" data-action="expand-node" style="width:100%;margin-top:7px">${icon('blocks',12)} Explore ${node.cellIds.length} implementing cells</button>`:''}</div>
    ${inputName&&!(state.mode==='build'&&state.builderPath.length)?`<div class="inspector-section"><div class="eyebrow">DRIVE THIS INPUT</div><div class="port-row"><span>${esc(inputName)}</span><input data-input="${esc(inputName)}" data-builder-input="${state.mode==='build'?esc(node.id):''}" type="number" min="0" max="${2**width-1}" value="${sim.getPort(inputName)??''}" placeholder="X" aria-label="Value of ${esc(inputName)}" /></div></div>`:''}
    ${cpu?`<div class="inspector-section"><div class="eyebrow">PROCESSOR STATE</div><div class="registers"><div class="register"><label>ACCUMULATOR A</label><strong>${cpu.a??'X'}</strong><small>0x${hex(cpu.a)}</small></div><div class="register"><label>PROGRAM COUNTER</label><strong>${hex(cpu.pc)}</strong><small>instruction address</small></div><div class="register"><label>ZERO / CARRY</label><strong>${cpu.z} / ${cpu.c}</strong><small>condition flags</small></div><div class="register"><label>OUTPUT DISPLAY</label><strong>${cpu.display}</strong><small>mapped at 0xFE</small></div></div></div><div class="inspector-section"><div class="eyebrow">${phaseNames[cpu.state]||'CONTROLLER'}</div><div class="instruction-card"><code>${esc(disassemble(cpu.ir))}</code><p>${cpu.pending?`A ${cpu.pending.write?'write':'read'} at 0x${hex(cpu.pending.address)} is pending. ${cpu.pending.remaining+1} clock${cpu.pending.remaining?'s':''} until completion.`:'Select Instruction to advance through every microstep of the current operation.'}</p></div><div class="port-row" style="margin-top:12px"><span>Input port 0xFF</span><input id="cpu-input" type="number" min="0" max="255" value="${state.lab.input}" aria-label="Memory mapped input byte" /></div></div>`:`<div class="inspector-section"><div class="eyebrow">COMPONENT PORTS</div><div class="port-list">${ports.map(p=>`<div class="port-row"><span>${esc(p.name)} [${p.width}]</span><span class="port-value">${p.value===undefined?'—':p.value===null?'X':`0x${hex(p.value)}`}</span></div>`).join('')||'<p class="side-description">Select an input to change its value.</p>'}</div></div>`}
    ${state.mode==='build'&&!state.builderPath.length?`<div class="inspector-section">${(node.ports||[]).filter(p=>p.direction==='input').map(p=>`<div class="port-row"><span>${esc(p.name)} [${p.width}]</span><button class="btn ghost small" style="margin-left:auto" data-action="disconnect" data-port="${esc(p.name)}" ${state.builder.edges.some(e=>e.to===node.id&&e.toPort===p.name)?'':'disabled'}>Disconnect</button></div>`).join('')}<button class="btn small" data-action="export-rtl" style="width:100%">${icon('code',12)} Open this circuit as Verilog</button><p class="side-description" style="margin-top:10px">Changing connections restarts execution. Unconnected inputs remain unknown.</p></div>`:''}${partScaleControl(node)}`;
}

function partScaleControl(node){const scale=world.getViewSettings().partScales[node.id]??1;return `<label class="part-scale-control">This component’s size <output id="part-scale-value">${scale}×</output><input id="part-scale" type="range" min="0.4" max="3" step="0.1" value="${scale}" aria-label="Selected component size" /></label><p class="fine-print">Changes its viewing size. Ports, cables, and selection follow the component.</p>`;}
function syncViewControls(){const v=world.getViewSettings();for(const [id,key] of [['layout-scale','layoutScale'],['component-scale','componentScale']]){$('#'+id).value=v[key];$('#'+id+'-value').textContent=`${v[key]}×`;}}
function renderNavigator(filter=''){
  const nodes=(state.graph?.nodes||[]).filter(n=>`${n.label} ${n.kind} ${n.id}`.toLowerCase().includes(filter.toLowerCase()));
  $('#navigator-station').innerHTML=`<div class="navigator-intro"><p>Choose any component to inspect its state or fly straight to it. Scaling changes the view; it never changes execution.</p><input id="component-search" type="search" value="${esc(filter)}" placeholder="Find a register, queue, or logic cell…" aria-label="Find component" /></div><div class="component-list">${nodes.map(n=>`<div class="component-list-row"><span class="component-kind" style="--kind:${kindColor(n.kind)}"></span><div><strong>${esc(n.label)}</strong><small>${esc(n.kind||'logic')} · ${esc(n.id)}</small></div><button class="btn small" data-select-node="${esc(n.id)}">Inspect</button><button class="btn small" data-focus-node="${esc(n.id)}">Fly here</button></div>`).join('')||'<p class="empty-state">No matching components.</p>'}</div>`;
}
function renderOooPanel(){
  $('#architecture-station').innerHTML=state.mode==='ooo'?renderArchitecture(state.ooo):`<div class="empty-state"><strong>Explore an out-of-order processor.</strong><p>Inspect decode, dispatch, renaming maps, reservation stations, load/store ordering, and the reorder buffer in a cycle-based teaching model.</p><button class="btn primary" data-action="enter-ooo">Enter architecture lab</button></div>`;
}
function moduleInspectionToolbar(){return `<div class="module-inspection-toolbar"><span>LIVE INSPECTION · SAME CIRCUIT &amp; CLOCK</span><div><button class="btn small" data-action="clock" aria-label="Step module clock">${icon('clock',13)} Step clock</button><button class="btn small" data-action="rewind">Rewind</button>${state.builderPath.length?'<button class="btn small" data-action="parent-module">Back to parent</button>':'<button class="btn small" data-station="library">Open component library</button>'}</div><p>Opening a module preserves register state. Return to the root circuit to change its wiring or place parts.</p></div>`;}
function renderModuleInspector(node,sim){
  const path=node.instancePath||[...state.builderPath,node.localId||node.id];
  const ports=state.builder.getInstancePorts(path),def=state.builder.getDefinitionForPath(path);
  $('#inspector').innerHTML=`${moduleInspectionToolbar()}<div class="selected-card module-selected-card"><div class="eyebrow">REUSABLE MODULE · INDEPENDENT INSTANCE</div><h3 class="selected-name">${esc(node.label||def.name)}</h3><p class="side-description">An instance of <strong>${esc(def.name)}</strong>. Its internal registers belong to this instance. All modules use the circuit’s shared rising-edge clock.</p><div class="module-port-values">${ports.map(p=>{const v=sim.getBits(p.bits);return `<div data-module-signal="${esc(p.name)}"><span>${p.direction==='input'?'IN':'OUT'} · ${esc(p.name)} <small>[${p.width}]</small></span><strong>${v===null?'X':v}</strong><small>${v===null?'unknown':`0x${hex(v,Math.ceil(p.width/4))}`}</small></div>`;}).join('')}</div><div class="guide-actions"><button class="btn primary" data-action="open-module">${icon('blocks',14)} Open module</button><button class="btn" data-action="focus">${icon('target',13)} Fly to instance</button>${!state.builderPath.length?'<button class="btn danger" data-action="delete">Remove instance</button>':''}</div><p class="fine-print">Library definitions are immutable. Removing an instance preserves its definition and every other instance.</p>${partScaleControl(node)}</div>`;
}
function renderBuilderBreadcrumb(){
  const el=$('#module-breadcrumb');if(!el)return;el.hidden=state.mode!=='build'||!state.builderPath.length;
  if(el.hidden)return;
  el.innerHTML=`<button data-builder-level="0">${icon('blocks',13)} Build sandbox</button>${state.builderPath.map((id,i)=>`<span>›</span><button data-builder-level="${i+1}" ${i===state.builderPath.length-1?'aria-current="location"':''}>${esc(state.builderTrail[i]||id)}</button>`).join('')}<small>LIVE INTERNALS · INSPECT ONLY</small>`;
}
function openBuilderModule(){
  const node=state.graph?.nodes.find(n=>n.id===state.selected);if(state.mode!=='build'||node?.type!=='module')return;
  const path=node.instancePath||[...state.builderPath,node.localId||node.id];state.builder.getDesign({path});
  state.builderPath=[...path];state.builderTrail=[...state.builderTrail,node.label||node.localId||node.id];state.tool=null;state.selected=null;
  world.setTool(null);buildScene();resumeGame();world.startWalk({reset:true});renderHotbar();scheduleSave();toast('Inside this instance. Signals and registers come from the same live circuit.');
}
function setBuilderLevel(depth){
  if(state.mode!=='build'||!Number.isInteger(depth)||depth<0||depth>state.builderPath.length)return;
  const oldPath=[...state.builderPath];state.builderPath=oldPath.slice(0,depth);state.builderTrail=state.builderTrail.slice(0,depth);state.tool=null;state.selected=oldPath.slice(0,depth+1).join('/');
  world.setTool(null);buildScene();if(state.screen==='paused')resumeGame();world.startWalk({reset:true});if(state.selected)world.teleportToNode(state.selected);renderHotbar();scheduleSave();
}
function showModuleAuthoring(){
  if(state.mode!=='build'){enterBuilder();pauseGame('library');}
  if(state.builderPath.length){toast('Return to the root circuit to package a reusable component.');return;}
  const nodes=[...state.builder.nodes.values()].filter(n=>!['input','switch','output'].includes(n.type));
  moduleDraft={nodeIds:new Set(),portNames:{}};
  showModal('Create reusable module',moduleAuthoring(nodes),`<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="package-module">Package selection</button>`);
  $('.modal').classList.add('module-authoring-modal');updateModulePreview();
}
function updateModulePreview(){
  if(!moduleDraft||!$('#module-boundaries'))return;
  const button=$('[data-action="package-module"]');
  try{const ids=[...moduleDraft.nodeIds],preview=ids.length?state.builder.previewModule(ids):null;$('#module-boundaries').innerHTML=moduleBoundaryFields(preview,moduleDraft.portNames);$('#module-error').textContent='';button.disabled=!preview;}
  catch(error){$('#module-boundaries').innerHTML='';$('#module-error').textContent=error.message;button.disabled=true;}
}
function packageModule(){
  if(state.mode!=='build'||state.builderPath.length||!moduleDraft)return;
  try{const name=$('#module-name').value.trim(),portNames=Object.fromEntries([...document.querySelectorAll('[data-module-port]')].map(el=>[el.dataset.modulePort,el.value.trim()]));
    const result=state.builder.createModule({name,nodeIds:[...moduleDraft.nodeIds],portNames});
    state.selected=result.instanceId;state.tool=null;moduleDraft=null;closeModal();world.setTool(null);rebuildBuilder();showWorkbench('library');renderHotbar();scheduleSave();toast(`${name} saved to your library. The selected group is now an instance.`);
  }catch(error){$('#module-error').textContent=error.message;}
}
function renderLibrary(){
  const descriptions={input:'An editable eight-bit value.',switch:'A one-bit control input.',output:'Observe the value on a bus.',register:'Capture D on a clock edge when EN is one.',mux:'Select A or B with a one-bit S input.',add:'Eight-bit addition with wraparound.',sub:'Eight-bit subtraction with wraparound.',mul:'Keep the low eight bits of a product.',eq:'Compare two buses; one-bit equality output.',lt:'Unsigned less-than; one-bit output.',shl:'Logical left shift; zero fill.',shr:'Logical right shift; zero fill.',and:'Bitwise AND.',or:'Bitwise OR.',xor:'Bitwise exclusive OR.',not:'Invert each bit.'};
  $('#library-station').innerHTML=`<div class="navigator-intro"><p>Choose a part, resume flight, and aim at an empty area of the grid to place it with E. Use Wire to connect output ports to input ports of the same width. Comparators can drive mux selection and register enables.</p><p>Primitives and your reusable modules simulate and export structural Verilog. The architecture lab’s ROB, rename map, and queues are a separate fixed model.</p>${state.mode==='build'&&state.builderPath.length?'<p class="library-readonly-note">You are inspecting an instance. <button class="btn small" data-action="root-module">Return to root to build</button></p>':''}</div>${moduleCards(state.builder.listModules())}<div class="library-section-heading primitives-heading"><span class="eyebrow">PRIMITIVE COMPONENTS</span></div><div class="component-library-grid">${Object.entries(BUILDER_TYPES).map(([type,spec])=>`<button class="component-library-card" data-build-type="${esc(type)}" aria-label="Choose ${esc(spec.label)}"><span style="color:${kindColor(spec.kind)}">${icon(spec.kind==='alu'?'plus':spec.kind==='register'?'chip':'blocks',23)}</span><strong>${esc(spec.label)}</strong><p>${esc(descriptions[type]||'A circuit component.')}</p><small>${spec.ports.map(p=>`${p.name} ${p.direction==='input'?'IN':'OUT'}[${p.width}]`).join(' · ')}</small></button>`).join('')}</div>`;
}


function renderPanel(){
  const panel=$('#panel-content'),lab=state.lab;if(!activeSim())return;
  if(!lab){renderGenericPanel(panel);return;}
  if(state.panel==='memory'){renderMemory(panel);return;}
  if(state.panel==='cache'){renderCache(panel);return;}
  const rows=lab.trace.slice(-80).reverse();
  panel.innerHTML=rows.length?`<table class="trace-table"><thead><tr><th>CLOCK</th><th>PC</th><th>INSTRUCTION</th><th>A</th><th>MEMORY / EFFECT</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${row.cycle}</td><td>0x${hex(row.pc)}</td><td class="instruction">${esc(row.instruction)}</td><td>${row.a??'X'}</td><td class="${row.memory?'changed':''}">${row.memory?`${row.memory.type.toUpperCase()} [${hex(row.memory.address)}] ${row.memory.type==='write'?'←':'→'} ${row.memory.value}`:row.instruction==='HALT'?'Program complete':`PC → ${hex(row.nextPc)}`}</td></tr>`).join('')}</tbody></table>`:`<div class="empty-state"><strong>The first instruction is waiting.</strong><p>Step an instruction, or return to the world and start the processor.</p></div>`;
}
function renderMemory(panel){
  const lab=state.lab,selected=state.memoryAddress,last=lab.events.filter(e=>e.type==='write'&&!e.ignored&&e.address===selected).at(-1),reads=lab.events.filter(e=>e.type==='read'&&e.address===selected).length;
  const written=new Set(lab.events.filter(e=>e.type==='write'&&!e.ignored).map(e=>e.address));
  const writes=lab.events.filter(e=>e.type==='write'&&!e.ignored&&e.address===selected);
  const origin=last?lab.trace.find(row=>row.memory?.id===last.id):null;
  const previous=writes.length>1?writes.at(-2).value:0;
  const memoryValue=address=>address===0xFF?(lab.input&255):address===0xFE?lab.display:lab.ram[address];
  const selectedValue=memoryValue(selected);
  let grid='<span></span>'+Array.from({length:16},(_,i)=>`<span class="memory-col">${hex(i,1)}</span>`).join('');
  for(let row=0;row<16;row++){
    grid+=`<span class="memory-row-label">${hex(row*16)}</span>`;
    for(let col=0;col<16;col++){const address=row*16+col;grid+=`<button class="memory-cell ${written.has(address)?'changed':''} ${address===selected?'selected':''}" data-address="${address}" title="Address 0x${hex(address)} · ${memoryValue(address)}" aria-label="Memory address 0x${hex(address)}, value ${memoryValue(address)}">${hex(memoryValue(address))}</button>`;}
  }
  panel.innerHTML=`<div class="memory-wrap"><div class="memory-grid">${grid}</div><div class="memory-detail"><span class="eyebrow">ADDRESS 0x${hex(selected)}</span><strong>${selectedValue} <span class="muted" style="font-size:10px">/ 0x${hex(selectedValue)}</span></strong><code>${selectedValue.toString(2).padStart(8,'0')}</code><p>${selected===0xFE?'Numeric output device. Writes update the display.':selected===0xFF?'Input device. Reads return the configured input byte.':last?`Saved by STORE${origin?` at PC 0x${hex(origin.pc)}`:''}.<br>Clock ${last.cycle} · source A.<br>Previous value: ${previous}.<br>${writes.length} committed write${writes.length===1?'':'s'}.`:'Initial zero value. No committed writes yet.'}</p><span>${reads} completed read${reads===1?'':'s'} · values persist until overwritten or reset.</span><button class="btn small" data-action="watch-memory" style="margin-top:12px">${icon('target',12)} ${state.watchAddress===selected?'Watching writes':'Watch writes here'}</button></div></div>`;
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
function renderGuide(){
  $('#guide-station').innerHTML=`<div class="guide-page"><div class="guide-page-heading">${icon('book',27)}<div><small>FIELD NOTES · 01</small><h4>A world you can understand.</h4></div></div><p>The ST-8 and Verilog worlds show simulated circuit logic. The architecture lab shows a separate cycle-based model of an out-of-order processor. Find a register, follow its wires, and see what changes when the clock ticks.</p><div class="control-grid"><span><kbd>W A S D</kbd> Fly</span><span><kbd>MOUSE</kbd> Look / drag</span><span><kbd>SPACE</kbd> Fly up</span><span><kbd>Q / C</kbd> Fly down</span><span><kbd>SHIFT</kbd> Boost</span><span><kbd>E</kbd> Inspect a block</span><span><kbd>ESC</kbd> Pause / resume</span><span><kbd>1–9</kbd> Choose a hotbar item</span><span><kbd>TAB</kbd> Open memory</span></div><h4>Three places a number can live</h4><p><strong>Wires</strong> carry the current value. <strong>Registers</strong> capture a value at a clock edge. <strong>Memory</strong> keeps bytes at addresses across instructions.</p><h4>Your first experiment</h4><p>Step LDI 7, ADDI 5, then STORE 0x40. Open the memory bank: address 40 holds 0C in hexadecimal—12 in decimal.</p><h4>Make your own hardware</h4><p>Build sandbox gives you gates, registers and real port wiring. Or edit Verilog in the paused workbench, synthesize it, then fly through the new circuit.</p><h4>Explore a larger processor</h4><p>The architecture lab models decode, dispatch, speculative and architectural register maps, physical registers, reservation stations, a load/store queue, and a reorder buffer. You can edit programs and configure queue capacities. These units are connected in a fixed teaching model. They are not yet composable sandbox blocks or exportable processor RTL. Branch prediction, recovery, exceptions, and a full modern ISA remain future work.</p><div class="guide-actions"><button class="btn" data-action="enter-ooo">Open architecture lab</button><button class="btn primary" data-action="restart-tutorial">${icon('compass',14)} Start the guided journey</button><button class="btn" data-action="map">${icon('expand',14)} Inspect from above</button><button class="btn" data-action="validate">${icon('check',14)} Test processor</button></div><p class="fine-print">This is a logical world: distance between components changes the view, not electrical timing. RAM and cache are simulated devices.</p></div>`;
}
function showModal(title,body,actions=''){
  $('.modal-backdrop')?.remove();const element=document.createElement('div');element.className='modal-backdrop';element.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button class="btn ghost icon-only" data-action="close-modal" aria-label="Close dialog">${icon('close',18)}</button></header>${body}${actions?`<div class="modal-actions">${actions}</div>`:''}</section>`;document.body.appendChild(element);element.addEventListener('click',e=>{if(e.target===element)closeModal();});element.querySelector('select,textarea,button')?.focus();
}
function closeModal(){$('.modal-backdrop')?.remove();moduleDraft=null;}
function showControls(){showModal('How to play',`<p>Fly through the machine and explore a computer built from simple parts.</p><div class="control-grid"><span><kbd>W A S D</kbd> Move</span><span><kbd>MOUSE</kbd> Look / drag</span><span><kbd>SPACE</kbd> Fly up</span><span><kbd>Q / C</kbd> Fly down</span><span><kbd>SHIFT</kbd> Boost</span><span><kbd>E</kbd> Inspect</span><span><kbd>ESC</kbd> Pause &amp; RTL</span></div><p>Choose <strong>Start guided journey</strong> for your first visit. Eli will guide you from a register to a saved number. Use the hotbar to step the processor, inspect memory, and enter the building sandbox.</p>`,`<button class="btn primary" data-action="close-modal">Got it ${icon('check',14)}</button>`);}
function showOooProgram(){
  if(state.mode!=='ooo')return;pauseGame('architecture');
  showModal('Architecture lab program',`<p>This assembly runs in the out-of-order teaching model. It is separate from the ST-8 RTL CPU instruction set.</p><select id="ooo-example" aria-label="Architecture example">${OOO_PROGRAMS.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}<option value="custom" selected>Current program</option></select><textarea id="ooo-assembly" spellcheck="false" aria-label="Architecture assembly">${esc(state.ooo.programSource)}</textarea><p class="fine-print">LI Rd, immediate · ADD / SUB / MUL Rd, Ra, Rb · ADDI Rd, Ra, immediate · LOAD Rd, [Rb + offset] · STORE Rs, [Rb + offset] · NOP · HALT. R0 is zero. Values and memory are 8-bit. No branches or branch prediction yet.</p>`,`<button class="btn primary" data-action="load-ooo-program">Load and reset</button>`);
}
function showOooConfig(){
  if(state.mode!=='ooo')return;pauseGame('architecture');const c=state.ooo.config;
  const fields=[['robSize','ROB entries',1,64],['rsSize','Reservation stations',1,64],['lsqSize','Load / store entries',1,64],['physicalCount','Physical registers',9,128],['mulLatency','Multiply latency (clocks)',1,100],['memoryLatency','RAM latency (clocks)',1,100]];
  showModal('Configure architecture units',`<p>Change resource capacities and latencies to observe backpressure and waiting. Applying changes resets this model’s execution and memory.</p><div class="ooo-config-fields">${fields.map(([id,label,min,max])=>`<label>${label}<input data-config="${id}" aria-label="${label}" type="number" min="${min}" max="${max}" value="${c[id]}" /></label>`).join('')}</div><p class="fine-print">Dispatch and commit are two-wide. One ALU, one multiply unit, and one load/store execution unit are modeled.</p>`,`<button class="btn primary" data-action="apply-ooo-config">Apply and reset</button>`);
}
function showProgram(){
  if(state.mode==='ooo'){showOooProgram();return;}
  if(!state.lab){toast('Return to the processor to load an instruction program.');return;}
  if(state.screen==='playing')pauseGame('trace');
  showModal('Load a program',`<p>These instructions go into ROM. Your circuit's datapath and controller execute them.</p><select id="program-example" aria-label="Example program"><option value="custom">Current program</option>${PROGRAMS.map(p=>`<option value="${p.id}">${esc(p.name)} — ${esc(p.description)}</option>`).join('')}</select><textarea id="assembly-source" spellcheck="false" aria-label="Assembly program">${esc(state.programSource)}</textarea><p class="fine-print">LDI, LOAD, STORE, ADD, ADDI, SUBI, JMP, JZ, JNZ, NOP, HALT. Byte FE is the display; FF is the input device.</p>`,`<button class="btn" data-action="check-program">Check syntax</button><button class="btn primary" data-action="load-program">Load and reset ${icon('arrow',13)}</button>`);
}
async function synthesize(){
  if(state.compiling||state.screen!=='paused')return;stop();state.resumeRunning=false;state.compiling=true;const captured=source();$('#compile-button').disabled=true;
  compileStatus('Loading your local synthesis engine… first use downloads the toolchain.','busy');
  try{const compiled=await compileVerilog(captured,{top:'top',onProgress:p=>compileStatus(typeof p==='string'?p:p.message||'Synthesizing hardware…','busy')});
    useCompiled(compiled,{exampleId:RTL_EXAMPLES.find(x=>x.source===captured)?.id||'custom',preserveSource:true});state.dirty=source()!==captured;$('#editor-dot').textContent=state.dirty?'●':'';
    compileStatus(state.dirty?'Hardware built. Your notebook has newer changes.':`Synthesis complete · ${Object.keys(activeSim().module.cells).length} cells. Resume to fly through your hardware.`);toast('New hardware is ready. Resume to fly through it.');
  }catch(error){compileStatus(error.message,'error');toast('Synthesis failed. The previous circuit is still in your world.',true);}
  finally{state.compiling=false;$('#compile-button').disabled=false;scheduleSave();}
}
async function validateCpu(){
  if(!state.compiled)return;showModal('Processor checks','<div id="validation-results"><p>Running programs through the actual circuit…</p></div>');await new Promise(r=>setTimeout(r,40));
  const expected={sum:12,loop:55,cache:12,input:43},results=[];
  for(const program of PROGRAMS){try{const lab=new CpuLab(state.compiled.netlist,{latency:state.latency,cache:state.cache});lab.input=42;lab.loadProgram(program.source);for(let i=0;i<1200&&!lab.halted;i++)lab.stepInstruction();if(!lab.halted||lab.getState().fault||lab.display!==expected[program.id])throw new Error(`Expected ${expected[program.id]}, got ${lab.display}`);results.push(`<p class="test-pass">${icon('check',14)} ${esc(program.name)} · display ${lab.display} · ${lab.cycle} clocks</p>`);}catch(error){results.push(`<p class="test-fail">${esc(program.name)} · ${esc(error.message)}</p>`);}}
  const el=$('#validation-results');if(el)el.innerHTML=results.join('')+'<p>Your current execution was preserved.</p>';
}
function projectData(){return{format:'silicon-trails',version:1,name:'Processor Atlas',mode:state.mode,view:state.view,exampleId:state.exampleId,source:source(),compiled:state.compiled,program:state.programSource,programName:state.programName,builder:state.builder.toJSON(),config:{cache:state.cache,latency:state.latency,breakpoint:state.breakpoint,watchAddress:state.watchAddress},game:{builderView:{path:[...state.builderPath],trail:[...state.builderTrail]},viewSettings:world.getViewSettings(),architecture:state.ooo?.snapshot()||null,started:state.hasSave,guided:state.guided,tutorial:tutorial.snapshot(),builderNotebook:{signature:state.builderSignature,text:state.builderSource},execution:captureExecution({lab:state.lab,sim:state.sim})}};}
function saveNow(){if(!state.ready||!state.hasSave)return;try{localStorage.setItem(STORAGE,JSON.stringify(projectData()));$('#save-label').textContent='WORLD SAVED';}catch{$('#save-label').textContent='SAVE WORLD TO KEEP A COPY';}}
function scheduleSave(){clearTimeout(saveTimer);if(!state.hasSave)return;$('#save-label').textContent='SAVING…';saveTimer=setTimeout(saveNow,500);}
function downloadProject(){
  if(state.screen==='playing')pauseGame();const url=URL.createObjectURL(new Blob([JSON.stringify(projectData(),null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='silicon-trails-world.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('World saved: hardware, programs, execution, and viewing preferences.');
}
function restoreProject(data){
  if(data?.format!=='silicon-trails'||data.version!==1)throw new Error('This is not a supported Silicon Trails world.');
  if(typeof data.source!=='string'||data.source.length>131072||typeof data.program!=='string')throw new Error('World source or program is missing.');assemble(data.program);
  const builder=CircuitBuilder.fromJSON(data.builder);new CircuitSimulator(builder.getNetlist());if(!data.compiled?.netlist)throw new Error('The saved circuit is missing.');new CircuitSimulator(data.compiled.netlist);
  stop();state.builder=builder;state.cache=!!data.config?.cache;state.latency=Math.max(1,Math.min(100,Number(data.config?.latency)||3));state.breakpoint=Number.isInteger(data.config?.breakpoint)?data.config.breakpoint:null;state.watchAddress=Number.isInteger(data.config?.watchAddress)?data.config.watchAddress:null;
  state.programSource=data.program;state.programName=data.programName||'My program';useCompiled(data.compiled,{exampleId:data.exampleId||'cpu'});setSource(data.source);
  if(data.mode==='ooo'){state.ooo=new OoOLab();if(data.game?.architecture)state.ooo.restore(data.game.architecture);state.mode='ooo';state.lab=null;state.sim=null;buildScene();}else if(data.mode==='build'){state.mode='build';rebuildBuilder();}else if(data.view==='cells'){state.view='cells';buildScene();}
  state.guided=!!data.game?.guided;state.builderSource=typeof data.game?.builderNotebook?.text==='string'?data.game.builderNotebook.text:null;state.builderSignature=typeof data.game?.builderNotebook?.signature==='string'?data.game.builderNotebook.signature:null;
  let restored=false;try{restored=restoreExecution(data.game?.execution,{lab:state.lab,sim:state.sim});}catch(error){console.warn(error.message);}
  state.eventCursor=state.lab?.events.length||0;
  if(state.mode==='build'&&Array.isArray(data.game?.builderView?.path)){try{state.builder.getDesign({path:data.game.builderView.path});state.builderPath=[...data.game.builderView.path];state.builderTrail=Array.isArray(data.game.builderView.trail)?data.game.builderView.trail.map(String):[];buildScene();}catch{state.builderPath=[];state.builderTrail=[];buildScene();}}
  if(restored||data.game?.tutorial?.complete)tutorial.restore(data.game?.tutorial);else tutorial.reset();
  world.applyViewSettings(data.game?.viewSettings||{});syncViewControls();state.hasSave=true;$('#continue-button').hidden=false;scheduleSave();
}
function setInput(name,value,builderId){
  stop();state.resumeRunning=false;if(value!==null&&!Number.isInteger(value))throw new Error('Enter a whole unsigned number, or leave blank for unknown.');const sim=activeSim();sim.setInput(name,value);sim.settle();if(builderId)state.builder.setInput(builderId,value);renderLive();scheduleSave();
}
function inspectTarget(){if(state.screen!=='playing')return;world.interactAtCenter();}
function manualStep(kind){if(state.screen==='start')return;stop();step(kind);if(state.screen==='playing')world.canvas?.focus({preventScroll:true});}

// Menus own focus while paused. World interaction only runs in the playing state.
document.addEventListener('click',event=>{
  const level=event.target.closest('[data-builder-level]');if(level){setBuilderLevel(Number(level.dataset.builderLevel));return;}
  const moduleChoice=event.target.closest('[data-module-type]');if(moduleChoice){if(state.mode==='build'&&state.builderPath.length){toast('Return to the root circuit to place components.');return;}const id=moduleChoice.dataset.moduleType;if(state.mode!=='build')enterBuilder();else resumeGame();state.tool=null;setTool(`module:${id}`);toast('Module selected. Aim at the grid and press E to place an independent instance.');return;}
  const partChoice=event.target.closest('[data-build-type]');if(partChoice){if(state.mode==='build'&&state.builderPath.length){toast('Return to the root circuit to place components.');return;}const type=partChoice.dataset.buildType;if(state.mode!=='build')enterBuilder();else resumeGame();state.tool=null;setTool(type);toast(`${BUILDER_TYPES[type].label} selected. Aim at the grid and press E to place it.`);return;}
  const nodeSelect=event.target.closest('[data-select-node]');if(nodeSelect){state.selected=nodeSelect.dataset.selectNode;world.select(state.selected);showWorkbench('inspect');return;}
  const nodeFocus=event.target.closest('[data-focus-node]');if(nodeFocus){state.selected=nodeFocus.dataset.focusNode;world.select(state.selected);resumeGame();world.teleportToNode(state.selected);return;}
  const station=event.target.closest('button[data-station]');if(station){showWorkbench(station.dataset.station);return;}
  const tool=event.target.closest('[data-tool]');if(tool){setTool(tool.dataset.tool||null);return;}
  const address=event.target.closest('[data-address]');if(address){state.memoryAddress=Number(address.dataset.address);renderPanel();observeMemory();return;}
  const action=event.target.closest('[data-action]')?.dataset.action;if(!action)return;
  try{switch(action){
    case 'start-guided':startGame(true);break;case 'start-free':startGame(false);break;case 'continue':startGame(state.guided,{resume:true});break;
    case 'start-ooo':enterArchitecture({fresh:true});break;case 'enter-ooo':enterArchitecture();break;
    case 'architecture':pauseGame('architecture');break;case 'navigator':pauseGame('navigator');break;
    case 'library':pauseGame('library');break;
    case 'create-module':showModuleAuthoring();break;case 'package-module':packageModule();break;
    case 'open-module':openBuilderModule();break;case 'parent-module':setBuilderLevel(state.builderPath.length-1);break;case 'root-module':setBuilderLevel(0);break;
    case 'ooo-program':showOooProgram();break;
    case 'ooo-config':showOooConfig();break;
    case 'apply-ooo-config':{const config=Object.fromEntries([...document.querySelectorAll('[data-config]')].map(e=>[e.dataset.config,Number(e.value)]));const model=new OoOLab({...config,source:state.ooo.programSource});state.ooo=model;state.resumeRunning=false;closeModal();buildScene();renderLive();scheduleSave();toast('Architecture configuration applied.');break;}
    case 'load-ooo-program':state.ooo.loadProgram($('#ooo-assembly').value);state.resumeRunning=false;closeModal();renderLive();scheduleSave();toast('Architecture program loaded.');break;
    case 'reset-view':world.applyViewSettings({layoutScale:1,componentScale:1,partScales:{}});syncViewControls();scheduleSave();break;
    case 'pause':pauseGame();break;case 'resume':resumeGame();break;case 'title':titleScreen();break;
    case 'run':runProcessor();world.canvas?.focus();break;case 'instruction':manualStep('instruction');break;case 'clock':manualStep('clock');break;case 'rewind':rewind();break;case 'reset':resetExecution();break;
    case 'interact':inspectTarget();break;case 'rtl':pauseGame('rtl');break;case 'memory':pauseGame('memory');break;case 'guide':pauseGame('guide');break;
    case 'enter-build':enterBuilder();break;case 'processor':setMode('explore');world.startWalk({reset:true});break;
    case 'tutorial-action':tutorialAction();break;case 'restart-tutorial':startGame(true);break;case 'controls':showControls();break;
    case 'focus':{const id=state.selected;resumeGame();world.teleportToNode(id);break;}
    case 'source':{const node=state.graph.nodes.find(n=>n.id===state.selected),src=String(node?.source||'');showWorkbench('rtl');ensureEditor().then(()=>{const m=src.match(/:(\d+)(?:\.\d+)?/);if(m){const line=editor.state.doc.line(Math.min(Number(m[1]),editor.state.doc.lines));editor.dispatch({selection:{anchor:line.from},effects:EditorViewClass.scrollIntoView(line.from,{y:'center'})});editor.focus();}});break;}
    case 'expand-node':{const node=state.graph.nodes.find(n=>n.id===state.selected);state.scope=node?.cellIds;state.view='cells';buildScene();resumeGame();world.startWalk({reset:true});break;}
    case 'map':resumeGame();world.setMode('orbit');toast('Map view: drag to orbit. Pause and resume to return to flight.');break;
    case 'compile':synthesize();break;case 'program':showProgram();break;case 'check-program':{const a=assemble($('#assembly-source').value);toast(`Valid program · ${a.words.length} instructions.`);break;}
    case 'load-program':{const text=$('#assembly-source').value;state.lab.loadProgram(text);if(text!==PROGRAMS[0].source){state.guided=false;tutorial.stop();renderTutorial();}state.programSource=text;state.programName=PROGRAMS.find(p=>p.id===$('#program-example').value)?.name||'My program';state.eventCursor=0;state.resumeRunning=false;closeModal();showWorkbench('trace');renderLive();scheduleSave();toast('Program loaded. Resume or step it here.');break;}
    case 'close-modal':closeModal();break;case 'validate':validateCpu();break;case 'import':$('#project-file').click();break;case 'export':downloadProject();break;
    case 'watch-memory':state.watchAddress=state.watchAddress===state.memoryAddress?null:state.memoryAddress;renderPanel();toast(state.watchAddress===null?'Memory watch cleared.':`The world will pause when address 0x${hex(state.watchAddress)} is written.`);scheduleSave();break;
    case 'delete':if(state.mode==='build'&&!state.builderPath.length&&state.selected){state.builder.remove(state.selected);state.selected=null;rebuildBuilder();renderInspector();toast('Instance or part removed. Its reusable definition stays in the library.');}break;
    case 'disconnect':{if(state.mode!=='build'||state.builderPath.length)break;const port=event.target.closest('button').dataset.port;state.builder.disconnectInput(state.selected,port);rebuildBuilder();renderInspector();toast('Port disconnected. Its input is now unknown.');break;}
    case 'export-rtl':{const text=state.builder.toVerilog();state.builderSource=text;state.builderSignature=text;showWorkbench('rtl');setSource(text);state.dirty=true;$('#editor-dot').textContent='●';compileStatus('Structural Verilog from your blocks. Synthesize to rebuild this circuit.');break;}
  }}catch(error){toast(error.message,true);}
  if(state.screen==='playing')world.canvas?.focus({preventScroll:true});
});
document.addEventListener('change',event=>{
  const el=event.target;try{
    if(el.matches('[data-module-node]')&&moduleDraft){if(el.checked)moduleDraft.nodeIds.add(el.dataset.moduleNode);else moduleDraft.nodeIds.delete(el.dataset.moduleNode);updateModulePreview();}
    else if(el.matches('[data-input]'))setInput(el.dataset.input,el.value.trim()===''?null:Number(el.value),el.dataset.builderInput);
    else if(el.id==='cpu-input'){const n=Number(el.value);if(!Number.isInteger(n)||n<0||n>255)throw new Error('Input byte must be between 0 and 255.');state.lab.input=n;}
    else if(el.id==='rtl-example'&&el.value!=='custom')loadExample(el.value);
    else if(el.id==='program-example'){const p=PROGRAMS.find(p=>p.id===el.value);if(p)$('#assembly-source').value=p.source;}
    else if(el.id==='ooo-example'){const p=OOO_PROGRAMS.find(p=>p.id===el.value);if(p)$('#ooo-assembly').value=p.source;}
    else if(el.id==='ooo-input'){const n=Number(el.value);if(!Number.isInteger(n)||n<0||n>255)throw new Error('Input byte must be between 0 and 255.');state.ooo.input=n;scheduleSave();}
    else if(el.id==='speed')state.speed=Number(el.value);
    else if(el.id==='cache-enabled'||el.id==='ram-latency'){
      const cache=$('#cache-enabled').checked,latency=Number($('#ram-latency').value);if(!Number.isInteger(latency)||latency<1||latency>100)throw new Error('RAM latency must be from 1 to 100 clocks.');stop();state.resumeRunning=false;state.cache=cache;state.latency=latency;state.lab.cache=cache;state.lab.latency=latency;state.lab.reset();state.eventCursor=0;renderLive();scheduleSave();toast('Memory settings changed. The processor has been reset.');
    }
  }catch(error){toast(error.message,true);}
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.matches('[data-module-port]')&&moduleDraft)moduleDraft.portNames[el.dataset.modulePort]=el.value;
  else if(el.id==='component-scale'||el.id==='layout-scale'){
    if(el.id==='component-scale')world.setComponentScale(Number(el.value));else world.setLayoutScale(Number(el.value));
    syncViewControls();scheduleSave();
  }else if(el.id==='part-scale'&&state.selected){world.setPartScale(state.selected,Number(el.value));$('#part-scale-value').textContent=`${el.value}×`;scheduleSave();}
  else if(el.id==='component-search'){const value=el.value,pos=el.selectionStart;renderNavigator(value);const replacement=$('#component-search');replacement.focus();replacement.setSelectionRange(pos,pos);}
});
$('#project-file').addEventListener('change',async event=>{
  try{const file=event.target.files[0];if(!file)return;if(file.size>8*1024*1024)throw new Error('World files must be smaller than 8 MB.');restoreProject(JSON.parse(await file.text()));closeModal();startGame(state.guided,{resume:true});toast('World loaded. Your circuit and journey are back.');}catch(error){toast(error.message,true);}event.target.value='';
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){
    event.preventDefault();event.stopImmediatePropagation();if($('.modal-backdrop')){closeModal();return;}if(performance.now()<state.ignoreEscapeUntil)return;
    if(state.screen==='playing')pauseGame();else if(state.screen==='paused')resumeGame();return;
  }
  if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&state.screen==='paused'&&state.workbench==='rtl'){event.preventDefault();synthesize();return;}
  if(state.screen!=='playing'||event.target.closest('input,textarea,select,.cm-editor,[contenteditable=true]'))return;
  if(event.code==='Tab'){event.preventDefault();pauseGame('memory');return;}
  if(event.code==='KeyN'){event.preventDefault();pauseGame('navigator');return;}
  if(event.code==='KeyB'){event.preventDefault();pauseGame('library');return;}
  if(event.code==='KeyR'){event.preventDefault();runProcessor();return;}
  if(event.code==='Period'){event.preventDefault();manualStep(event.shiftKey?'clock':'instruction');return;}
  if(/^Digit[1-9]$/.test(event.code)){event.preventDefault();$('#hotbar').children[Number(event.code.at(-1))-1]?.click();}
},{capture:true});
for(const button of document.querySelectorAll('[data-move]')){
  button.addEventListener('pointerdown',event=>{event.preventDefault();if(state.screen==='playing'){world.keys.add(button.dataset.move);button.setPointerCapture(event.pointerId);}});
  const release=()=>world.keys.delete(button.dataset.move);button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);
}
window.addEventListener('blur',()=>{if(state.screen==='playing')pauseGame();});
window.addEventListener('beforeunload',saveNow);
function animate(now){
  const delta=Math.min((now-lastFrame)/1000,.12);lastFrame=now;
  if(state.screen==='playing'&&state.running){clockBudget+=delta*state.speed;let count=0;
    while(clockBudget>=1&&state.running&&count<100){
      if(state.lab&&state.breakpoint!==null&&state.lab.getState().state===0&&state.lab.getState().pc===state.breakpoint&&currentCycle()!==state.breakpointSkipCycle){pauseGame('trace');toast(`Breakpoint at instruction 0x${hex(state.breakpoint)}.`);break;}
      step('clock',false);clockBudget--;count++;
      const e=state.lab?.events.at(-1);if(state.watchAddress!==null&&e?.type==='write'&&e.address===state.watchAddress&&e.cycle===currentCycle()){pauseGame('memory');toast(`Memory saved ${e.value} at address 0x${hex(e.address)}.`);}
      if(currentCycle()>20000){pauseGame('trace');toast('Paused after 20,000 clocks. Inspect the controller or reset it.');}
    }
    if(count)updateSignals();
  }
  if(now-lastHud>120){lastHud=now;renderHud();}
  if(state.screen==='playing'&&state.running&&now-lastExecutionSave>5000){lastExecutionSave=now;saveNow();}
  requestAnimationFrame(animate);
}
async function boot(){
  try{const response=await fetch(`${BASE}examples/cpu.json`);if(!response.ok)throw new Error('The processor could not be loaded.');state.defaultCompiled=await response.json();useCompiled(state.defaultCompiled,{exampleId:'cpu'});
    try{const saved=localStorage.getItem(STORAGE);if(saved)restoreProject(JSON.parse(saved));}catch(error){console.warn('Saved world could not be restored:',error.message);}
    state.ready=true;state.screen='start';state.workbench=null;world.startPanorama();syncScreen();renderHotbar();renderTutorial();$('#title-status').textContent='FLY IN. FOLLOW THE DATA.';document.querySelectorAll('[data-action="start-guided"],[data-action="start-free"],[data-action="start-ooo"]').forEach(b=>b.disabled=false);
    window.siliconTrails={getState:()=>state.mode==='ooo'?state.ooo.getState():state.lab?.getState()||{cycle:currentCycle()},getLab:()=>state.lab,getArchitectureLab:()=>state.ooo,getSimulator:()=>activeSim(),getBuilder:()=>state.builder,getCompiled:()=>state.compiled,getGraph:()=>state.graph,getWorld:()=>world,getGameState:()=>({screen:state.screen,workbench:state.workbench,mode:state.mode,running:state.running,builderPath:[...state.builderPath],tutorial:tutorial.getCurrent(),player:world.getPlayerState()}),startGame,pauseGame,resumeGame,enterArchitecture,setMode,step,loadExample,exportProject:projectData,restoreProject};
    requestAnimationFrame(animate);
  }catch(error){$('#title-status').textContent=error.message;toast(error.message,true);}
}
boot();

function renderRtlIO(){
  const element=$('#rtl-io'),sim=activeSim();element.hidden=!!state.lab||!sim;if(element.hidden)return;
  element.innerHTML=`<span class="io-label">TRY YOUR CIRCUIT</span><div class="generic-io">${Object.entries(sim.module.ports).filter(([n,p])=>p.direction==='input'&&n!==sim.clockInput).map(([n,p])=>`<div class="io-card"><label>IN · ${esc(n)} [${p.bits.length}]</label><input type="number" data-input="${esc(n)}" data-builder-input="${state.mode==='build'?esc(n):''}" min="0" max="${2**p.bits.length-1}" value="${sim.getPort(n)??''}" placeholder="X" aria-label="Input ${esc(n)}" /></div>`).join('')}${Object.entries(sim.module.ports).filter(([,p])=>p.direction==='output').map(([n,p])=>`<div class="io-card output"><label>OUT · ${esc(n)} [${p.bits.length}]</label><strong data-output="${esc(n)}">${sim.getPort(n)??'X'}</strong></div>`).join('')}</div>`;
}
