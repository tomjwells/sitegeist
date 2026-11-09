/**
 * Split a message's Markdown into chunks for speak (Tom, 2026-11-07: "split long messages at markdown block
 * boundaries (blank lines; keep tables and lists whole) into chunks of about 800 characters").
 *
 * Blocks are separated by blank lines. A fenced code block, a table and a list (items, nested items, continuation
 * lines and the blank lines between items) each stay one block. Blocks are packed greedily up to a per-chunk target.
 * The targets ramp up (120, 250, 500, then 800). Measured 2026-11-07 on the M4, model loaded: speech is ~10 characters
 * per second and speak renders ~20-23 characters per second (149 chars: 13.1 s of audio in 7.4 s; 665 chars: 65.4 s
 * in 28.4 s). An 800-character first chunk would mean ~35 s of silence; 120 characters start in ~6 s. Each target is
 * at most about twice the one before, so the next chunk renders in about the time the current one plays.
 * Only a paragraph is ever cut inside, at sentence ends: when it opens the message and is over 1.5x the first target
 * (the first piece is then at least half the target), or when it is longer than the hard cap. Tables, lists and code
 * are cut (at line ends) only above the hard cap, which keeps every request under speak's 5,000-character limit.
 *
 * Faster playback (2026-11-09, speed menu): at 1.75x a chunk is heard in 4/7 of the time, so a next chunk twice its
 * size is not ready when it ends (predicted waits of 4-9 s after each of the first three chunks). targetsForRate
 * gives a gentler ramp for speeds above 1x, from the same measurements.
 */

export const CHUNK_TARGETS: readonly number[] = [120, 250, 500, 800];
/** speak's voice at 1x (the measurements above). Also sizes the player bar's timeline before a chunk is rendered. */
export const ESTIMATED_CHARS_PER_SECOND = 10;
/** speak's render time is about 1.35 s + characters / 24.6 (a line through the two measurements above). */
export const RENDER_OVERHEAD_SECONDS = 1.35;
export const RENDER_CHARS_PER_SECOND = 24.6;

/**
 * Chunk targets for a playback speed. Each target is the largest chunk that renders in the time the one before it
 * plays at that speed (growing by at least 15 characters, so the ramp always reaches 800). At 1x or slower: the
 * measured default ramp. Above 2x playback outruns rendering whatever the chunk size, so the default ramp is used
 * there too: a few longer waits are better than a short wait after every small chunk.
 */
export function targetsForRate(rate: number): readonly number[] {
	if (!(rate > 1) || rate > 2) return CHUNK_TARGETS;
	const first = CHUNK_TARGETS[0] ?? 120;
	const last = CHUNK_TARGETS[CHUNK_TARGETS.length - 1] ?? 800;
	const out = [first];
	for (let c = first; c < last; ) {
		const playSeconds = c / (ESTIMATED_CHARS_PER_SECOND * rate);
		const fits = Math.floor(RENDER_CHARS_PER_SECOND * (playSeconds - RENDER_OVERHEAD_SECONDS));
		c = Math.min(last, Math.max(c + 15, fits));
		out.push(c);
	}
	return out;
}
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
 * first chunk), and the rest. undefined when the paragraph is a single sentence or there is no room worth using.
 */
function leadingSentences(text: string, room: number): { head: string; rest: string } | undefined {
	if (room < 60) return undefined;
	const sentences = text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [];
	let head = "";
	for (const s of sentences) {
		// at least half the room: a 40-character first chunk ends before the next one has rendered
		if (head.length >= room / 2 && head.length + s.length > room) break;
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
export function chunkMarkdown(markdown: string, targets: readonly number[] = CHUNK_TARGETS): string[] {
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
		const target = targetFor(targets, chunks.length);
		// First chunk only: a long opening paragraph is cut after whole sentences, so speech starts within seconds.
		if (chunks.length === 0 && piece.kind === "paragraph" && cur.length + 2 + piece.text.length > target * 1.5) {
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
