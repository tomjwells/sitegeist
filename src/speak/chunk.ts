/**
 * Split a message's Markdown into chunks for speak (Tom, 2026-11-07: "split long messages at markdown block
 * boundaries (blank lines; keep tables and lists whole) into chunks of about 800 characters").
 *
 * Blocks are separated by blank lines; a fenced code block, a table and a list are each one block. Blocks are packed
 * greedily up to a per-chunk target that ramps up from 120 characters, so the first words come within seconds.
 *
 * Small chunks everywhere (Tom, 2026-11-14: "It plays like forty seconds and then stops to load for like a minute").
 * speak renders one request at a time and a long clip costs more per character, so one 1,813-character list took
 * 80.7 s to render while the panel sat silent. No chunk is now above MAX_CHUNK (400) characters, except a code block,
 * which speak drops anyway. A block that does not fit is split: a paragraph after whole sentences, a list between
 * top-level items (an item longer than the room is cut at sentence ends), a table between rows with its header rows
 * repeated in every piece, so speak still reads each row as "Header: value.". Text is never dropped.
 *
 * Measured 2026-11-14 on the M4 (speak-engine.log, model loaded): the voice speaks ~9.3 characters per second at 1x,
 * and speak applies its default speed 1.3 (atempo) on top, so delivered audio is ~12 characters per second before
 * the panel's own playback rate. Rendering runs at ~25 characters per second for clips up to ~470 characters
 * (110 chars in 4.0 s, 372 in 13.3 s, 463 in 17.7 s) and slows for longer ones (784 in 34.0 s, 1,813 in 80.7 s).
 */

/** Largest chunk (code blocks aside): render time per character grows above ~500 characters. */
export const MAX_CHUNK = 400;
/** Delivered audio per character, speak's 1.3 included. Also sizes the player bar's timeline before a chunk renders. */
export const ESTIMATED_CHARS_PER_SECOND = 12.25;
/** speak's render time is about 0.3 s + characters / 26 (the measurements above). */
export const RENDER_OVERHEAD_SECONDS = 0.3;
export const RENDER_CHARS_PER_SECOND = 26;
/** Plan with rendering 5% slower than measured. */
export const RENDER_SAFETY = 0.95;
/** Chunk size once playback outruns rendering (about 2x and up): even waits of a few seconds, not one long one. */
export const FAST_CHUNK = 250;
export const FIRST_CHUNK = 120;

/** Seconds speak needs for a chunk of this many characters (planning figure, safety included). */
export function renderSeconds(chars: number): number {
	return RENDER_OVERHEAD_SECONDS + chars / (RENDER_CHARS_PER_SECOND * RENDER_SAFETY);
}

/**
 * Chunk targets for a playback speed. The panel keeps speak busy with the next unrendered chunk the whole time
 * (speak-player.ts), so rendering runs ahead and the head start grows while playback is slower than rendering.
 * Each target is the largest chunk that is rendered by the time the one before it has finished playing, up to
 * MAX_CHUNK. When playback outruns rendering (about 2x and up) the targets stay at FAST_CHUNK after the first.
 */
export function targetsForRate(rate: number): readonly number[] {
	const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
	const consume = ESTIMATED_CHARS_PER_SECOND * r;
	const out = [FIRST_CHUNK];
	let rendered = renderSeconds(FIRST_CHUNK);
	let played = rendered + FIRST_CHUNK / consume;
	for (let c = FIRST_CHUNK; c < MAX_CHUNK; ) {
		const next = Math.min(
			MAX_CHUNK,
			Math.floor((played - rendered - RENDER_OVERHEAD_SECONDS) * RENDER_CHARS_PER_SECOND * RENDER_SAFETY),
		);
		if (next < FIRST_CHUNK || out.length >= 40) break; // playback outruns rendering at this speed
		c = next;
		out.push(c);
		rendered += renderSeconds(c);
		played += c / consume;
	}
	if (out.at(-1) !== MAX_CHUNK) out.push(FAST_CHUNK);
	return out;
}

/** The ramp at 1x. */
export const CHUNK_TARGETS: readonly number[] = targetsForRate(1);
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

function targetFor(targets: readonly number[], chunkIndex: number): number {
	return targets[Math.min(chunkIndex, targets.length - 1)] ?? 800;
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
 * The first whole sentences of a paragraph that fit in `room` characters (at least half of `room`, so never a tiny
 * piece), and the rest. Only a first sentence longer than MAX_CHUNK is cut inside, at a space. undefined when there is nothing
 * worth splitting off.
 */
function leadingSentences(text: string, room: number): { head: string; rest: string } | undefined {
	if (room < 60) return undefined;
	const sentences = text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [];
	let head = "";
	for (const s of sentences) {
		// at least half the room: a 40-character piece ends before the next one has rendered
		if (head.length >= room / 2 && head.length + s.length > room) break;
		head += s;
		if (head.length >= room) break;
	}
	if (head.length > Math.max(room * 1.5, MAX_CHUNK)) {
		const space = text.lastIndexOf(" ", room);
		head = text.slice(0, space > room / 2 ? space : room);
	}
	const rest = text.slice(head.length).trim();
	if (!rest || !head.trim()) return undefined;
	return { head: head.trim(), rest };
}

const TOP_ITEM = /^ ?(?:[-*+]|\d{1,9}[.)])\s+/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** A list's lines grouped into top-level items (nested items and continuation lines stay with their item). */
function listItems(text: string): string[] {
	const items: string[][] = [];
	for (const line of text.split("\n")) {
		const last = items.at(-1);
		if (!last || TOP_ITEM.test(line)) items.push([line]);
		else last.push(line);
	}
	return items.map((lines) => lines.join("\n").replace(/\s+$/, ""));
}

