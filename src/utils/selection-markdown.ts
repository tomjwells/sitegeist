/**
 * Selection → Markdown for the side panel's right-click "Copy as Markdown".
 *
 * The chat DOM is produced by mini-lit's <markdown-block> (marked + <code-block> + KaTeX), so a small
 * walker over the cloned range recovers the Markdown that produced it: headings, lists, quotes, tables,
 * emphasis, links, images, inline code, fenced code (from <code-block>'s language + <pre> text) and math
 * (TeX recovered from the block's source, see annotateMath).
 *
 * ponytail: plain text is not re-escaped (a literal "*" written as "\*" comes back bare); fine for a copy
 * helper, revisit if it bites.
 */

const BLOCK = new Set([
	"p",
	"div",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"li",
	"blockquote",
	"pre",
	"hr",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"section",
	"article",
	"header",
	"footer",
	"details",
	"summary",
	"figure",
	"dl",
	"dd",
	"dt",
	"form",
	"fieldset",
]);
const SKIP = new Set(["button", "svg", "script", "style", "select", "textarea", "template", "copy-button"]);

const MATH_RE = /\$\$([^$]+?)\$\$|\\\[(.+?)\\\]|\$([^$\n]+?)\$|\\\((.+?)\\\)/gs;
const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g;

/**
 * KaTeX (html output) keeps no TeX source in the DOM, so map every rendered .katex element back to the
 * n-th math expression of its <markdown-block>'s source and stash it in data-tex. Skipped when the
 * counts disagree (raw HTML swallowing a "$" etc.) — the walker then falls back to the rendered text.
 */
function annotateMath(range: Range): void {
	const root = range.commonAncestorContainer;
	const rootEl = root instanceof Element ? root : root.parentElement;
	if (!rootEl) return;
	const blocks = [...rootEl.querySelectorAll("markdown-block")];
	const closest = rootEl.closest("markdown-block");
	if (closest) blocks.push(closest);
	for (const block of blocks) {
		if (!range.intersectsNode(block)) continue;
		const source = (block as HTMLElement & { content?: unknown }).content;
		if (typeof source !== "string") continue;
		const tex: string[] = [];
		for (const m of source.replace(CODE_RE, (c) => " ".repeat(c.length)).matchAll(MATH_RE)) {
			const [, dd, bracket, d, paren] = m;
			if (dd !== undefined) tex.push(`$$${dd.trim()}$$`);
			else if (bracket !== undefined) tex.push(`$$${bracket.trim()}$$`);
			else if (d !== undefined) tex.push(`$${d.trim()}$`);
			else if (paren !== undefined) tex.push(`$${paren.trim()}$`);
		}
		const rendered = block.querySelectorAll(".katex, .katex-error");
		if (rendered.length !== tex.length) continue;
		rendered.forEach((el, i) => {
			const t = tex[i];
			if (t !== undefined) el.setAttribute("data-tex", t);
		});
	}
}

const collapse = (s: string): string => s.replace(/\s+/g, " ");

