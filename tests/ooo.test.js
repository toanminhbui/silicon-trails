import test from 'node:test';
import assert from 'node:assert/strict';
import {OoOLab,OOO_PROGRAMS} from '../src/core/ooo-lab.js';

function run(lab,limit = 2000) {
  for (let i = 0; i < limit && !lab.halted; i++) lab.stepClock();
  assert.equal(lab.halted,true,'model should finish without deadlock');
  return lab.getState();
}

test('default model executes younger work early, renames WAW, forwards before stores commit, and retires in order',() => {
  const lab = new OoOLab();
  for (let i = 0; i < 6; i++) lab.stepClock();
  const middle = lab.getState();
  assert.notEqual(middle.architecturalMap[1],middle.renameMap[1]);
  assert.equal(middle.registers[1],3,'the committed map still describes the older R1');
  assert.equal(middle.physicalRegisters[middle.renameMap[1]].value,7,'younger R1 is ready in a different physical register');
  assert.equal(lab.ram[0x40],0,'a prepared store cannot alter memory before retirement');
  assert.equal(lab.stats.forwarded,1);
  const result = run(lab);
  assert.deepEqual(result.registers,[0,7,4,12,11,11,23,0]);
  assert.equal(result.display,23);
  assert.equal(result.cycle,13);
  const complete = pc => lab.events.find(event => event.type==='complete'&&event.pc===pc);
  assert.ok(complete(4).cycle < complete(2).cycle,'younger ADD completes before older MUL');
  assert.deepEqual(lab.trace.map(row=>row.pc),Array.from({length:10},(_,i)=>i));
  const forwarded = lab.events.find(event=>event.type==='forward');
  const written = lab.events.find(event=>event.type==='memory-write'&&event.address===0x40);
  assert.ok(forwarded.cycle < written.cycle);
  assert.equal(forwarded.value,11);
  assert.equal(lab.ram[0x40],11);
  assert.deepEqual(result.architecturalMap,result.renameMap);
  assert.equal(new Set(result.freeList).size,16);
});

test('same-bundle RAW and later WAR/WAW dependencies use captured physical source tags',() => {
  const lab = new OoOLab({mulLatency:8,source:'LI R1, 3\nADD R2, R1, R1\nMUL R3, R1, R1\nLI R1, 9\nADD R4, R1, R2\nHALT'});
  lab.stepClock();
  const state = lab.getState();
  const add = state.rs.find(entry=>entry.pc===1);
  assert.equal(add.src1.tag,state.renameMap[1]);
  assert.equal(add.src1.ready,false,'same-bundle consumer waits for the new producer');
  const result = run(lab);
  assert.equal(result.registers[1],9);
  assert.equal(result.registers[2],6);
  assert.equal(result.registers[3],9,'older multiply uses old R1 rather than the younger overwrite');
  assert.equal(result.registers[4],15);
});

test('loads wait for unknown older store addresses instead of reading stale RAM',() => {
  const lab = new OoOLab({source:OOO_PROGRAMS.find(program=>program.id==='store-order').source});
  const result = run(lab);
  assert.equal(result.registers[5],21);
  assert.equal(result.display,21);
  assert.ok(lab.events.some(event=>event.type==='load-stall'&&event.reason==='older-store-address'));
  assert.equal(lab.ram[0x40],21);
});

test('known nonaliasing stores allow loads past pending data, while matching loads wait and forward',() => {
  const lab = new OoOLab({mulLatency:9,source:'LI R1, 2\nLI R2, 3\nMUL R3, R1, R2\nSTORE R3, [0x40]\nLOAD R4, [0x41]\nLOAD R5, [0x40]\nHALT'});
  lab.ram[0x41] = 99;
  const result = run(lab);
  assert.equal(result.registers[4],99);
  assert.equal(result.registers[5],6);
  const bypass = lab.events.find(event=>event.type==='issue'&&event.op==='LOAD'&&event.pc===4);
  const storeReady = lab.events.find(event=>event.type==='store-ready');
  assert.ok(bypass.cycle < storeReady.cycle,'a nonmatching load bypasses an older store waiting for data');
  assert.ok(lab.events.some(event=>event.type==='load-stall'&&event.reason==='older-store-data'));
  assert.ok(lab.events.some(event=>event.type==='forward'&&event.value===6));
});

