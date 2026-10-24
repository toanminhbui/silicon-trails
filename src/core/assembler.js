export const OPCODES = Object.freeze({NOP:0, LDI:1, LOAD:2, STORE:3, ADD:4, ADDI:5, SUBI:6, JMP:7, JZ:8, JNZ:9, HALT:255});
const names = Object.fromEntries(Object.entries(OPCODES).map(([name, value]) => [value, name]));
const noOperand = new Set(['NOP', 'HALT']);

export function assemble(text) {
  const labels = new Map(), records = [];
  for (const [index, original] of String(text).split(/\r?\n/).entries()) {
    let line = original.replace(/;.*/, '').trim();
    while (/^[A-Za-z_]\w*:/.test(line)) {
      const [, name, rest] = line.match(/^([A-Za-z_]\w*):\s*(.*)$/);
      const key = name.toUpperCase();
      if (labels.has(key)) throw new Error(`Line ${index + 1}: duplicate label ${name}`);
      labels.set(key, records.length); line = rest.trim();
    }
    if (!line) continue;
    if (records.length >= 256) throw new Error(`Line ${index + 1}: program exceeds 256 instructions`);
    records.push({line:index + 1, address:records.length, source:original.trim(), text:line});
  }
  const listing = records.map(record => {
    const tokens = record.text.split(/[\s,]+/).filter(Boolean);
    const op = tokens[0].toUpperCase();
    if (!(op in OPCODES)) throw new Error(`Line ${record.line}: unknown instruction ${tokens[0]}`);
    const expected = noOperand.has(op) ? 1 : 2;
    if (tokens.length !== expected) throw new Error(`Line ${record.line}: ${op} expects ${expected - 1} operand(s)`);
    let operand = 0;
    if (expected === 2) {
      const token = tokens[1];
      if (labels.has(token.toUpperCase())) operand = labels.get(token.toUpperCase());
      else if (/^(?:0x[0-9a-f]+|\d+)$/i.test(token)) operand = Number(token);
      else throw new Error(`Line ${record.line}: unknown label or invalid number ${token}`);
      if (!Number.isInteger(operand) || operand < 0 || operand > 255) throw new Error(`Line ${record.line}: operand must be between 0 and 255`);
    }
    return {...record, opcode:OPCODES[op], operand, word:(OPCODES[op] << 8) | operand, instruction:op};
  });
  return {words:listing.map(row => row.word), listing};
}

export function disassemble(word) {
  if (!Number.isInteger(word) || word < 0 || word > 65535) return '????';
  const op = names[word >>> 8];
  if (!op) return `.word 0x${word.toString(16).padStart(4, '0')}`;
  return noOperand.has(op) ? op : `${op} 0x${(word & 255).toString(16).padStart(2, '0').toUpperCase()}`;
}

export const PROGRAMS = [
  {id:'sum', name:'Save 7 + 5', description:'Add two numbers, save 12 in RAM[40], and send it to the numeric display.', source:'LDI 7\nADDI 5\nSTORE 0x40\nSTORE 0xFE\nHALT'},
  {id:'loop', name:'Sum 1 through 10', description:'A real loop reads and updates two RAM locations. Expected result: 55.', source:'LDI 0\nSTORE 0x40 ; SUM\nLDI 10\nSTORE 0x41 ; N\nloop:\nLOAD 0x40\nADD 0x41\nSTORE 0x40\nLOAD 0x41\nSUBI 1\nSTORE 0x41\nJNZ loop\nLOAD 0x40\nSTORE 0xFE\nHALT'},
  {id:'cache', name:'Cache locality', description:'Read neighboring bytes repeatedly and compare the same program with the cache on and off.', source:'LDI 3\nSTORE 0x40\nLDI 9\nSTORE 0x41\nLOAD 0x40\nADD 0x41\nLOAD 0x40\nADD 0x41\nLOAD 0x40\nADD 0x41\nSTORE 0xFE\nHALT'},
  {id:'input', name:'Read the input port', description:'Read byte FF, add one, and write byte FE to the display.', source:'LOAD 0xFF\nADDI 1\nSTORE 0xFE\nHALT'}
];