function codeSpan(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const fence = "`".repeat(longest + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

function fenced(code: string, lang: string): string {
	const longest = Math.max(2, ...[...code.matchAll(/`{3,}/g)].map((m) => m[0].length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${lang}\n${code.replace(/\n$/, "")}\n${fence}`;
}

/** Wrap inline content, keeping leading/trailing whitespace outside the markers ("**a **" is not bold). */
function wrap(inner: string, marker: string): string {
	const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
	if (!m || !m[2]) return inner;
	return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

function inline(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) return collapse(node.textContent ?? "");
	if (!(node instanceof Element)) return "";
	const tag = node.tagName.toLowerCase();
	if (SKIP.has(tag)) return "";
	const tex = node.getAttribute("data-tex");
	if (tex !== null) return tex;
	if (node.classList.contains("katex")) return collapse(node.textContent ?? "");
	const children = () => [...node.childNodes].map(inline).join("");
	switch (tag) {
		case "strong":
		case "b":
			return wrap(children(), "**");
		case "em":
		case "i":
			return wrap(children(), "*");
		case "del":
		case "s":
		case "strike":
			return wrap(children(), "~~");
		case "code":
			return codeSpan(node.textContent ?? "");
		case "a": {
			const href = node.getAttribute("href");
			const text = children();
			return href ? `[${text}](${href})` : text;
		}
		case "img":
			return `![${node.getAttribute("alt") ?? ""}](${node.getAttribute("src") ?? ""})`;
		case "br":
			return "\n";
		case "input":
			return node.getAttribute("type") === "checkbox" ? (node.hasAttribute("checked") ? "[x]" : "[ ]") : "";
		default:
			return BLOCK.has(tag) || tag.includes("-") ? block(node) : children();
	}
}

function listItem(li: Element, marker: string): string {
	const loose = [...li.children].some((c) => c.tagName === "P");
	const body = blocks(li)
		.join(loose ? "\n\n" : "\n")
		.split("\n")
		.map((line, i) => (i === 0 ? line : line ? " ".repeat(marker.length) + line : line))
		.join("\n");
	return marker + body;
}

const TABLE_PARTS = new Set(["thead", "tbody", "tfoot", "tr"]);

/** Rows of a <table>, or of a run of thead/tbody/tr siblings (a selection that starts inside a table). */
function table(parts: Element[]): string {
	const trs = parts.flatMap((p) => (p.tagName === "TR" ? [p] : [...p.querySelectorAll("tr")]));
	const rows = trs.map((tr) =>
		[...tr.children].map((cell) => ({
			text: [...cell.childNodes].map(inline).join("").trim().replace(/\|/g, "\\|").replace(/\n/g, " "),
			align: (cell.getAttribute("align") ?? cell.getAttribute("style") ?? "").match(/center|right/)?.[0] ?? "",
		})),
	);
	const first = rows[0];
	if (!first) return "";
	const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
	const sep = first.map((c) => (c.align === "center" ? ":---:" : c.align === "right" ? "---:" : "---"));
	return [line(first.map((c) => c.text)), line(sep), ...rows.slice(1).map((r) => line(r.map((c) => c.text)))].join(
		"\n",
	);
}

/** Children of a block container → list of Markdown blocks (inline runs become paragraphs). */
function blocks(node: Node): string[] {
	const out: string[] = [];
	let run = "";
	const flush = () => {
		const text = run.trim();
		if (text) out.push(text);
		run = "";
	};
	let tableRun: Element[] = [];
	const flushTable = () => {
		if (tableRun.length) out.push(table(tableRun));
		tableRun = [];
	};
	for (const child of node.childNodes) {
		const el = child instanceof Element ? child : null;
		const tag = el?.tagName.toLowerCase() ?? "";
		if (el && TABLE_PARTS.has(tag)) {
			flush();
			tableRun.push(el);
			continue;
		}
		if (!el && !(child.textContent ?? "").trim() && tableRun.length) continue;
		flushTable();
		if (!el || !(BLOCK.has(tag) || tag.includes("-"))) {
			run += inline(child);
			continue;
		}
		flush();
		if (SKIP.has(tag)) continue;
		switch (tag) {
			case "p":
				out.push([...el.childNodes].map(inline).join("").trim());
				break;
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6":
				out.push(`${"#".repeat(Number(tag[1]))} ${[...el.childNodes].map(inline).join("").trim()}`);
				break;
			case "ul":
			case "ol": {
				const start = Number(el.getAttribute("start") ?? "1") || 1;
				const items = [...el.children].filter((c) => c.tagName === "LI");
				out.push(items.map((li, i) => listItem(li, tag === "ul" ? "- " : `${start + i}. `)).join("\n"));
				break;
			}
			case "blockquote":
				out.push(
					blocks(el)
						.join("\n\n")
						.split("\n")
						.map((l) => (l ? `> ${l}` : ">"))
						.join("\n"),
				);
				break;
			case "pre": {
				const lang = /language-(\S+)/.exec(el.querySelector("code")?.className ?? "")?.[1] ?? "";
				out.push(fenced(el.textContent ?? "", lang === "plaintext" ? "" : lang));
				break;
			}
			case "code-block": {
				// Only the selected part of the code survives cloning; the language rides on the element.
				const pre = el.querySelector("pre");
				if (!pre) break;
				const lang = el.getAttribute("language") ?? "";
				out.push(fenced(pre.textContent ?? "", lang === "text" ? "" : lang));
				break;
			}
			case "hr":
				out.push("---");
				break;
			case "table":
				out.push(table([el]));
				break;
			case "li":
				out.push(listItem(el, "- "));
				break;
			default:
				out.push(...blocks(el));
		}
	}
	flush();
	flushTable();
	return out.filter(Boolean);
}

function block(node: Node): string {
	return blocks(node).join("\n\n");
}

function rangeToMarkdown(range: Range): string {
	const anchor = range.commonAncestorContainer;
	const anchorEl = anchor instanceof Element ? anchor : anchor.parentElement;
	// Entirely inside one code element: the clone has no <pre>/<code> ancestor, so fence the raw text here.
	const code = anchorEl?.closest("pre, code");
	if (code) {
		const text = range.toString();
		if (code.tagName === "CODE" && !code.closest("pre")) return codeSpan(text);
		const lang =
			code.closest("code-block")?.getAttribute("language") ??
			/language-(\S+)/.exec(code.closest("pre")?.querySelector("code")?.className ?? "")?.[1] ??
			"";
		return fenced(text, lang === "text" || lang === "plaintext" ? "" : lang);
	}
	annotateMath(range);
	return block(range.cloneContents());
}

/** Markdown for the current selection; "" when nothing usable is selected. */
export function selectionToMarkdown(selection: Selection): string {
	const parts: string[] = [];
	for (let i = 0; i < selection.rangeCount; i++) {
		const range = selection.getRangeAt(i);
		if (!range.collapsed) parts.push(rangeToMarkdown(range));
	}
	return parts
		.filter(Boolean)
		.join("\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
