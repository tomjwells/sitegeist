import assert from "node:assert/strict";
import test from "node:test";
import { numberedCodeHtml, splitHighlightedLines } from "../src/utils/code-lines.ts";

test("spans that run across lines are closed and reopened per line", () => {
	const html = 'a = <span class="s">"x\ny"</span>\n<span class="k">return</span> a\n';
	assert.deepEqual(splitHighlightedLines(html), [
		'a = <span class="s">"x</span>',
		'<span class="s">y"</span>',
		'<span class="k">return</span> a',
	]);
	assert.deepEqual(splitHighlightedLines("one line"), ["one line"]);
	assert.deepEqual(splitHighlightedLines('<span class="c"><span class="d">p\nq</span></span>'), [
		'<span class="c"><span class="d">p</span></span>',
		'<span class="c"><span class="d">q</span></span>',
	]);
});

test("numbered rows from two lines up; one line stays as it is", () => {
	assert.deepEqual(numberedCodeHtml("x"), { html: "x", lines: 1 });
	const r = numberedCodeHtml("a\n\nb");
	assert.equal(r.lines, 3);
	assert.equal((r.html.match(/class="sg-code-ln"/g) ?? []).length, 3);
	assert.match(r.html, />3<\/span><span class="sg-code-text">b</);
	assert.match(r.html, /min-width:1ch/);
});
