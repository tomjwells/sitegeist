/**
 * When "$...$" is inline math (Cassian Vale request eea370d2, 2026-11-15). mini-lit's <markdown-block> took any
 * "$...$" pair as TeX, so "for $43,766. At that day's rate that's £32,108 ... "$43,000"" became one italic KaTeX
 * run with its spaces stripped, and a finance answer was unreadable. Pandoc's rule, which keeps "$x$" and
 * "$2^n$" as math: the opening "$" is followed by a non-space, the closing "$" is preceded by a non-space and is
 * NOT followed by a digit. So "$5 and $10" stays text ("$1" cannot close), and amounts never pair up across a
 * sentence unless the writer really wrote "$...$" with tight edges.
 * Used by the build-time patch of MarkdownBlock.js (scripts/build.mjs) and by selection-markdown.ts, so the
 * renderer and the copy-as-markdown mapping agree on what is math.
 */
export const INLINE_MATH_DOLLAR = /^\$(?![\s$])([^$\n]*?[^\s$\\])\$(?!\d)/;

/** The inline-math match at the start of `src`, or undefined (marked tokenizer contract). */
export function matchInlineMathDollar(src: string): { raw: string; text: string } | undefined {
	const m = INLINE_MATH_DOLLAR.exec(src);
	if (!m || m[1] === undefined) return undefined;
	return { raw: m[0], text: m[1].trim() };
}
