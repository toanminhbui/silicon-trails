# Game design

Silicon Trails makes computation something a learner can build, inspect, and explore from every side. Its core loop is **connect → predict → clock → inspect → revise**. A useful machine must emerge from the player’s connections and control logic; animations explain the execution that already happened.

## Start from the minimum computer

A programmable machine needs four capabilities:

| Capability | Building blocks | What the learner can observe |
| --- | --- | --- |
| Transform a value | Gates, arithmetic, comparisons | Outputs change when inputs change |
| Choose a path | Multiplexers, decoding, enables | An operation selects particular sources and destinations |
| Remember a value | Registers and addressed memory | Captured values remain after the producing input changes |
| Repeat a sequence | Program counter, instructions, controller | The same hardware performs different operations over time |

Data flow determines which values reach a destination. Control flow determines which destination captures them, when it captures them, and which instruction follows. Both should be visible. A byte with value zero can be actively transferred; activity is a separate property from numerical value.

The first complete processor is an 8-bit accumulator machine, **ST-8**. Its small instruction set still supports arithmetic, loops, conditional branches, and persistent RAM updates. Separate program ROM and data RAM keep the first machine approachable. The exact instruction set and clock behavior are specified in [the simulator model](simulator.md); the executable definition is [the processor RTL](../src/rtl/examples.js).

## Play first; open workbenches while paused

The title screen offers a guided journey and free exploration. Starting enters a full-screen circuit space with a crosshair, a small processor HUD, and an optional tutorial card. Flight follows the camera direction: WASD translates, Space rises, Q/C descends, and Shift boosts speed. No gravity or terrain collision constrains inspection. Detailed editors and data panels remain in the pause menu. Escape stops navigation and automatic simulation and opens the RTL workbench; manual clock/instruction steps remain available for deliberate debugging. Resume returns to the same world.

The pause menu connects the following activities without introducing global application tabs.

**Explore the world:** approach and interact with a working processor. Its architecture view groups actual synthesized cells into PC, instruction register, accumulator, flags, controller, decode/routing, and arithmetic blocks. Program ROM, RAM/cache, and the display are explicitly identified as external simulation services. Inspecting an implemented block can reveal its actual cells and RTL source location.

**Build sandbox:** enter from the pause menu and construct real circuits from typed ports in the world. The 16-part library contains 8-bit inputs and outputs, a 1-bit switch, ADD, SUB, MUL, Equal, Less than, left/right logical shifts, AND, OR, XOR, NOT, a multiplexer, and an enabled register. The hotbar holds common parts; **All components** or B opens the complete library. Equal and unsigned Less than compare two eight-bit inputs and produce a one-bit control signal that can drive a mux selector or register enable. The construction’s connections generate the same cell-netlist format the simulator consumes. Unconnected inputs stay unknown. Reconnecting a destination replaces its previous connection; incompatible widths and combinational feedback are rejected. Changing construction restarts execution. These primitives support arithmetic, control, and state experiments; the current Builder does not expose dedicated editable register files, instruction decoders, processor memory interfaces, or out-of-order pipeline structures.

**Reusable modules:** select a group of functional construction nodes, review the typed inputs and outputs inferred at its boundary, name those ports, and package the selection as one component. Its existing external cables reconnect through the new boundary. Saved definitions appear beside primitives in the library; multiple instances share a definition while keeping independent sequential state. Packaging instances with other functional nodes creates nested modules. Opening an instance changes the view to its live internals without creating another simulator or resetting clocks. A breadcrumb returns to its parent. Definition internals are read-only after packaging. See [the authoring walkthrough](reusable-modules.md).

**Processor RTL:** edit hardware in a paused workbench. Verilog passes through real Yosys synthesis and then the same circuit engine. Changing an addition to a subtraction changes both the resulting implementation and its behavior. Structural Verilog exported from Build can enter this flow. A general reverse conversion from synthesized RTL into editable Build components is outside the current MVP.

**Architecture lab:** explore a separate out-of-order cycle model with named decode, dispatch, register maps, physical registers, reservation stations, execution units, a load/store queue, and reorder buffer. It runs register-based assembly and exposes actual queue entries, operand readiness, forwarding, and ordered retirement. It does not replace the synthesized ST-8 or turn these units into editable Builder components. The [processor architecture guide](processor-architecture.md) describes the model and its limits.

## Learning progression

