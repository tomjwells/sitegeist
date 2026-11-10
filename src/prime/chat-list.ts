/**
 * One chat list for every browser (Tom, 2026-11-10: "view a session created on Omarchy on the m4").
 *
 * Each browser kept its own list of chats in its own storage, so a chat started in one browser was not in the list
 * of another. The list of R730 chats is now kept on the R730 (relay POST /chats/sync): a browser sends the entries
 * it changed and gets back what changed elsewhere. This file holds the rules, with no imports and no browser calls
 * (unit-tested: tests/chat-list.test.ts). The calls are in chat-list-sync.ts, the storage in sessions-store.ts.
 *
 * A chat in the list that this browser has no copy of is "list only" (`sgListOnly`): one small entry, no messages.
 * Opening it loads it from the R730, as opening a chat by its id always did.
 *
 * Marks on a stored list entry:
 *  - `sgListOnly: true`  the chat was never opened in this browser;
 *  - `sgUsedHere: <time>` when this browser itself last saved the chat. The panel resumes the chat with the latest
 *    one at start, never a chat that was only used elsewhere: the agent's browser tools act on the newest panel
 *    attached to a chat, so opening a panel here must not take over a chat Tom is using on another machine;
 *  - `sgBehind: true`    another browser used the chat later; this browser's copy of the messages is older (the
 *    R730 copy replaces it on the next open). Such a copy is not indexed for search again and again.
 */

/** One entry of the list as the R730 keeps it. */
export interface RemoteChat {
	id: string;
	agentId: string;
	title: string;
	createdAt: string;
	lastModified: string;
	messageCount: number;
	preview: string;
	modelId?: string;
	thinkingLevel?: string;
	usage?: Record<string, unknown>;
	/** Deleted in some browser at this time: every browser drops the chat, unless it was used here after that. */
	deletedAt?: string;
	rev: number;
}

/** What this file reads of a list entry stored in the browser (pi-web-ui's SessionMetadata has all of it). */
export interface ListedChat {
	id: string;
	title: string;
	lastModified: string;
	messageCount: number;
	preview: string;
}

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const CHAT_ID_RE = /^sg-[A-Za-z0-9_.-]{1,80}$/;

/** One entry of the relay's answer, when it is a usable one. */
export function remoteChatOf(v: unknown): RemoteChat | undefined {
	if (!isFields(v)) return undefined;
	const { id, agentId, title, createdAt, lastModified, messageCount, preview, rev } = v;
	if (typeof id !== "string" || !CHAT_ID_RE.test(id) || typeof agentId !== "string") return undefined;
	if (typeof title !== "string" || typeof createdAt !== "string" || typeof lastModified !== "string") return undefined;
	if (typeof messageCount !== "number" || typeof preview !== "string" || typeof rev !== "number") return undefined;
	return {
		id,
		agentId,
		title,
		createdAt,
		lastModified,
		messageCount,
		preview,
		rev,
		...(typeof v.modelId === "string" ? { modelId: v.modelId } : {}),
		...(typeof v.thinkingLevel === "string" ? { thinkingLevel: v.thinkingLevel } : {}),
		...(isFields(v.usage) ? { usage: v.usage } : {}),
		...(typeof v.deletedAt === "string" ? { deletedAt: v.deletedAt } : {}),
	};
}

export const isListOnly = (entry: object): boolean => "sgListOnly" in entry && entry.sgListOnly === true;
export const isBehind = (entry: object): boolean => "sgBehind" in entry && entry.sgBehind === true;

/** When this browser itself last used the chat; "" for a chat it never opened. */
export function usedHere(entry: ListedChat): string {
	if ("sgUsedHere" in entry && typeof entry.sgUsedHere === "string") return entry.sgUsedHere;
	// Entries saved before the shared list existed were all written by this browser.
	return isListOnly(entry) ? "" : entry.lastModified;
}

/** The chat to resume when the panel starts: the one this browser used last (see the file comment). */
export function latestUsedHere(entries: ListedChat[]): string | null {
	let best: ListedChat | undefined;
	let bestAt = "";
	for (const entry of entries) {
		const at = usedHere(entry);
		if (at > bestAt) {
			best = entry;
			bestAt = at;
		}
	}
	return best?.id ?? null;
}

/**
 * What one entry from the R730 means for this browser:
 *  - "add":     not in this browser's list: add it, list only;
 *  - "refresh": list only here, and its title, time or size changed;
 *  - "behind":  this browser has a copy, and the chat was used later elsewhere: take the newer title, time and size;
 *  - "remove":  deleted elsewhere: drop it here;
 *  - "none":    nothing to do (this browser's entry is the same or newer; it is sent when newer).
 */
export type Decision = "add" | "refresh" | "behind" | "remove" | "none";

export function decide(local: ListedChat | null | undefined, remote: RemoteChat): Decision {
	if (remote.deletedAt !== undefined) {
		if (!local) return "none";
		// Used here after the delete: it stays, and the next sync brings it back for the other browsers.
		if (!isListOnly(local) && local.lastModified > remote.deletedAt) return "none";
		return "remove";
	}
	if (!local) return "add";
	if (isListOnly(local)) {
		const same =
			local.lastModified === remote.lastModified &&
			local.title === remote.title &&
			local.messageCount === remote.messageCount &&
			local.preview === remote.preview;
		return same ? "none" : "refresh";
	}
	return remote.lastModified > local.lastModified ? "behind" : "none";
}

/**
 * The entries to send: chats this browser has a copy of whose entry changed since it was last sent (`sent`: chat
 * id -> the lastModified that was sent, or that came from the R730). List-only entries came from the R730 and are
 * never sent back.
 */
export function chatsToSend<T extends ListedChat>(entries: T[], sent: Record<string, string>, max: number): T[] {
	return entries.filter((entry) => !isListOnly(entry) && sent[entry.id] !== entry.lastModified).slice(0, max);
}

/** What the browser remembers between two syncs. */
export interface ChatListSyncState {
	/** The R730 list this state belongs to. Another id (the list's folder was emptied): send everything again. */
	storeId: string;
	/** The list's counter at the last answer: the next call asks for what changed after it. */
	rev: number;
	sent: Record<string, string>;
}

export function syncStateOf(v: unknown): ChatListSyncState {
	if (!isFields(v) || typeof v.storeId !== "string" || typeof v.rev !== "number" || !isFields(v.sent))
		return { storeId: "", rev: 0, sent: {} };
	const sent: Record<string, string> = {};
	for (const [id, at] of Object.entries(v.sent)) if (typeof at === "string") sent[id] = at;
	return { storeId: v.storeId, rev: v.rev, sent };
}

/** A chat deleted in this browser that the R730 has not been told about yet. */
export interface PendingDelete {
	id: string;
	deletedAt: string;
}

export function pendingDeletesOf(v: unknown): PendingDelete[] {
	if (!Array.isArray(v)) return [];
	return v.flatMap((d: unknown): PendingDelete[] =>
		isFields(d) && typeof d.id === "string" && typeof d.deletedAt === "string"
			? [{ id: d.id, deletedAt: d.deletedAt }]
			: [],
	);
}