test('a load forwards from the youngest matching older store and memory writes retain program order',() => {
  const lab = new OoOLab({mulLatency:15,source:'MUL R7, R0, R0\nLI R1, 1\nSTORE R1, [0x40]\nLI R1, 2\nSTORE R1, [0x40]\nLOAD R2, [0x40]\nHALT'});
  while (!lab.events.some(event=>event.type==='forward')) lab.stepClock();
  const forwarding = lab.events.find(event=>event.type==='forward');
  assert.equal(forwarding.storeId,5);
  assert.equal(forwarding.value,2);
  assert.equal(lab.ram[0x40],0);
  assert.equal(run(lab).registers[2],2);
  assert.deepEqual(lab.events.filter(event=>event.type==='memory-write').map(event=>event.value),[1,2]);
});

test('finite ROB, RS, LSQ and physical registers apply backpressure without skipping instructions',() => {
  const lab = new OoOLab({robSize:2,rsSize:1,lsqSize:1,physicalCount:9});
  for (let cycle = 0; cycle < 500 && !lab.halted; cycle++) {
    lab.stepClock();
    const state = lab.getState();
    assert.ok(state.rob.length<=2&&state.rs.length<=1&&state.lsq.length<=1);
    assert.equal(new Set(state.freeList).size,state.freeList.length);
    assert.ok(state.renameMap.every(tag=>!state.freeList.includes(tag)));
  }
  assert.equal(lab.halted,true);
  assert.equal(lab.display,23);
  assert.ok(lab.stats.stalls>0);
  assert.equal(lab.trace.length,10);
});

test('random straight-line arithmetic and memory programs match an independent sequential reference',() => {
  let seed = 9381;
  const random = max => {seed = (seed*1664525+1013904223)>>>0;return seed%max;};
  for (let trial = 0; trial < 5; trial++) {
    const registers = Array(8).fill(0),ram = new Uint8Array(256),source = [];
    for (let i = 0; i < 35; i++) {
      const dest = 1+random(7),left=random(8),right=random(8),value=random(256),address=random(16),op=random(7);
      if(op===0){source.push(`LI R${dest}, ${value}`);registers[dest]=value;}
      if(op===1){source.push(`ADD R${dest}, R${left}, R${right}`);registers[dest]=(registers[left]+registers[right])&255;}
      if(op===2){source.push(`SUB R${dest}, R${left}, R${right}`);registers[dest]=(registers[left]-registers[right])&255;}
      if(op===3){source.push(`MUL R${dest}, R${left}, R${right}`);registers[dest]=(registers[left]*registers[right])&255;}
      if(op===4){source.push(`STORE R${left}, [${address}]`);ram[address]=registers[left];}
      if(op===5){source.push(`LOAD R${dest}, [${address}]`);registers[dest]=ram[address];}
      if(op===6){source.push(`ADDI R${dest}, R${left}, ${value}`);registers[dest]=(registers[left]+value)&255;}
    }
    source.push('HALT');
    const lab = new OoOLab({physicalCount:13,robSize:5,rsSize:3,lsqSize:3,source:source.join('\n')});
    assert.deepEqual(run(lab).registers,registers);
    assert.deepEqual([...lab.ram],[...ram]);
    assert.deepEqual(lab.trace.map(entry=>entry.pc),Array.from({length:36},(_,i)=>i));
  }
});

test('snapshots, cold restore and rewind preserve in-flight units, maps and store forwarding',() => {
  const lab = new OoOLab();for(let i=0;i<6;i++)lab.stepClock();
  const before = lab.snapshot();lab.stepClock();const after = lab.snapshot();lab.rewind();
  assert.deepEqual(lab.snapshot(),before);
  lab.stepClock();assert.deepEqual(lab.snapshot(),after);
  const restored = new OoOLab({source:'HALT'});restored.restore(JSON.parse(JSON.stringify(before)));
  assert.deepEqual(restored.snapshot(),before);
  run(lab);run(restored);assert.deepEqual(restored.snapshot(),lab.snapshot());
  const corrupt = restored.snapshot();corrupt.state.ram[0]=256;
  const unchanged=restored.snapshot();assert.throws(()=>restored.restore(corrupt),/memory/);
  assert.deepEqual(restored.snapshot(),unchanged);
});

test('assembly and capacities reject unsupported or malformed configurations without replacing a valid program',() => {
  const lab = new OoOLab(),before=lab.snapshot();
  for(const source of ['LI R0, 1','LI R8, 1','ADD R1, R2','LOAD R1, [R2 + 999]','BRANCH R1','', 'LI R1, NaN'])assert.throws(()=>lab.loadProgram(source));
  assert.deepEqual(lab.snapshot(),before);
  for(const options of [{physicalCount:8},{robSize:0},{lsqSize:Infinity},{rsSize:1.5},{mulLatency:0}])assert.throws(()=>new OoOLab(options));
});