The introductory guided journey advances through real events: flying three world units, inspecting Accumulator A, producing 12 through instructions, committing `STORE 0x40`, inspecting the saved byte, and opening RTL. Buttons request actions rather than advancing a lesson counter. Earlier valid observations remain recorded when the next milestone is reached.

The wider sandbox supports the following progression; a longer challenge campaign and scoring remain future work.

1. **Make a signal:** vary an input, inspect its bits, and explain a gate’s output.
2. **Choose a value:** connect a multiplexer and use a control signal to select a source.
3. **Make a number stay:** feed an adder into a register. Change the input between edges, then test write enable.
4. **Follow an instruction:** trace ROM → IR → decode, then watch an immediate instruction update A.
5. **Save and retrieve:** execute STORE and LOAD while inspecting the address, pending transaction, committed byte, and read result.
6. **Build repetition:** run the 1-through-10 sum. Follow the RAM counter, subtraction, zero flag, and branch.
7. **Change the machine:** edit the processor RTL, synthesize it, and run programs through the changed circuit.
8. **Explain a stall:** run repeated reads with and without the cache. Predict which address bits choose a cache line and which reads require a refill.

Learners can package a verified subcircuit and reuse it at a higher level without placing every gate again. A later campaign can turn these activities into build challenges with supplied interfaces, test inputs, and expected observations. The module’s name or shape alone does not establish that its behavior is correct.

## Make memory visible

Memory inspection connects an address to a saved byte, its binary/hex/decimal forms, completed reads, and the clock of its last write. Execution traces connect each completed instruction to its memory effect. A pending STORE should remain visibly pending until acknowledgement; the saved value changes once on the completion edge.

Address `FE` drives a numeric display, so a short program has a visible outcome. Address `FF` reads an editable input byte. These devices use the processor’s normal memory interface and bypass the cache.

The optional cache is deliberately abstract: four lines of four bytes, direct mapping, write-through, and no write allocation. Learners can inspect tags and contents and compare the clocks required by the same program. Cache internals are not built from individual storage cells in this MVP.

## Testing belongs in the workshop

The most useful debugging actions are small and repeatable:

- Change an input and inspect combinational results before clocking.
- Advance one clock to see exactly which registers capture values.
- Advance one instruction to include its internal phases and memory waits.
- Break at a program address, inspect state, and continue.
- Rewind a clock, including pending memory work, then replay it.
- Compare programs against known outcomes, such as 12 saved at `40` or the loop result 55.

Repository tests go further: they compare each retired instruction of the synthesized CPU with an independent architectural reference. That reference is a test oracle only. Runtime instruction execution comes from the circuit.

Future challenge checking should use the same principle: test the player’s actual circuit across meaningful inputs and timing conditions. A visually plausible arrangement or a particular block count is insufficient evidence of a working processor.

## Spatial rules

The circuit space provides orientation, discoverability, and room to arrange a construction. Free flight, a reference grid, interaction prompts, a component navigator, and tutorial beacons guide the player. The setting keeps attention on the machine rather than vegetation or terrain traversal. Pausing disables world input and preserves the camera’s position.

Three independent controls address visual density: layout spacing moves component centers apart, component size changes all component bodies, and a per-part scale changes one selected component. Wiring follows the transformed ports. These controls preserve the executable circuit and its current state. They are logical views, not chip floorplanning, lithography, or electrical scale. Positions, wire lengths, camera movement, viewing scale, and animation frame rate never decide a circuit’s result or memory latency.

The introductory journey establishes a play-and-inspect loop. A future campaign may add build objectives, reusable blueprints, further progression, and richer programmable devices. Those additions should preserve deterministic simulation and make every successful machine explainable.

## Persistence

Local autosave and exported world JSON preserve the construction, reusable module definitions and instances, Verilog source, compiled design, assembly program, viewing scales, selected settings, and guided-journey progress. A validated hardware execution checkpoint retains register/input values, the current clock, RAM, cache contents, pending transactions, input/display state, and recent execution and memory events. Nested module registers belong to that same executable circuit. The separate architecture model stores its own program, configuration, queue/register state, and memory checkpoint. This keeps a resumed lesson consistent with the number the player already saved.

Checkpoints must match the saved circuit and program before they can change live state. Recent logs are bounded to 1,024 entries each, and rewind history starts fresh after loading. Camera position is not persisted; Continue returns to the starting viewpoint. Older world files without an execution checkpoint restart the machine and reset an unfinished guided journey.
