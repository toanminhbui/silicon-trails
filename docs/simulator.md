# Simulator model

The runtime executes synthesized hardware. [CircuitSimulator](../src/core/simulator.js) evaluates Yosys cells; [CpuLab](../src/core/cpu-lab.js) supplies external ROM, RAM/cache, mapped devices, and debugging. The CPU’s instruction behavior is implemented by [its Verilog](../src/rtl/examples.js). An independent instruction interpreter appears only in [tests](../tests/cpu.test.js).

## Circuit semantics

The synthesis pipeline reads synthesizable Verilog/SystemVerilog, checks the chosen top module, lowers processes, optimizes, saves source hierarchy, then flattens and saves the executable word-level netlist. The browser UI currently uses either flattened cells or a curated architecture overview; saved hierarchy is not yet a fully navigable hierarchy editor.

Supported cells include combinational arithmetic, bitwise/boolean operations, comparisons, reductions, shifts, multiplexers, concatenation/slicing, and supported DFF variants. Data paths are limited to 32 bits; packed mux alternatives can contain multiple such paths. Arithmetic uses integer bit operations that retain unsigned 32-bit values and signed operand behavior.

There is one shared, directly connected rising-edge input clock. On a tick:

1. Settle combinational logic using the old register values.
2. Sample every register’s next value, enable, and reset from that same state.
3. Commit all register updates together.
4. Settle combinational logic again.

Register feedback is valid. Combinational cycles, multiple drivers, unsupported cells, native memory cells, latches, tri-states, gated/multiple clocks, and oversized data paths produce errors. The simulator does not model voltage, signal strength, propagation delay, metastability, or physical timing.

Values are unsigned numbers or unknown (`null`/X). Uninitialized registers remain unknown unless their netlist supplies an initial value or their circuit resets/captures a known value. Unconnected Build inputs are X. Where possible, logic still resolves masked unknowns, such as `0 AND X = 0`.

`CircuitSimulator.reset()` restores its initial netlist state and zeroes top-level inputs. The processor wrapper additionally supplies its real synchronous reset edge and reports the resulting execution state as clock zero.

## ST-8 architecture

| Item | Definition |
| --- | --- |
| Data width | 8 bits; arithmetic wraps modulo 256 |
| A | 8-bit accumulator |
| PC | 8-bit instruction address; increment wraps modulo 256 |
| IR | 16-bit captured instruction |
| Flags | Z = zero result; C = arithmetic carry / no borrow |
| Program store | 256 × 16-bit external asynchronous ROM |
| Data address space | 256 byte addresses, including mapped devices |
| Instruction format | `[opcode:8 | operand:8]` |

Reset sets A, PC, IR, and C to zero; Z to one; and the controller to FETCH. RAM and display start at zero, cache lines are invalid, and pending work and execution history are cleared. The configured input byte remains a setting on the live lab object.

### Instructions

| Opcode | Assembly | Operation | Flags |
| --- | --- | --- | --- |
| `00` | `NOP` | No data operation | Preserve |
| `01` | `LDI n` | `A ← n` | Set Z; preserve C |
| `02` | `LOAD a` | `A ← memory[a]` | Set Z; preserve C |
| `03` | `STORE a` | `memory[a] ← A` | Preserve |
| `04` | `ADD a` | `A ← A + memory[a]` | Set Z and addition carry |
| `05` | `ADDI n` | `A ← A + n` | Set Z and addition carry |
| `06` | `SUBI n` | `A ← A − n` | Set Z; C = 1 if no unsigned borrow |
| `07` | `JMP a` | `PC ← a` | Preserve |
| `08` | `JZ a` | Jump if Z = 1 | Preserve |
| `09` | `JNZ a` | Jump if Z = 0 | Preserve |
| `FF` | `HALT` | Enter STOPPED | Preserve |

For addition, C is one when the untruncated sum exceeds 255. For subtraction, C is one when the original A is at least the operand. All result bytes wrap to eight bits. Unsupported opcodes stop the processor with `fault = 1`.

The assembler accepts decimal and `0x` hexadecimal operands, case-insensitive labels/instructions, and semicolon comments. Programs contain at most 256 instructions. Unused ROM words are HALT. Branch operands address instruction words rather than individual bytes.

```asm
LDI   7
ADDI  5
STORE 0x40
STORE 0xFE
HALT
```

This saves decimal 12 (`0C`) in RAM address `40` and the numeric display.

## Fetch, execution, and retirement

