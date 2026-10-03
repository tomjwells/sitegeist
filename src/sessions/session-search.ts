/**
 * Full-text search over sessions for the sessions sidebar. Pure string logic (tests/session-search.test.ts);
 * the IndexedDB side lives in storage/stores/session-search-store.ts.
 *
 * Why (Tom, 2026-10-03): the sidebar searched only the title + a 2 KB preview, fuzzily (Fuse, threshold
 * 0.4), so "corne" returned twenty unrelated sessions and buried the one where the word appears 145
 * times under its auto title "Help me with this video.". This indexes the whole transcript and matches
 * exact, case-insensitive terms (all terms must occur), ranked by hits, with a highlighted snippet.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Per-session text cap; the full text of practically every session fits, and memory stays bounded. */
export const SEARCH_TEXT_MAX_CHARS = 256 * 1024;

export interface SearchRecord {
	id: string;
	/** Session lastModified the text was built from; differs from metadata → rebuild. */
	lastModified: string;
	messageCount: number;
	text: string;
	/** Other ids this session is known by (a prime session's native UUID and jsonl path on the R730). */
	aliases?: string[];
}

export interface SearchEntry {
	id: string;
	title: string;
	text: string;
	/** Extra searchable text not in the transcript (bound page titles/URLs). */
	extra?: string;
	lastModified: string;
}

export interface SnippetSegment {
	text: string;
	hit: boolean;
}

export interface SearchHit {
	id: string;
	/** Occurrences of the query terms (title hits weighted); ties broken by recency by the caller. */
	score: number;
	hits: number;
	snippet: SnippetSegment[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
	}
	return parts.join("\n");
}

/** Everything a person might remember a session by: what was said, tool output, pages visited, files. */
export function buildSearchText(messages: AgentMessage[], title = ""): string {
	const parts: string[] = [];
	let length = 0;
	const push = (s: string) => {
		if (!s || length >= SEARCH_TEXT_MAX_CHARS) return;
		const room = SEARCH_TEXT_MAX_CHARS - length;
		const piece = s.length > room ? s.slice(0, room) : s;
		parts.push(piece);
		length += piece.length + 1;
	};
	push(title);
	for (const m of messages) {
		const msg = m as Record<string, unknown>;
		switch (msg.role) {
			case "user":
			case "assistant":
			case "user-with-attachments": {
				push(textOf(msg.content));
				const atts = msg.attachments;
				if (Array.isArray(atts))
					for (const a of atts) {
						const name = (a as { fileName?: unknown }).fileName;
						if (typeof name === "string") push(name);
					}
				break;
			}
			case "toolResult":
				push(textOf(msg.content));
				break;
			case "navigation":
				push([msg.title, msg.url].filter((v): v is string => typeof v === "string").join(" "));
				break;
			case "artifact":
				push([msg.filename, msg.title].filter((v): v is string => typeof v === "string").join(" "));
				break;
			default:
				break;
		}
	}
	return parts.join("\n");
}

/** Words, with "quoted phrases" kept together (as session-finder does): `"corne v4" vial` → ["corne v4", "vial"]. */
export function queryTerms(query: string): string[] {
	const terms: string[] = [];
	const re = /"([^"]*)"|(\S+)/g;
	for (let m = re.exec(query.toLowerCase()); m !== null; m = re.exec(query.toLowerCase())) {
		const t = (m[1] ?? m[2] ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.replace(/^"+|"+$/g, "");
		if (t) terms.push(t);
	}
	return Array.from(new Set(terms));
}

/** Which sitegeist session a pasted native id belongs to, given sg-id → native ids (relay /native-ids). */
export function sgIdForNative(nativeId: string, nativeIds: ReadonlyMap<string, string[]>): string | undefined {
	const needle = nativeId.toLowerCase();
	for (const [sg, ids] of nativeIds) if (ids.some((id) => id.toLowerCase() === needle)) return sg;
	return undefined;
}

function countOccurrences(haystack: string, needle: string, cap = 1000): number {
	let count = 0;
	let from = 0;
	while (count < cap) {
		const i = haystack.indexOf(needle, from);
		if (i < 0) break;
		count++;
		from = i + needle.length;
	}
	return count;
}

const SNIPPET_RADIUS = 70;

