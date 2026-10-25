import { escapeHtml as esc, hex } from './icons.js';

const cell = value => esc(value === undefined || value === null ? '—' : String(value));
const physical = tag => tag === undefined || tag === null ? '—' : `P${tag}`;
const operand = op => !op ? '—' : `${physical(op.tag)} ${op.ready ? `= ${op.value}` : '· waiting'}`;
function table(headers, rows, {head=false}={}) {
  if(!rows.length)return '<p class="architecture-empty">Empty · step the clock to follow instructions through this unit.</p>';
  return `<div class="architecture-table-wrap"><table class="architecture-table"><thead><tr>${headers.map(h=>`<th>${cell(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r,i)=>`<tr${head&&i===0?' class="arch-head"':''}>${r.map(v=>`<td>${cell(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const section = (id,title,description,body) => `<section class="architecture-section" id="arch-${id}" data-unit="${id}"><h4>${esc(title)}</h4><p>${esc(description)}</p>${body}</section>`;
function describeEvent(e) {
  const fields=Object.entries(e).filter(([k,v])=>!['type','unit','cycle'].includes(k)&&v!==null&&v!==undefined);
  return `C${e.cycle} · ${e.type} · ${e.unit||'pipeline'}${fields.length?' · ':''}${fields.map(([k,v])=>`${k}=${typeof v==='object'?JSON.stringify(v):v}`).join(' · ')}`;
}

/** Render actual model state; these tables never invent queue entries or values. */
export function renderArchitecture(lab,{section:selected=null,compact=false}={}) {
  const s=lab.getState(),config=s.config;
  const sections={};
  sections.frontend=section('frontend','Fetch → decode → dispatch','Two instructions can dispatch each clock. Decode reads the assembly operation and register operands. Dispatch stops when any required resource is full.',
    table(['PC','Next instruction','Status'],lab.program.slice(s.pc,s.pc+4).map((p,i)=>[p.pc,p.text,i<2?'next dispatch window':'following']))+
    `<p class="architecture-caption">PC ${s.pc} · ${s.stats.dispatched} dispatched · ${s.stats.stalls} resource stalls</p>`);
  sections.maps=section('maps','Architectural map / speculative rename map','The architectural map changes at retirement. The rename map changes at dispatch. A younger write gets a fresh physical register, while older readers retain their original source tag.',
    table(['Register','Committed map','Rename map','Committed value','Renamed value'],s.registers.map((value,i)=>{
      const spec=s.physicalRegisters[s.renameMap[i]];
      return [`R${i}`,physical(s.architecturalMap[i]),physical(s.renameMap[i]),value,spec.ready?spec.value:'waiting'];
    })));
  sections.physical=section('physical','Physical register file & free list','Execution writes physical results and marks them ready. Old physical destinations return to the free list when their replacement retires.',
    table(['Physical','Value','Ready','Allocation'],s.physicalRegisters.map(p=>[`P${p.id}`,p.ready?p.value:'—',p.ready?'yes':'waiting',p.id===0?'constant zero':p.free?'free':'allocated']))+
    `<p class="architecture-caption">${s.freeList.length} / ${config.physicalCount} physical registers free</p>`);
  sections.rs=section('rs',`Reservation stations · ${s.reservationStations.length}/${config.rsSize}`,'Instructions wait on physical source tags. A result broadcast wakes dependent entries. The oldest ready entry for each available execution unit issues.',
    table(['ROB','PC','Operation','Source A','Source B','Status'],s.reservationStations.map(r=>[r.robId,r.pc,r.op,operand(r.src1),r.op==='LI'||r.op==='ADDI'?`immediate ${r.imm}`:operand(r.src2),r.status])));
  sections.execution=section('execution','Execution & result broadcast','The ALU takes one clock; multiply uses a separate non-pipelined unit. Ready younger work can finish first. Completion updates its ROB entry and physical register, then wakes consumers.',
    table(['Unit','ROB','PC / operation','Value','Completion clock'],Object.entries(s.units).map(([unit,u])=>[unit.toUpperCase(),u?.robId??'idle',u?`${u.pc} · ${u.op}`:'—',u?.value,u?.doneAt])));
  sections.lsq=section('lsq',`Load / store queue · ${s.lsq.length}/${config.lsqSize}`,'A load waits for all older store addresses to be known. It forwards from the youngest matching older store once its data is ready. Stores change memory only at in-order retirement.',
    table(['ROB','PC / operation','Address','Data / value','Base','Status','Forwarded from'],s.lsq.map(q=>[q.robId,`${q.pc} · ${q.op}`,q.address===null?'unknown':`0x${hex(q.address)}`,q.op==='STORE'?operand(q.data):q.done?q.value:'waiting',operand(q.base),q.status,q.forwardedFrom?`ROB ${q.forwardedFrom}`:'—'])));
  sections.rob=section('rob',`Reorder buffer · ${s.rob.length}/${config.robSize}`,'Entries allocate in program order and can finish out of order. At most two ready entries retire from the head per clock. A completed younger instruction waits behind an unfinished older one.',
    table(['ROB','PC','Instruction','Destination','Status','Result','Done at'],s.rob.map(r=>[r.id,r.pc,r.text,r.dest===null?'—':`R${r.dest} → P${r.physDest}`,r.ready?'complete':'pending',r.ready?r.value:'—',r.completedAt]),{head:true}));
  sections.commit=section('commit','Architectural state & retirement','Only committed values appear here. The trace records retirement order rather than execution completion order.',
    `<div class="ooo-registers">${s.registers.map((v,i)=>`<span>R${i}<strong>${v}</strong></span>`).join('')}</div>`+
    table(['Retired at','PC','Instruction','Value'],lab.trace.slice(-24).reverse().map(r=>[r.cycle,r.pc,r.text||r.instruction||r.op,r.value])));
  const writes=lab.trace.filter(e=>e.memory&&!e.memory.ignored);
  const written=new Set(writes.map(e=>e.memory.address));
  const addresses=[...new Set([0x40,0xFE,0xFF,...written])].sort((a,b)=>a-b);
  sections.memory=section('memory','Memory & devices','Byte-addressed abstract RAM. Address FE drives the output display; FF reads the input device. A pending store is visible in the LSQ before it becomes a committed byte.',
    table(['Address','Saved byte','Role'],addresses.map(a=>[`0x${hex(a)}`,a===0xFE?lab.display:a===0xFF?lab.input:lab.ram[a],a===0xFE?'output device':a===0xFF?'input device':'RAM']))+
    `<p class="architecture-caption">${s.stats.forwarded} forwarded load${s.stats.forwarded===1?'':'s'} · output ${s.display}</p><label class="ooo-device-input">Input device FF <input id="ooo-input" aria-label="Architecture input device" type="number" min="0" max="255" value="${lab.input}" /></label>`);
  sections.events=section('events','What happened this clock','These events come from dispatch, issue, completion, forwarding, and retirement in the simulation.',
    s.lastEvents.length?s.lastEvents.map(e=>`<div class="architecture-event${e.type.includes('stall')?' architecture-stall':''}">${esc(describeEvent(e))}</div>`).join(''):'<p class="architecture-empty">No clock has run yet.</p>');
  const unit=String(selected||'').replace('ooo:','');
  const aliases={fetch:'frontend',decode:'frontend',dispatch:'frontend',rename:'maps','arch-map':'maps','architectural-map':'maps',rat:'maps',prf:'physical',alu:'execution',mul:'execution',lsu:'lsq',broadcast:'execution',retire:'commit'};
  const key=aliases[unit]||unit;
  const content=compact&&sections[key]?sections[key]+(key!=='events'?sections.events:''):Object.values(sections).join('');
  return `${compact?'':`<div class="architecture-intro"><p><strong>Out-of-order architecture lab</strong> · 8 architectural registers, ${config.physicalCount} physical registers, two-wide dispatch and retirement.</p><p>A cycle-based teaching model. Build sandbox and Verilog synthesis are separate hardware modes. This model has no branches, branch recovery, exceptions, or cache coherence.</p></div><div class="architecture-controls"><button class="btn primary" data-action="clock" aria-label="Step architecture clock">Step clock</button><button class="btn" data-action="instruction" aria-label="Step architecture retirement">Next retirement</button><button class="btn" data-action="rewind">Rewind</button><button class="btn" data-action="reset">Reset</button><button class="btn" data-action="ooo-program">Edit program</button><button class="btn" data-action="ooo-config">Configure units</button><span class="cycle-label">C${s.cycle} · ${s.halted?'HALTED':`${s.stats.committed} retired`}</span></div>`}<div class="architecture-grid">${content}</div>${compact?'':'<p class="architecture-caption">Fly to any unit with the component navigator (N). Inspect it with E. Pulse highlights indicate logical transfers; wire length does not add latency.</p>'}`;
}
