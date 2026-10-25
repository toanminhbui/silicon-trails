import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Tutorial} from '../src/game/tutorial.js';
import {CpuLab} from '../src/core/cpu-lab.js';

const walkAndInspect = tutorial => {
  tutorial.observe({type:'move',distance:3});
  tutorial.observe({type:'inspect',id:'overview:a'});
};
const arithmetic = tutorial => tutorial.observe({type:'step',cpu:{a:12},retired:2});
const store = tutorial => tutorial.observe({type:'memory-write',address:0x40,value:12});
const inspectMemory = tutorial => tutorial.observe({type:'memory-inspect',address:0x40,value:12});

test('walking requires real positive movement and later milestones do not bypass the current step',() => {
  const tutorial = new Tutorial();
  assert.equal(tutorial.getCurrent().active,false);
  tutorial.observe({type:'move',distance:9});
  assert.equal(tutorial.snapshot().milestones.distance,0,'stopped tutorials ignore events');
  tutorial.start();
  tutorial.observe({type:'inspect',id:'overview:a'});
  for (const distance of [0,-4,NaN,Infinity,'3']) tutorial.observe({type:'move',distance});
  tutorial.observe({type:'next'});
  tutorial.observe({type:'action',action:'walk'});
  assert.equal(tutorial.getCurrent().id,'walk');
  tutorial.observe({type:'move',distance:1.25});
  assert.equal(tutorial.getCurrent().id,'walk');
  tutorial.observe({type:'move',distance:1.75});
  assert.equal(tutorial.getCurrent().id,'run-instructions','the earlier real inspection was remembered');
});

test('inspection, execution and memory steps require the correct observed evidence',() => {
  const tutorial = new Tutorial(); tutorial.start();
  tutorial.observe({type:'move',totalDistance:1});
  tutorial.observe({type:'move',totalDistance:1});
  assert.equal(tutorial.getCurrent().id,'walk','a cumulative movement reading is not added twice');
  tutorial.observe({type:'move',totalDistance:3});
  tutorial.observe({type:'inspect',id:'overview:ir'});
  assert.equal(tutorial.getCurrent().id,'inspect-accumulator');
  tutorial.observe({type:'inspect',id:'overview:a'});
  tutorial.observe({type:'step',retired:2});
  tutorial.observe({type:'step',cpu:{a:7},retired:1});
  assert.equal(tutorial.getCurrent().id,'run-instructions');
  arithmetic(tutorial);
  for (const event of [
    {type:'memory-read',address:0x40,value:12},
    {type:'memory-request',address:0x40,value:12,write:true},
    {type:'memory-write',address:0x41,value:12},
    {type:'memory-write',address:0x40,value:11},
    {type:'memory-write',address:'0x40',value:12},
  ]) tutorial.observe(event);
  assert.equal(tutorial.getCurrent().id,'save-value');
  store(tutorial);
  tutorial.observe({type:'memory-inspect',address:0x40,value:0});
  tutorial.observe({type:'memory-inspect',address:0x41,value:12});
  assert.equal(tutorial.getCurrent().id,'inspect-memory');
  inspectMemory(tutorial);
  assert.equal(tutorial.getCurrent().id,'open-rtl');
});

test('actual CPU retirement and acknowledged memory events complete the arithmetic and storage milestones',() => {
  const compiled = JSON.parse(readFileSync(new URL('../public/examples/cpu.json',import.meta.url),'utf8'));
  const lab = new CpuLab(compiled.netlist,{latency:5});
  lab.loadProgram('LDI 7\nADDI 5\nSTORE 0x40\nHALT');
  const tutorial = new Tutorial(); tutorial.start(); walkAndInspect(tutorial);
  lab.stepInstruction();
  tutorial.observe({type:'step',cpu:lab.getState(),retired:lab.trace.length});
  assert.equal(tutorial.getCurrent().id,'run-instructions');
  lab.stepInstruction();
  tutorial.observe({type:'step',cpu:lab.getState(),retired:lab.trace.length});
  assert.equal(tutorial.getCurrent().id,'save-value');
  while (!lab.pending) lab.stepClock();
  assert.equal(lab.ram[0x40],0);
  for (const event of lab.events) if (event.type === 'write') tutorial.observe({...event,type:'memory-write'});
  assert.equal(tutorial.getCurrent().id,'save-value');
  lab.stepInstruction();
  const event = lab.events.find(event => event.type === 'write');
  assert.ok(event);
  tutorial.observe({...event,type:'memory-write'});
  assert.equal(lab.ram[0x40],12);
  assert.equal(tutorial.getCurrent().id,'inspect-memory');
  tutorial.observe({type:'memory-inspect',address:0x40,value:lab.ram[0x40]});
  assert.equal(tutorial.getCurrent().id,'open-rtl');
});

