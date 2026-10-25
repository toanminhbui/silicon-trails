# Game design

Silicon Trails makes computation something a learner can build, inspect, and walk around. Its core loop is **connect → predict → clock → inspect → revise**. A useful machine must emerge from the player’s connections and control logic; animations explain the execution that already happened.

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

## Three connected ways to learn

**Explore** opens a working processor. The architecture view groups its actual synthesized cells into PC, instruction register, accumulator, flags, controller, decode/routing, and arithmetic blocks. Program ROM, RAM/cache, and the display are explicitly identified as external simulation services. Selecting an implemented block can reveal its actual cells and RTL source location.

**Build** makes real circuits from typed ports. The initial palette contains 8-bit inputs and outputs, a 1-bit switch, ADD, AND, OR, XOR, NOT, a multiplexer, and an enabled register. The construction’s connections generate the same cell-netlist format the simulator consumes. Unconnected inputs stay unknown. Reconnecting a destination replaces its previous connection; incompatible widths and combinational feedback are rejected. Changing construction restarts execution.

**RTL** gives learners another way to express hardware. Verilog passes through real Yosys synthesis and then the same circuit engine. Changing an addition to a subtraction changes both the resulting implementation and its behavior. Structural Verilog exported from Build can enter this flow. A general reverse conversion from synthesized RTL into editable Build components is outside the current MVP.

## Learning progression

The current sandbox supports these activities; automatic challenge progression and scoring remain future work.

1. **Make a signal:** vary an input, inspect its bits, and explain a gate’s output.
2. **Choose a value:** connect a multiplexer and use a control signal to select a source.
3. **Make a number stay:** feed an adder into a register. Change the input between edges, then test write enable.
4. **Follow an instruction:** trace ROM → IR → decode, then watch an immediate instruction update A.
5. **Save and retrieve:** execute STORE and LOAD while inspecting the address, pending transaction, committed byte, and read result.
6. **Build repetition:** run the 1-through-10 sum. Follow the RAM counter, subtraction, zero flag, and branch.
7. **Change the machine:** edit the processor RTL, synthesize it, and run programs through the changed circuit.
8. **Explain a stall:** run repeated reads with and without the cache. Predict which address bits choose a cache line and which reads require a refill.

A later guided campaign can turn these activities into explicit challenges with supplied interfaces, test inputs, and expected observations. Reusable modules would let learners package a verified subcircuit and use it at a higher level without placing every gate again.

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

The world provides orientation, discoverability, and room to arrange a construction. Orbit and walk controls offer different ways to inspect it. Block positions, wire lengths, camera movement, and animation frame rate never decide a circuit’s result or memory latency.

The current product is a spatial laboratory. A future campaign may add build objectives, reusable blueprints, progression, and richer programmable devices. Those additions should preserve deterministic simulation and make every successful machine explainable.

## Persistence

Local autosave and exported project JSON preserve the construction, Verilog source, compiled design, assembly program, and selected settings. Restoring starts a fresh execution of that design. Runtime RAM, cache contents, pending requests, and rewind history are not saved as a resumable machine checkpoint.