/** ~140 chars around the first occurrence of the first term, with every term occurrence marked. */
export function snippetAround(text: string, lowerText: string, terms: string[]): SnippetSegment[] {
	let at = -1;
	let hitTerm = "";
	for (const t of terms) {
		const i = lowerText.indexOf(t);
		if (i >= 0 && (at < 0 || i < at)) {
			at = i;
			hitTerm = t;
		}
	}
	if (at < 0) return [{ text: text.slice(0, SNIPPET_RADIUS * 2).replace(/\s+/g, " "), hit: false }];
	let start = Math.max(0, at - SNIPPET_RADIUS);
	let end = Math.min(text.length, at + hitTerm.length + SNIPPET_RADIUS);
	// snap to word boundaries where cheap
	if (start > 0) {
		const ws = lowerText.lastIndexOf(" ", at);
		if (ws >= start) start = ws + 1;
	}
	if (end < text.length) {
		const ws = lowerText.indexOf(" ", end);
		if (ws >= 0 && ws - end < 20) end = ws;
	}
	const window = text.slice(start, end).replace(/\s+/g, " ");
	const lowerWindow = window.toLowerCase();
	const marks: Array<[number, number]> = [];
	for (const t of terms) {
		let from = 0;
		for (;;) {
			const i = lowerWindow.indexOf(t, from);
			if (i < 0) break;
			marks.push([i, i + t.length]);
			from = i + t.length;
		}
	}
	marks.sort((a, b) => a[0] - b[0]);
	const segments: SnippetSegment[] = [];
	let cursor = 0;
	for (const [s, e] of marks) {
		if (s < cursor) continue; // overlapping term
		if (s > cursor) segments.push({ text: window.slice(cursor, s), hit: false });
		segments.push({ text: window.slice(s, e), hit: true });
		cursor = e;
	}
	if (cursor < window.length) segments.push({ text: window.slice(cursor), hit: false });
	if (start > 0) segments.unshift({ text: "…", hit: false });
	if (end < text.length) segments.push({ text: "…", hit: false });
	return segments;
}

/** Session/bridge ids as they appear in session-finder, Telegram and the CLI: sg-<hex>, sg-<agent>-<hex>, UUIDs. */
const ID_RE = /^(?:sg-[a-z0-9-]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,})$/i;

/** "sg-95134e79fa34", "/session_resume <uuid>", a pasted jsonl path … → the id inside, or undefined. */
export function pastedSessionId(query: string): string | undefined {
	const q = query.trim();
	if (!q) return undefined;
	if (ID_RE.test(q)) return q.toLowerCase();
	const tokens = q.split(/[\s/]+/).map((t) => t.replace(/\.jsonl$/i, ""));
	const last = [...tokens].reverse().find((t) => ID_RE.test(t));
	return last?.toLowerCase();
}

/** Sessions whose id — or an alias (prime UUID / jsonl path) — contains the pasted id. */
export function sessionsMatchingId(id: string, entries: Array<{ id: string; aliases?: string[] }>): string[] {
	const needle = id.toLowerCase();
	return entries
		.filter(
			(e) => e.id.toLowerCase().includes(needle) || (e.aliases ?? []).some((a) => a.toLowerCase().includes(needle)),
		)
		.map((e) => e.id);
}

/**
 * All query terms must occur (case-insensitive substring) in title, transcript or extra text. Ranked by
 * occurrences (title hits ×20), then recency.
 */
export function searchSessions(query: string, entries: SearchEntry[]): SearchHit[] {
	const terms = queryTerms(query);
	if (terms.length === 0) return [];
	const hits: Array<SearchHit & { lastModified: string }> = [];
	for (const e of entries) {
		const title = e.title.toLowerCase();
		const body = `${e.text}\n${e.extra ?? ""}`;
		const lowerBody = body.toLowerCase();
		let ok = true;
		let score = 0;
		let total = 0;
		for (const t of terms) {
			const inTitle = countOccurrences(title, t);
			const inBody = countOccurrences(lowerBody, t);
			if (inTitle + inBody === 0) {
				ok = false;
				break;
			}
			score += inTitle * 20 + inBody;
			total += inTitle + inBody;
		}
		if (!ok) continue;
		// Snippet from the body when it has a hit, else from the title (the row already shows the title).
		const snippet = terms.some((t) => lowerBody.includes(t))
			? snippetAround(body, lowerBody, terms)
			: snippetAround(e.title, title, terms);
		hits.push({ id: e.id, score, hits: total, snippet, lastModified: e.lastModified });
	}
	hits.sort(
		(a, b) => b.score - a.score || (a.lastModified < b.lastModified ? 1 : a.lastModified > b.lastModified ? -1 : 0),
	);
	return hits.map(({ lastModified: _lm, ...hit }) => hit);
}
