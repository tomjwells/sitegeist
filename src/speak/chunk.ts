/**
 * Split a message's Markdown into chunks for speak (Tom, 2026-11-07: "split long messages at markdown block
 * boundaries (blank lines; keep tables and lists whole) into chunks of about 800 characters").
 *
 * Blocks are separated by blank lines. A fenced code block, a table and a list (items, nested items, continuation
 * lines and the blank lines between items) each stay one block. Blocks are packed greedily up to a per-chunk target.
 * The targets ramp up (250, 500, then 800): speak renders about 2.5x faster than real time, so an 800-character
 * first chunk (~50 s of speech) would take ~20 s before anything plays; a 250-character one takes ~5 s, and every
 * later chunk renders while the one before it plays. Only a paragraph may be cut inside, at sentence ends, and only
 * when it is longer than the first chunk's target or longer than the hard cap. Tables, lists and code are cut (at
 * line ends) only above the hard cap, which keeps every request under speak's 5,000-character limit.
 */

export const CHUNK_TARGETS: readonly number[] = [250, 500, 800];
/** speak's limit is 5,000 characters after prepare; prepare can lengthen text ("~2 GB" -> "about 2 gigabytes"). */
export const HARD_CAP = 4000;

type BlockKind = "paragraph" | "list" | "table" | "code" | "heading" | "other";
interface Block {
	kind: BlockKind;
	text: string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const INDENTED = /^(?:\s{2,}|\t)\S/;
const TABLE_ROW = /^\s{0,3}\|/;
const HEADING = /^\s{0,3}#{1,6}\s/;

function targetFor(chunkIndex: number): number {
	return CHUNK_TARGETS[Math.min(chunkIndex, CHUNK_TARGETS.length - 1)] ?? 800;
}

/** Markdown -> blocks. Never drops text: joining the blocks with blank lines gives the input back (modulo blank-line runs). */
export function splitBlocks(markdown: string): Block[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;
	const push = (kind: BlockKind, from: number, to: number) => {
		const text = lines.slice(from, to).join("\n").replace(/\s+$/, "");
		if (text.trim()) blocks.push({ kind, text });
	};
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (!line.trim()) {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const marker = fence[1] ?? "```";
			let j = i + 1;
			while (j < lines.length && !(lines[j] ?? "").trimStart().startsWith(marker)) j++;
			push("code", i, Math.min(j + 1, lines.length));
			i = j + 1;
			continue;
		}
		if (TABLE_ROW.test(line)) {
			let j = i + 1;
			while (j < lines.length && TABLE_ROW.test(lines[j] ?? "")) j++;
			push("table", i, j);
			i = j;
			continue;
		}
		if (LIST_ITEM.test(line)) {
			let j = i + 1;
			for (;;) {
				const next = lines[j];
				if (next === undefined) break;
				if (
					next.trim() &&
					(LIST_ITEM.test(next) ||
						INDENTED.test(next) ||
						(!HEADING.test(next) &&
							!TABLE_ROW.test(next) &&
							!FENCE.test(next) &&
							(lines[j - 1] ?? "").trim() !== ""))
				) {
					j++;
					continue;
				}
				if (!next.trim()) {
					// a blank line inside a list: the list goes on if the next non-blank line is an item or indented
					let k = j + 1;
					while (k < lines.length && !(lines[k] ?? "").trim()) k++;
					const after = lines[k];
					if (after !== undefined && (LIST_ITEM.test(after) || INDENTED.test(after))) {
						j = k;
						continue;
					}
				}
				break;
			}
			push("list", i, j);
			i = j;
			continue;
		}
		if (HEADING.test(line)) {
			push("heading", i, i + 1);
			i++;
			continue;
		}
		let j = i + 1;
		while (j < lines.length) {
			const next = lines[j] ?? "";
			if (!next.trim() || FENCE.test(next) || TABLE_ROW.test(next) || HEADING.test(next) || LIST_ITEM.test(next))
				break;
			j++;
		}
		push("paragraph", i, j);
		i = j;
	}
	return blocks;
}

/** Cut text into pieces of at most `max` characters at sentence ends, else at spaces, else hard. */
function cutSentences(text: string, max: number): string[] {
	const sentences = text.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)\s*/g) ?? [text];
	const out: string[] = [];
	let cur = "";
	const flush = () => {
		if (cur.trim()) out.push(cur.trim());
		cur = "";
	};
	for (const s of sentences) {
		if (cur && cur.length + s.length > max) flush();
		if (s.length > max) {
			let rest = s;
			while (rest.length > max) {
				const space = rest.lastIndexOf(" ", max);
				const at = space > max / 2 ? space : max;
				out.push(rest.slice(0, at).trim());
				rest = rest.slice(at);
			}
			cur = rest;
		} else cur += s;
	}
	flush();
	return out;
}

/**
 * The first whole sentences of a paragraph that fit in `room` characters (at least one sentence, if it is shorter than
 * the paragraph), and the rest. undefined when the paragraph is a single sentence or there is no room worth using.
 */
function leadingSentences(text: string, room: number): { head: string; rest: string } | undefined {
	if (room < 60) return undefined;
	const sentences = text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [];
	let head = "";
	for (const s of sentences) {
		if (head && head.length + s.length > room) break;
		head += s;
		if (head.length >= room) break;
	}
	const rest = text.slice(head.length).trim();
	if (!rest || head.length > HARD_CAP) return undefined;
	return { head: head.trim(), rest };
}

/** Cut a table/list/code block above the hard cap at line ends. */
function cutLines(text: string, max: number): string[] {
	const out: string[] = [];
	let cur = "";
	for (const line of text.split("\n")) {
		if (cur && cur.length + 1 + line.length > max) {
			out.push(cur);
			cur = "";
		}
		if (line.length > max) {
			out.push(...cutSentences(line, max));
			continue;
		}
		cur = cur ? `${cur}\n${line}` : line;
	}
	if (cur.trim()) out.push(cur);
	return out;
}

/** Message Markdown -> chunks to send to speak, in reading order. Empty input -> []. */
export function chunkMarkdown(markdown: string): string[] {
	const pieces: Block[] = [];
	for (const b of splitBlocks(markdown)) {
		if (b.text.length <= HARD_CAP) pieces.push(b);
		else {
			const parts = b.kind === "paragraph" ? cutSentences(b.text, HARD_CAP) : cutLines(b.text, HARD_CAP);
			for (const p of parts) pieces.push({ kind: b.kind, text: p });
		}
	}
	const chunks: string[] = [];
	let cur = "";
	for (let n = 0; n < pieces.length; n++) {
		const piece = pieces[n];
		if (!piece) continue;
		const target = targetFor(chunks.length);
		// First chunk only: a long opening paragraph is cut after whole sentences, so speech starts within seconds.
		if (chunks.length === 0 && piece.kind === "paragraph" && cur.length + 2 + piece.text.length > target) {
			const split = leadingSentences(piece.text, target - (cur ? cur.length + 2 : 0));
			if (split) {
				chunks.push(cur ? `${cur}\n\n${split.head}` : split.head);
				cur = "";
				pieces.splice(n + 1, 0, { kind: "paragraph", text: split.rest });
				continue;
			}
		}
		if (!cur) {
			cur = piece.text;
			continue;
		}
		if (cur.length + 2 + piece.text.length <= target) cur = `${cur}\n\n${piece.text}`;
		else {
			chunks.push(cur);
			cur = piece.text;
		}
	}
	if (cur.trim()) chunks.push(cur);
	return chunks;
}
