/**
 * Search text of R730 chats, shared between browsers (stage 4 of "chats stored remotely"). Each browser builds a
 * search text for every chat it has opened (sessions/session-search.ts buildSearchText) and searches it from the
 * sessions list. A chat from another browser was found by title and preview only. Now the text is kept on the
 * R730 too (relay POST/GET /chats/text): a browser sends the text it built, and fetches the text of chats it has
 * not opened. The list entry's `textAt` (chat-list.ts RemoteChat) says what the R730's text is built from.
 * No imports, no browser calls: unit-tested (tests/chat-text.test.ts). The calls are in chat-list-sync.ts.
 */

/** What this file reads of a search record in the browser (sessions/session-search.ts SearchRecord has all of it). */
export interface TextRecord {
	id: string;
	/** The chat's lastModified the text was built from. */
	lastModified: string;
	/** Set when the text came from the R730 (its textAt then): such a text is never sent back. */
	textFrom?: string;
}

/** Texts per call (the relay takes 50). */
export const TEXT_PUSH_PER_CALL = 50;
/** Chars per push call: the first sync of a browser with many chats goes out in pieces, not one 20 MB request. */
export const TEXT_PUSH_MAX_CHARS = 2 * 1024 * 1024;
/** Chats per fetch; the rest come with later syncs. */
export const TEXT_PULL_PER_CALL = 20;

/**
 * Texts this browser built that the R730 does not have in this form: no `textFrom` (built here, not fetched),
 * and built from a later state of the chat than the R730's text (`textAt`, "" when the R730 has none).
 * Newest first, so the chats Tom is working in are searchable elsewhere first.
 */
export function textToPush<T extends TextRecord & { text: string }>(
	records: T[],
	textAt: Record<string, string>,
	isShared: (id: string) => boolean,
): T[] {
	const out: T[] = [];
	let chars = 0;
	const sorted = [...records].sort((a, b) =>
		a.lastModified < b.lastModified ? 1 : a.lastModified > b.lastModified ? -1 : 0,
	);
	for (const r of sorted) {
		if (!isShared(r.id) || r.textFrom !== undefined || !r.text) continue;
		if ((textAt[r.id] ?? "") >= r.lastModified) continue;
		if (out.length >= TEXT_PUSH_PER_CALL || (out.length > 0 && chars + r.text.length > TEXT_PUSH_MAX_CHARS)) break;
		out.push(r);
		chars += r.text.length;
	}
	return out;
}

/**
 * Chats whose text the R730 has in a later form than this browser: no record here, or a record built from an
 * earlier state of the chat (a fetched one carries the R730's stamp in `textFrom`; one built here, its
 * lastModified). Newest first.
 */
export function textToPull(
	records: TextRecord[],
	textAt: Record<string, string>,
	lastModifiedOf: Record<string, string>,
): string[] {
	const have = new Map(records.map((r) => [r.id, r.textFrom ?? r.lastModified]));
	return Object.entries(textAt)
		.filter(([id, at]) => at !== "" && (have.get(id) ?? "") < at)
		.sort(([a], [b]) => {
			const la = lastModifiedOf[a] ?? "";
			const lb = lastModifiedOf[b] ?? "";
			return la < lb ? 1 : la > lb ? -1 : 0;
		})
		.slice(0, TEXT_PULL_PER_CALL)
		.map(([id]) => id);
}

/** One chat's text as the relay sends it, when it is usable. */
export interface RemoteText {
	id: string;
	textAt: string;
	text: string;
}
export function remoteTextOf(v: unknown): RemoteText | undefined {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
	const o = v as Record<string, unknown>;
	if (typeof o.id !== "string" || typeof o.textAt !== "string" || typeof o.text !== "string") return undefined;
	return { id: o.id, textAt: o.textAt, text: o.text };
}