/**
 * Split off the front of a block so it fits in `room` characters. Paragraph: whole sentences. List: whole top-level
 * items (a first item longer than the room is cut at sentence ends). Table: whole rows, the header rows repeated in
 * the rest. Code, headings and other blocks are never split here. undefined = cannot split.
 */
function splitBlock(block: Block, room: number): { head: string; rest: Block } | undefined {
	if (block.kind === "paragraph") {
		const cut = leadingSentences(block.text, room);
		return cut ? { head: cut.head, rest: { kind: "paragraph", text: cut.rest } } : undefined;
	}
	if (block.kind === "list") {
		const items = listItems(block.text);
		const first = items[0] ?? "";
		if (items.length < 2 || first.length > room * 1.25) {
			const cut = leadingSentences(first, Math.max(room, 60));
			if (!cut) {
				if (items.length < 2) return undefined;
				return { head: first, rest: { kind: "list", text: items.slice(1).join("\n") } };
			}
			const rest = [cut.rest, ...items.slice(1)].join("\n");
			return { head: cut.head, rest: { kind: "list", text: rest } };
		}
		let n = 1;
		let len = first.length;
		while (n < items.length - 1 && len + 1 + (items[n]?.length ?? 0) <= room) len += 1 + (items[n++]?.length ?? 0);
		return { head: items.slice(0, n).join("\n"), rest: { kind: "list", text: items.slice(n).join("\n") } };
	}
	if (block.kind === "table") {
		const lines = block.text.split("\n");
		const header = TABLE_SEPARATOR.test(lines[1] ?? "") ? lines.slice(0, 2) : [];
		const rows = lines.slice(header.length);
		if (rows.length < 2) return undefined;
		const head = [...header];
		let len = head.join("\n").length;
		let n = 0;
		while (n < rows.length - 1 && (n === 0 || len + 1 + (rows[n]?.length ?? 0) <= room)) {
			len += 1 + (rows[n]?.length ?? 0);
			head.push(rows[n++] ?? "");
		}
		return { head: head.join("\n"), rest: { kind: "table", text: [...header, ...rows.slice(n)].join("\n") } };
	}
	return undefined;
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

/**
 * Message Markdown -> chunks to send to speak, in reading order. Empty input -> []. Blocks are packed up to each
 * chunk's target; a block that would take a chunk past its target is split (splitBlock) when it can be (a chunk
 * just 20% over its target already cost a 1.6 s silence at 1.25x in the simulation in tests/speak.test.ts). Paragraphs, list items and table rows are never cut inside unless one alone is too long.
 */
export function chunkMarkdown(markdown: string, targets: readonly number[] = CHUNK_TARGETS): string[] {
	const queue: Block[] = [];
	for (const b of splitBlocks(markdown)) {
		if (b.text.length <= HARD_CAP) queue.push(b);
		else {
			const parts = b.kind === "paragraph" ? cutSentences(b.text, HARD_CAP) : cutLines(b.text, HARD_CAP);
			for (const p of parts) queue.push({ kind: b.kind, text: p });
		}
	}
	const chunks: string[] = [];
	let cur = "";
	for (let guard = 0; queue.length > 0 && guard < 100_000; guard++) {
		const piece = queue.shift();
		if (!piece) break;
		const target = Math.min(MAX_CHUNK, targetFor(targets, chunks.length));
		const joined = cur ? cur.length + 2 + piece.text.length : piece.text.length;
		if (joined <= target) {
			cur = cur ? `${cur}\n\n${piece.text}` : piece.text;
			continue;
		}
		{
			const room = target - (cur ? cur.length + 2 : 0);
			const split = room >= 60 || !cur ? splitBlock(piece, room) : undefined;
			// joined to text already in the chunk, a split-off front must fit; alone it is the best there is
			if (split && (!cur || split.head.length <= room * 1.25)) {
				chunks.push(cur ? `${cur}\n\n${split.head}` : split.head);
				cur = "";
				queue.unshift(split.rest);
				continue;
			}
		}
		if (cur) {
			// the piece starts the next chunk (and is split there if it is still too big)
			chunks.push(cur);
			cur = "";
			queue.unshift(piece);
			continue;
		}
		cur = piece.text; // cannot be split (a code block, a heading): whole
	}
	if (cur.trim()) chunks.push(cur);
	return chunks;
}
