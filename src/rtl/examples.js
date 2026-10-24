export const CPU_SOURCE = `// An actual multicycle, 8-bit accumulator processor.
// Program ROM is external and asynchronous. Data memory uses request/response.
module alu8(
    input [7:0] left, right,
    input subtract,
    output [7:0] result,
    output carry,
    output zero
);
    wire [8:0] sum = {1'b0, left} + {1'b0, right};
    wire [8:0] difference = {1'b0, left} - {1'b0, right};
    assign result = subtract ? difference[7:0] : sum[7:0];
    assign carry = subtract ? ~difference[8] : sum[8];
    assign zero = (result == 8'd0);
endmodule

module top(
    input clk, reset,
    input [15:0] instruction,
    input mem_ready, mem_resp_valid,
    input [7:0] mem_rdata,
    output reg [7:0] pc, a,
    output reg [15:0] ir,
    output reg z, c,
    output reg [3:0] state,
    output mem_valid, mem_write,
    output [7:0] mem_addr, mem_wdata,
    output mem_resp_ready, retired,
    output [7:0] retire_pc,
    output halted,
    output reg fault
);
    localparam FETCH=4'd0, EXEC=4'd1, DATA_REQ=4'd2,
               DATA_WAIT=4'd3, STOPPED=4'd4;
    localparam NOP=8'd0, LDI=8'd1, LOAD=8'd2, STORE=8'd3,
               ADD=8'd4, ADDI=8'd5, SUBI=8'd6, JMP=8'd7,
               JZ=8'd8, JNZ=8'd9, HALT=8'hff;

    reg [7:0] fetched_pc;
    wire [7:0] opcode = ir[15:8];
    wire [7:0] operand = ir[7:0];
    wire [7:0] alu_right = (opcode == ADD) ? mem_rdata : operand;
    wire [7:0] alu_result;
    wire alu_carry, alu_zero;
    alu8 arithmetic(a, alu_right, opcode == SUBI,
                    alu_result, alu_carry, alu_zero);

    assign mem_valid = !reset && state == DATA_REQ;
    assign mem_write = opcode == STORE;
    assign mem_addr = operand;
    assign mem_wdata = a;
    assign mem_resp_ready = !reset && state == DATA_WAIT;
    assign retire_pc = fetched_pc;
    assign halted = state == STOPPED;
    wire simple_instruction = opcode == NOP || opcode == LDI ||
          opcode == ADDI || opcode == SUBI || opcode == JMP ||
          opcode == JZ || opcode == JNZ || opcode == HALT;
    assign retired = !reset &&
          ((state == EXEC && simple_instruction) ||
           (state == DATA_WAIT && mem_resp_valid));

    always @(posedge clk) begin
        if (reset) begin
            pc <= 0; a <= 0; ir <= 0; z <= 1; c <= 0;
            state <= FETCH; fetched_pc <= 0; fault <= 0;
        end else begin
            case (state)
                FETCH: begin
                    ir <= instruction;
                    fetched_pc <= pc;
                    pc <= pc + 8'd1;
                    state <= EXEC;
                end
                EXEC: begin
                    state <= FETCH;
                    case (opcode)
                        NOP: begin end
                        LDI: begin a <= operand; z <= operand == 0; end
                        LOAD, STORE, ADD: state <= DATA_REQ;
                        ADDI, SUBI: begin
                            a <= alu_result; z <= alu_zero; c <= alu_carry;
                        end
                        JMP: pc <= operand;
                        JZ: if (z) pc <= operand;
                        JNZ: if (!z) pc <= operand;
                        HALT: state <= STOPPED;
                        default: begin fault <= 1; state <= STOPPED; end
                    endcase
                end
                DATA_REQ: if (mem_ready) state <= DATA_WAIT;
                DATA_WAIT: if (mem_resp_valid) begin
                    if (opcode == LOAD) begin
                        a <= mem_rdata; z <= mem_rdata == 0;
                    end
                    if (opcode == ADD) begin
                        a <= alu_result; z <= alu_zero; c <= alu_carry;
                    end
                    state <= FETCH;
                end
                STOPPED: begin end
                default: begin fault <= 1; state <= STOPPED; end
            endcase
        end
    end
endmodule
`;

export const RTL_EXAMPLES = [
  {
    id: 'cpu', name: '8-bit processor', top: 'top',
    description: 'A complete processor: real datapath, sequencer, flags, branches, and memory handshakes.',
    source: CPU_SOURCE,
    inputs: { clk: 0, reset: 0, instruction: 0, mem_ready: 1, mem_resp_valid: 0, mem_rdata: 0 },
  },
  {
    id: 'accumulator', name: 'Enabled accumulator', top: 'top',
    description: 'Follow an adder feeding a register. Enable captures the sum; otherwise the register holds.',
    source: `module top(
    input clk, reset, enable,
    input [7:0] operand,
    output reg [7:0] value,
    output [7:0] next_value
);
    assign next_value = value + operand;
    always @(posedge clk) begin
        if (reset) value <= 0;
        else if (enable) value <= next_value;
    end
endmodule
`,
    inputs: { clk: 0, reset: 0, enable: 1, operand: 3 },
  },
  {
    id: 'fulladder', name: 'Full adder', top: 'top',
    description: 'Explore sum and carry from three input bits, with an inspectable module boundary.',
    source: `module full_adder(input a, b, cin, output sum, cout);
    wire partial = a ^ b;
    assign sum = partial ^ cin;
    assign cout = (a & b) | (partial & cin);
endmodule

module top(input a, b, cin, output sum, cout);
    full_adder bit_slice(a, b, cin, sum, cout);
endmodule
`,
    inputs: { a: 1, b: 1, cin: 0 },
  },
  {
    id: 'counter', name: 'Counter with enable', top: 'top',
    description: 'A clocked feedback loop: pause counting with enable, or synchronously reset to zero.',
    source: `module top(
    input clk, reset, enable,
    output reg [7:0] count,
    output [7:0] next_count
);
    assign next_count = count + 8'd1;
    always @(posedge clk) begin
        if (reset) count <= 0;
        else if (enable) count <= next_count;
    end
endmodule
`,
    inputs: { clk: 0, reset: 0, enable: 1 },
  },
];
