import assert from "node:assert/strict";
import test from "node:test";
import { matchInlineMathDollar } from "../src/utils/inline-math.ts";

/** Every inline-math run marked would produce, scanning from each "$" like its tokenizer does. */
function runs(text: string): string[] {
	const out: string[] = [];
	for (let i = text.indexOf("$"); i >= 0; ) {
		const m = matchInlineMathDollar(text.slice(i));
		if (m) {
			out.push(m.text);
			i = text.indexOf("$", i + m.raw.length);
		} else i = text.indexOf("$", i + 1);
	}
	return out;
}

test("Cassian's dollar amounts are text, not math (2026-11-15)", () => {
	assert.deepEqual(
		runs(
			`for $43,766. At that day's exchange rate that's £32,108, the "closer to 32k" you both remembered. It also matches "$43,000" in your sheet`,
		),
		[],
	);
	assert.deepEqual(runs("His $43,766 bought 161,933 COTI at $0.27"), []);
	assert.deepEqual(runs("at $39,874, $3,891 less"), []);
	assert.deepEqual(runs("costs $5 and $10 each"), []);
});

test("real inline math still renders", () => {
	assert.deepEqual(runs("let $x$ be"), ["x"]);
	assert.deepEqual(runs("so $2^n$ ways and $E[X] = \\mu$ holds"), ["2^n", "E[X] = \\mu"]);
	assert.deepEqual(runs("$a+b$."), ["a+b"]);
	assert.deepEqual(runs("not $ x$ nor $x $"), []);
});