| State | Value | Behavior on its active edge |
| --- | --- | --- |
| FETCH | 0 | Capture ROM instruction and its address; increment PC; enter EXEC |
| EXEC | 1 | Complete a simple instruction, or enter DATA_REQ for LOAD/STORE/ADD |
| DATA_REQ | 2 | Hold a memory request until accepted; enter DATA_WAIT |
| DATA_WAIT | 3 | Wait for a valid response; complete the memory operation; return to FETCH |
| STOPPED | 4 | Hold state |

ROM is asynchronous and has no request/response latency in this version. A branch executes after FETCH has already incremented PC and overrides that next address when taken.

`retired` is a combinational event sampled before the clock edge. The trace records the post-edge architectural result and the captured instruction address. Simple instructions retire on their EXEC edge. Memory instructions retire on response acknowledgement. HALT retires once, then stops. Invalid instructions fault without a normal retirement.

**Step clock** advances one shared edge. **Step instruction** advances until one instruction retires, including its waits, or reports that its clock limit was exceeded. Rewind restores the previous clock snapshot, including registers, RAM, cache, pending transactions, and trace/event lengths. The CPU wrapper retains up to 4,096 clock snapshots.

Pausing the game freezes player movement and automatic processor ticking. The paused workbench still permits explicit clock/instruction steps and rewind. This separates the player’s navigation state from the machine state being inspected; opening a workbench does not reset the circuit.

## Data-memory protocol

CPU outputs are `mem_valid`, `mem_write`, `mem_addr`, `mem_wdata`, and `mem_resp_ready`. External inputs are `mem_ready`, `mem_resp_valid`, and `mem_rdata`.

- A request is accepted on an edge where `mem_valid && mem_ready`.
- Address, operation, and write data must remain stable until acceptance.
- Only one transaction is outstanding. The wrapper deasserts request readiness while busy.
- Every accepted transaction, including a store, receives exactly one response.
- Response data remains stable until the edge where `mem_resp_valid && mem_resp_ready`.
- A STORE changes RAM/device state exactly on that response edge. A LOAD or ADD captures the returned byte on that same edge.

With latency L, a request accepted at clock T completes at T + L. A five-clock STORE accepted at clock 10 leaves RAM unchanged through clock 14 and commits at clock 15. Waiting does not repeatedly apply a store. Read values, including the input device, are sampled when the request is accepted and retained for its response.

Full processor reset restores the initial zero RAM image and cancels pending transactions. The UI does not offer a CPU-only reset that leaves a transaction running behind the reset controller.

### Mapped devices

| Address | Reads | Completed writes |
| --- | --- | --- |
| `00`–`FD` | Backing RAM/cache byte | Update RAM |
| `FE` | Numeric display value | Update display and its RAM mirror |
| `FF` | Configured input byte, initially zero | Acknowledge and ignore |

Mapped addresses bypass the cache. The memory grid shows backing RAM; the FF input is a device value rather than a writable RAM byte.

## Cache abstraction

The optional blocking cache contains **four lines × four bytes**. An 8-bit address splits into tag `[7:4]`, index `[3:2]`, and byte offset `[1:0]`.

| Request | Completion latency | Cache effect at completion |
| --- | --- | --- |
| Cacheable read hit | 1 clock after acceptance | Return cached byte |
| Cacheable read miss | Configured RAM latency | Fill the four-byte line; return requested byte |
| Store | Configured RAM latency | Write through to RAM; update matching cached byte if present |
| Mapped I/O | Configured RAM latency | Bypass |

Stores do not allocate a line on a miss. There are no dirty lines, writeback, write buffer, coherence, or speculative requests. A line fill has one abstract latency; it does not simulate four physical byte transfers. Hit/miss counts describe cacheable reads; the total reads count also includes uncached reads.

Memory settings restart the program. Cache contents and timing can change while the ISA-visible result of a correctly functioning program remains the same. Block placement and wire length never affect these latencies.

## Saved projects and verification

World JSON preserves construction, source, compiled design, program, selected configuration, and guided-journey progress. New saves also include a validated execution checkpoint: simulator inputs/registers/clock, RAM, cache lines and counters, pending memory work, display/input bytes, and the most recent 1,024 memory events and instruction trace rows. Rewind history is not persisted.

The checkpoint is checked against the circuit identity and program before live state changes. Invalid checkpoint data is rejected. Older saves without a checkpoint restart execution; unfinished guided progress is reset so its next lesson does not refer to a missing saved byte.

[Core tests](../tests/core.test.js) check arithmetic, unknowns, simultaneous state changes, resets, and rejection rules. [CPU tests](../tests/cpu.test.js) compare every retired instruction with an independent model across cache and latency configurations, then check exact store completion, reset cancellation, and rewind/replay. [RTL tests](../tests/rtl.test.js) run real synthesis and verify behavior and diagnostics. [Builder tests](../tests/builder.test.js) check that actual connections determine circuit behavior and exported RTL.
