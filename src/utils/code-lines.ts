/**
 * Line numbers for highlighted code blocks (Tom, 2026-11-21: "Can we have things like syntax highlighting and things
 * like line numbers in sitegeist code blocks?"). highlight.js returns one HTML string whose <span>s can run across
 * newlines (multi-line strings, comments); this cuts it into one well-formed HTML string per line by closing the open
 * spans at each line end and reopening them on the next line. No DOM: tests/code-lines.test.ts runs it under node.
 */
export function splitHighlightedLines(html: string): string[] {
	const lines: string[] = [];
	const open: string[] = []; // opening tags still open, outermost first
	let current = "";
	const tag = /<\/?span\b[^>]*>|\n/g;
	let at = 0;
	for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
		current += html.slice(at, m.index);
		at = m.index + m[0].length;
		if (m[0] === "\n") {
			lines.push(current + "</span>".repeat(open.length));
			current = open.join("");
		} else if (m[0].startsWith("</")) {
			open.pop();
			current += m[0];
		} else {
			open.push(m[0]);
			current += m[0];
		}
	}
	current += html.slice(at);
	lines.push(current);
	// a trailing newline is not a line of its own
	if (lines.length > 1 && lines[lines.length - 1]?.replace(/<[^>]*>/g, "") === "") lines.pop();
	return lines;
}

/** Numbered rows for a code block: the number column is not selectable, so a copy takes only the code. */
export function numberedCodeHtml(highlighted: string): { html: string; lines: number } {
	const lines = splitHighlightedLines(highlighted);
	if (lines.length < 2) return { html: highlighted, lines: lines.length };
	const width = String(lines.length).length;
	const rows = lines
		.map(
			(l, i) =>
				`<span class="sg-code-line"><span class="sg-code-ln" aria-hidden="true" style="min-width:${width}ch">${i + 1}</span><span class="sg-code-text">${l === "" ? " " : l}</span></span>`,
		)
		.join(""); // each row is a block: a "\n" between them inside <pre> would add an empty line
	return { html: rows, lines: lines.length };
}