test('events observed early are retained and completion fires once without a Next button',() => {
  let completions = 0;
  const changes = [];
  const tutorial = new Tutorial({onChange:current => changes.push(current.id),onComplete:current => {assert.equal(current.complete,true); completions++;}});
  tutorial.start();
  arithmetic(tutorial); store(tutorial); inspectMemory(tutorial);
  tutorial.observe({type:'open-rtl'});
  assert.equal(tutorial.getCurrent().id,'walk');
  walkAndInspect(tutorial);
  assert.equal(tutorial.complete,true);
  assert.equal(tutorial.active,false);
  assert.equal(tutorial.getCurrent().index,6);
  assert.equal(completions,1);
  tutorial.observe({type:'open-rtl'}); tutorial.start();
  assert.equal(completions,1);
  assert.equal(changes.at(-1),'complete');
});

test('stop and start preserve progress while reset makes a fresh tutorial',() => {
  const tutorial = new Tutorial(); tutorial.start(); walkAndInspect(tutorial);
  tutorial.stop(); arithmetic(tutorial);
  assert.equal(tutorial.getCurrent().id,'run-instructions');
  tutorial.start(); arithmetic(tutorial);
  assert.equal(tutorial.getCurrent().id,'save-value');
  tutorial.reset();
  assert.equal(tutorial.active,false);
  assert.equal(tutorial.getCurrent().id,'walk');
  assert.equal(tutorial.snapshot().milestones.storedResult,false);
});

test('versioned snapshots restore detached progress and reject invalid or contradictory state',() => {
  const tutorial = new Tutorial(); tutorial.start(); walkAndInspect(tutorial); store(tutorial);
  const snapshot = tutorial.snapshot();
  const restored = new Tutorial();
  assert.equal(restored.restore(JSON.parse(JSON.stringify(snapshot))),true);
  assert.deepEqual(restored.snapshot(),snapshot);
  snapshot.milestones.storedResult = false;
  assert.equal(restored.snapshot().milestones.storedResult,true,'snapshots do not share mutable milestones');
  arithmetic(restored);
  assert.equal(restored.getCurrent().id,'inspect-memory','restored early STORE is retained');
  const invalid = [null,[],{}, {...restored.snapshot(),version:2}, {...restored.snapshot(),index:6}, {...restored.snapshot(),milestones:{...restored.snapshot().milestones,distance:Infinity}}, {...restored.snapshot(),milestones:{...restored.snapshot().milestones,storedResult:'true'}}];
  for (const data of invalid) {
    assert.equal(restored.restore(data),false);
    assert.equal(restored.getCurrent().id,'walk');
    assert.equal(restored.active,false);
  }
});

test('restoring a finished tutorial does not trigger completion again',() => {
  const original = new Tutorial(); original.start(); walkAndInspect(original); arithmetic(original); store(original); inspectMemory(original); original.observe({type:'open-rtl'});
  let completions = 0;
  const restored = new Tutorial({onComplete:() => completions++});
  assert.equal(restored.restore(original.snapshot()),true);
  restored.start(); restored.observe({type:'open-rtl'});
  assert.equal(restored.complete,true);
  assert.equal(completions,0);
  assert.equal(restored.restore({...original.snapshot(),active:true}),false);
});
