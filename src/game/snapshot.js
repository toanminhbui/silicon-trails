import {CircuitSimulator} from '../core/simulator.js';

const VERSION = 1;
const LOG_LIMIT = 1024;
const SIZE_LIMIT = 500 * 1024;
const CACHE_RESULTS = new Set(['hit','miss','bypass','disabled']);
const fingerprints = new WeakMap();
const fail = message => { throw new Error(`Saved execution cannot be restored: ${message}`); };
const check = (condition,message) => { if (!condition) fail(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value,min = 0,max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const byte = value => integer(value,0,255);
const nullableInteger = (value,max) => value === null || integer(value,0,max);
const copy = value => JSON.parse(JSON.stringify(value));

function fingerprint(sim) {
  let byTop = fingerprints.get(sim.netlist);
  if (!byTop) { byTop = new Map(); fingerprints.set(sim.netlist,byTop); }
  if (!byTop.has(sim.top)) {
    const text = JSON.stringify(sim.netlist.modules[sim.top]);
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64,(hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
    byTop.set(sim.top,hash.toString(16).padStart(16,'0'));
  }
  return byTop.get(sim.top);
}

function checkSize(snapshot) {
  let text;
  try { text = JSON.stringify(snapshot); }
  catch { fail('the snapshot must contain JSON data without circular references.'); }
  check(typeof text === 'string' && new TextEncoder().encode(text).length <= SIZE_LIMIT,'the snapshot exceeds the 500 KiB save limit.');
}

function validateCircuit(data,sim) {
  check(object(data) && integer(data.cycle),'the circuit clock is invalid.');
  const validateEntries = (entries,expected,label) => {
    check(Array.isArray(entries) && entries.length === expected.size,`${label} do not match this circuit.`);
    const seen = new Set();
    return entries.map(entry => {
      check(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string',`${label} contain an invalid entry.`);
      const [name,bits] = entry;
      check(!seen.has(name) && expected.has(name),`${label} contain an unknown or repeated name ${name}.`);
      seen.add(name);
      check(Array.isArray(bits) && bits.length === expected.get(name) && bits.every(bit => bit === 0 || bit === 1 || bit === null),`${label} have invalid bits for ${name}.`);
      return [name,[...bits]];
    });
  };
  const inputs = new Map(Object.entries(sim.module.ports).filter(([,port]) => port.direction === 'input').map(([name,port]) => [name,port.bits.length]));
  const registers = new Map(sim.sequential.map(cell => [cell.id,cell.connections.Q.length]));
  return {cycle:data.cycle,inputs:validateEntries(data.inputs,inputs,'Circuit inputs'),registers:validateEntries(data.registers,registers,'Circuit registers')};
}

function validateEvent(event,cycle,transactionId) {
  check(object(event) && ['request','read','write'].includes(event.type),'the memory event type is invalid.');
  check(integer(event.cycle,0,cycle) && byte(event.address) && byte(event.value),'a memory event has an invalid clock, address, or byte.');
  check(integer(event.id,1,transactionId) && CACHE_RESULTS.has(event.cache),'a memory event has an invalid transaction or cache result.');
  const clean = {cycle:event.cycle,type:event.type,address:event.address,value:event.value,cache:event.cache,id:event.id};
  if (event.type === 'request') {
    check(typeof event.write === 'boolean' && integer(event.latency,1,1000),'a memory request has invalid timing or operation.');
    clean.write = event.write; clean.latency = event.latency;
  } else {
    check(typeof event.ignored === 'boolean','a memory completion has an invalid ignored flag.');
    clean.ignored = event.ignored;
  }
  return clean;
}

function validateCpu(snapshot,lab,cycle) {
  check(typeof snapshot.programSource === 'string' && snapshot.programSource === lab.programSource,'the saved program differs from the loaded program.');
  check(Array.isArray(snapshot.ram) && snapshot.ram.length === 256 && snapshot.ram.every(byte),'RAM must contain exactly 256 valid bytes.');
  check(byte(snapshot.display) && byte(snapshot.input),'the saved input or display byte is invalid.');
  check(integer(snapshot.latency,1,1000) && typeof snapshot.cache === 'boolean','the memory settings are invalid.');
  check(integer(snapshot.transactionId),'the transaction counter is invalid.');
  const stats = snapshot.cacheStats;
  check(object(stats) && ['hits','misses','reads','writes'].every(key => integer(stats[key])),'the cache counters are invalid.');
  check(stats.hits + stats.misses <= stats.reads && stats.reads + stats.writes === snapshot.transactionId,'the cache counters do not match the transaction counter.');
  check(Array.isArray(snapshot.cacheLines) && snapshot.cacheLines.length === 4,'the cache must contain exactly four lines.');
  const cacheLines = snapshot.cacheLines.map(line => {
    check(object(line) && typeof line.valid === 'boolean' && integer(line.tag,0,15) && Array.isArray(line.data) && line.data.length === 4 && line.data.every(byte),'a cache line has an invalid tag or byte.');
    return {valid:line.valid,tag:line.tag,data:new Uint8Array(line.data)};
  });
  let pending = null;
  if (snapshot.pending !== null) {
    const item = snapshot.pending;
    check(object(item) && integer(item.id,1,snapshot.transactionId) && typeof item.write === 'boolean' && byte(item.address) && byte(item.value) && byte(item.responseData),'the pending memory transaction is invalid.');
    check(integer(item.latency,1,1000) && integer(item.remaining,0,item.latency - 1) && integer(item.acceptedAt,0,cycle) && CACHE_RESULTS.has(item.cache),'the pending memory timing is invalid.');
    pending = {id:item.id,address:item.address,write:item.write,value:item.value,responseData:item.responseData,remaining:item.remaining,latency:item.latency,cache:item.cache,acceptedAt:item.acceptedAt};
  }
  check(Array.isArray(snapshot.events) && snapshot.events.length <= LOG_LIMIT,'the memory event log is invalid or too long.');
  const events = snapshot.events.map(event => validateEvent(event,cycle,snapshot.transactionId));
  check(events.every((event,i) => i === 0 || event.cycle >= events[i-1].cycle),'memory events are out of clock order.');
  check(Array.isArray(snapshot.trace) && snapshot.trace.length <= LOG_LIMIT,'the instruction trace is invalid or too long.');
  const trace = snapshot.trace.map(row => {
    check(object(row) && integer(row.cycle,0,cycle) && nullableInteger(row.pc,255) && nullableInteger(row.word,65535) && nullableInteger(row.a,255) && nullableInteger(row.nextPc,255) && nullableInteger(row.z,1) && nullableInteger(row.c,1),'an instruction trace row has invalid state.');
    check(typeof row.instruction === 'string' && row.instruction.length <= 100,'an instruction trace label is invalid.');
    const memory = row.memory === null ? null : validateEvent(row.memory,cycle,snapshot.transactionId);
    check(!memory || memory.type !== 'request','an instruction cannot retire with an uncompleted memory request.');
    return {cycle:row.cycle,pc:row.pc,word:row.word,instruction:row.instruction,a:row.a,nextPc:row.nextPc,z:row.z,c:row.c,memory};
  });
  check(trace.every((row,i) => i === 0 || row.cycle >= trace[i-1].cycle),'instruction trace rows are out of clock order.');
  return {ram:new Uint8Array(snapshot.ram),display:snapshot.display,input:snapshot.input,pending,events,trace,transactionId:snapshot.transactionId,cacheStats:{hits:stats.hits,misses:stats.misses,reads:stats.reads,writes:stats.writes},cacheLines,latency:snapshot.latency,cache:snapshot.cache};
}

/** Save live machine state without the potentially large rewind history. */
export function captureExecution({lab = null,sim = null} = {}) {
  const circuit = lab?.sim || sim;
  if (!circuit) return null;
  const result = {version:VERSION,kind:lab ? 'cpu' : 'circuit',top:circuit.top,fingerprint:fingerprint(circuit),sim:circuit.snapshot()};
  if (lab) Object.assign(result,{
    programSource:lab.programSource,ram:[...lab.ram],display:lab.display,input:lab.input,
    pending:lab.pending ? {...lab.pending} : null,events:copy(lab.events.slice(-LOG_LIMIT)),trace:copy(lab.trace.slice(-LOG_LIMIT)),
    transactionId:lab.transactionId,cacheStats:{...lab.cacheStats},cacheLines:lab.cacheLines.map(line => ({valid:line.valid,tag:line.tag,data:[...line.data]})),latency:lab.latency,cache:lab.cache,
  });
  checkSize(result);
  return result;
}

/** Validate completely against a throwaway circuit before changing live state. */
export function restoreExecution(snapshot,{lab = null,sim = null} = {}) {
  if (snapshot === null || snapshot === undefined) return false;
  const circuit = lab?.sim || sim;
  check(circuit,'there is no loaded circuit.');
  checkSize(snapshot);
  check(object(snapshot) && snapshot.version === VERSION,'the snapshot version is unsupported.');
  check(snapshot.kind === (lab ? 'cpu' : 'circuit'),'the snapshot belongs to a different kind of machine.');
  check(snapshot.top === circuit.top && snapshot.fingerprint === fingerprint(circuit),'the saved circuit differs from the loaded circuit.');
  const verifier = new CircuitSimulator(circuit.netlist,{top:circuit.top});
  const savedCircuit = validateCircuit(snapshot.sim,verifier);
  const savedCpu = lab ? validateCpu(snapshot,lab,savedCircuit.cycle) : null;
  try { verifier.restore(savedCircuit); }
  catch (error) { fail(`the saved circuit state is invalid (${error.message}).`); }
  // Nothing above this point mutates the live simulator or memory.
  circuit.restore(savedCircuit);
  if (lab) {
    lab.ram.set(savedCpu.ram);
    for (const key of ['display','input','pending','events','trace','transactionId','cacheStats','cacheLines','latency','cache']) lab[key] = savedCpu[key];
    lab.history = [];
    lab._drive();
  }
  return true;
}
