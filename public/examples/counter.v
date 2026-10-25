module top(
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
