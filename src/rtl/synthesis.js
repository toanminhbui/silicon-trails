import { CircuitSimulator } from '../core/simulator.js';

// Shared between the browser worker and Node fixture/test generation.
// No simulation or instruction execution occurs here: this is real Yosys RTL synthesis.
export async function synthesizeWith(runYosys, source, { top = 'top', onProgress } = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Enter a Verilog module before compiling.');
  if (source.length > 262144) throw new Error('This workshop supports Verilog sources up to 256 KiB.');
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(top)) throw new Error('Top module must be a simple Verilog identifier, for example top.');
  const decoder = new TextDecoder();
  let log = '';
  const capture = bytes => {
    if (bytes) log += decoder.decode(bytes, { stream: true });
  };
  const script = [
    'read_verilog -sv -noautowire design.v',
    `hierarchy -check -top ${top}`,
    'proc',
    'opt',
    'write_json hierarchy.json',
    'flatten -noscopeinfo',
    'opt',
    'clean',
    'write_json netlist.json',
  ].join('; ');
  try {
    const files = await runYosys(['-T', '-p', script], { 'design.v': source }, {
      stdout: capture,
      stderr: capture,
      decodeASCII: true,
      fetchProgress: event => onProgress?.({
        stage: 'loading', done: event.doneLength, total: event.totalLength,
      }),
    });
    // Yosys may simplify high-impedance branches during optimization. Reject
    // its frontend warning before that can masquerade as ordinary logic.
    if (/limited support for tri-state logic/i.test(log)) {
      throw new Error('Circuit cannot run in this workshop: tri-state logic is unsupported; use explicit multiplexers.');
    }
    const text = file => typeof file === 'string' ? file : new TextDecoder().decode(file);
    if (!files?.['netlist.json'] || !files?.['hierarchy.json']) throw new Error('Yosys did not produce a circuit.');
    const netlist = JSON.parse(text(files['netlist.json']));
    const hierarchy = JSON.parse(text(files['hierarchy.json']));
    if (!netlist.modules?.[top]) throw new Error(`Compiled circuit is missing top module ${top}.`);
    // Refuse circuitry whose execution this workshop cannot model accurately.
    // This checks latches, tri-states, memories, widths, clocks, drivers, and loops.
    try { new CircuitSimulator(netlist, { top }); }
    catch (cause) { throw new Error(`Circuit cannot run in this workshop: ${cause.message}`); }
    return { netlist, hierarchy, log, top, source };
  } catch (cause) {
    const useful = log.split('\n').filter(line => /ERROR:|Warning:|design\.v:/.test(line)).join('\n');
    const detail = cause.message?.startsWith('Circuit cannot run') ? cause.message : useful || cause.message || String(cause);
    const error = new Error(`Verilog compilation failed.\n${detail}`);
    error.log = log;
    throw error;
  }
}
