module top(
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
