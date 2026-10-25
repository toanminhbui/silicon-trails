module full_adder(input a, b, cin, output sum, cout);
    wire partial = a ^ b;
    assign sum = partial ^ cin;
    assign cout = (a & b) | (partial & cin);
endmodule

module top(input a, b, cin, output sum, cout);
    full_adder bit_slice(a, b, cin, sum, cout);
endmodule
