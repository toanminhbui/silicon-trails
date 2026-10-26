# Exploring and building processors

Silicon Trails exposes three different levels of computer architecture. Each has an executable model, and each supports a different kind of experiment.

| Workspace | What executes | What can be changed |
| --- | --- | --- |
| ST-8 / Processor RTL | A real synthesized 8-bit accumulator CPU, evaluated cell by cell | Assembly program, memory/cache settings, and supported Verilog hardware |
| Build sandbox | A circuit generated from primitive blocks, reusable module instances, and actual port connections | Inputs, arithmetic/control logic, registers, module composition, wiring, and positions |
| Out-of-order architecture lab | A separate deterministic cycle model of a register-renamed pipeline | Its register-based assembly program and exposed resource settings |

The out-of-order model is not the ST-8’s implementation. Its named queues and maps are also not editable Builder primitives. This separation lets learners investigate a complete small hardware implementation and a larger scheduling model without implying that a Verilog compiler generated the latter.

## The real hardware path

The [ST-8 RTL](../src/rtl/examples.js) contains the datapath, control state machine, instruction decode, flags, and retirement signals. Local Yosys synthesis produces the circuit used during execution. The world’s architecture overview groups the implementing cells into understandable components; it can also display flattened cells. Saved hierarchy and source attributes link back to the submitted hardware, but the view is a logical arrangement rather than a placed and routed chip.

Program ROM, RAM, cache, and memory-mapped input/output are external simulation services. The CPU still drives requests and waits for the real acknowledgement protocol. A store does not update RAM just because its animation reaches a memory block. Its response handshake commits the byte once. [The simulator model](simulator.md) specifies that protocol, the instruction set, and clock behavior.

The current 16-part Builder is useful for learning the pieces: arithmetic makes a combinational result, one-bit comparator outputs control mux selection or register enables, and an enabled register captures a result at a shared edge. Subtraction, multiplication, and logical shifts extend datapath experiments. The complete palette opens through **All components** or B; its exported structural Verilog describes those same connections. [Reusable modules](reusable-modules.md) package working subcircuits into typed components, support nested composition, and expose live internal signals. Each instance has independent register state. Building a CPU entirely through high-level visual parts still needs additional facilities: editable instruction decoding, register-file ports, processor memory interfaces, bus slicing/extension, and an explicit processor test interface.

## The out-of-order path

Enter **Out-of-order architecture lab** from the title screen, or **Architecture lab** in the pause menu. Fly around its named components, use the **Component navigator** to inspect or approach a unit, and pause to inspect **Pipeline state**. Clock steps drive the model’s actual queues and events. A retirement step advances until an instruction commits.

The default machine has eight architectural registers, 24 physical registers, a 12-entry reorder buffer, eight reservation stations, and a six-entry load/store queue. It dispatches up to two instructions and retires up to two instructions per clock. Values and addresses are eight bits; arithmetic wraps modulo 256. R0 always reads zero and cannot be a destination.

| Component | Responsibility | Useful observation |
| --- | --- | --- |
| Fetch / decode | Read the next assembly instructions and their operands | Program position advances at dispatch, ahead of retirement |
| Dispatch | Allocate queue entries and destination resources | A full required resource stalls new dispatch |
| Rename map | Map each architectural register to its latest speculative physical destination | Rewriting R1 allocates a fresh destination without changing older readers’ tags |
| Architectural map | Identify each register’s last committed physical value | It changes only when that instruction retires |
| Physical register file / free list | Hold values and readiness; allocate fresh destinations | Completion makes a value ready; retirement frees the previous committed destination |
| Reservation stations | Keep operations and physical source tags until operands are ready | A younger independent operation can issue before an older waiting one |
| ALU / multiply unit | Execute ready arithmetic | The ALU takes one clock; the separate non-pipelined multiply unit takes five by default |
| Result broadcast | Write results and wake consumers of the physical destination | A dependent operation remains waiting until its actual source is ready |
| Load/store queue | Track addresses, store data, and memory ordering | A load waits for unknown older store addresses and can forward matching store data |
| Reorder buffer | Retain instructions in program order until safe to commit | A completed younger instruction waits behind an unfinished head entry |
| Retirement | Publish committed register mappings and stores | Completion order can differ from program order; retirement order cannot |
| Memory / devices | Hold abstract bytes and mapped input/output | Stores update RAM at retirement; FE drives the display and FF reads the input |

Fetch and decode are conceptual views over one dispatch window, not separately timed front-end pipeline stages. Each clock processes retirement from the previous state, completes due execution work, issues newly ready work, then dispatches fresh instructions. Newly dispatched work cannot issue until a later clock. A completion can wake an already waiting consumer for issue in that clock.

## Three experiments

**Rename, execute, forward** starts with R1 = 3 and R2 = 4. An older multiply keeps the original physical source for R1 and computes 12, even after a younger instruction renames R1 to hold 7. The independent younger addition computes 11 before that multiply finishes. A store of 11 waits in the load/store queue; a following load can receive 11 by forwarding while backing RAM still contains zero. Retirement eventually saves 11 at address 40. The final addition combines 11 and 12, and the display shows **23**.

**True dependencies and independent work** multiplies 6 by 7 while an independent addition computes 13. The dependent addition waits for the multiply’s physical result, then produces **55**. This demonstrates why renaming removes false dependencies while preserving real data dependencies.

**Wait for an older store address** delays the address calculation of a store to address 40. A younger load from 40 must wait until the older address is known. It then receives the stored value **21**. Bypassing an unresolved older store would incorrectly read the initial zero.

The pipeline panel exposes both speculative and committed register maps, physical readiness, reservation stations, execution units, the load/store queue, reorder buffer, retirement trace, memory, and events from the latest clock. World highlights derive from these same events.

## Scope of the teaching model

This model supports `LI`, `ADD`, `SUB`, `MUL`, `ADDI`, `LOAD`, `STORE`, `NOP`, and `HALT`. It has no branches, branch prediction, recovery, architectural exceptions, virtual memory, TLB, native RTL implementation, cache hierarchy, or coherence protocol. Its default RAM load latency is three clocks, while a forwarded load takes one. Memory-mapped reads wait until the instruction reaches the reorder-buffer head. Ordinary stores change memory only at retirement.

The model demonstrates out-of-order execution, register renaming, operand readiness, ordered retirement, and conservative memory dependencies. It does not estimate the speed or area of a physical processor. Flight, component scales, layout spacing, and wire lengths have no effect on its clocks.

## What would prove a player-built CPU works?

A complete construction challenge needs an interface and independent behavioral checks. A machine that produces one expected number has not yet established that its control flow, state, and memory protocol work generally.

Useful checks should include:

- Arithmetic boundary values, wraparound, zero flags, and carry/borrow behavior.
- Register capture, enables, reset, and simultaneous state changes.
- Taken and untaken branches, instruction sequencing, and loops.
- Memory requests that remain stable while stalled, delayed acknowledgements, and exactly one store commit.
- Programs that agree with an independent instruction reference at every retirement.
- Cache and latency changes that preserve the final architectural result.
- For a future editable out-of-order processor, source-tag correctness, finite-resource stalls, conservative load/store ordering, forwarding, and ordered retirement.

The existing ST-8 regression tests already compare synthesized CPU retirements against an independent instruction model and check memory timing. The primitive Builder currently validates connections and circuit semantics. A complete visual processor kit and a player-facing challenge checker remain future construction work.
