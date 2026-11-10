/**
 * Keeps this browser's list of R730 chats and the R730's list the same (rules: chat-list.ts; relay: POST
 * <sync url>/chats/sync). Best effort: with the R730 out of reach the browser's own list works as before, and
 * what changed here is sent by the next sync that gets through.
 */
import { getSitegeistStorage } from "../storage/app-storage.js";
import { CHATS_DELETED_SETTING } from "../storage/stores/sessions-store.js";
import { type ChatListSyncState, chatsToSend, pendingDeletesOf, syncStateOf } from "./chat-list.js";
import { agentIdFromSessionId, isPrimeSessionId } from "./constants.js";
import { primeChatsSync } from "./prime-client.js";

export const CHATS_SYNC_STATE_SETTING = "chats.sync.state";
/** Entries per call; the rest go with the next call (the relay takes 3000). */
const MAX_PER_CALL = 2000;
const PREVIEW_MAX = 400;

export interface ChatListSyncResult {
	ok: boolean;
	/** Chats from other browsers added to this browser's list. */
	added: number;
	/** Entries here that took a newer title, time or size from the R730. */
	updated: number;
	/** Chats deleted in another browser and dropped here. */
	removed: string[];
	/** Entries and deletes sent. */
	sent: number;
	error?: string;
}

const listeners = new Set<(result: ChatListSyncResult) => void>();
/** Called after every sync that got an answer. */
export function onChatListSynced(fn: (result: ChatListSyncResult) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

let running: Promise<ChatListSyncResult> | undefined;
let lastRunAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** When the waiting timer fires. */
let timerAt = 0;

/** Sync now. A call while a sync runs gets that run's result. */
export function syncChatList(): Promise<ChatListSyncResult> {
	running ??= run().finally(() => {
		running = undefined;
		lastRunAt = Date.now();
	});
	return running;
}

/**
 * Sync soon: at once when the last sync is older than `minGapMs`, else when that gap has passed. Something that
 * changed while a sync was running is sent by one more sync after it. Many requests make one sync.
 */
export function requestChatListSync(minGapMs = 20_000): void {
	const at = Math.max(Date.now(), lastRunAt + minGapMs);
	if (timer) {
		if (timerAt <= at) return;
		clearTimeout(timer); // a request that may not wait as long (a delete) moves the sync forward
	}
	timerAt = at;
	timer = setTimeout(() => {
		timer = undefined;
		void (async () => {
			if (running) await running.catch(() => undefined);
			await syncChatList();
		})();
	}, at - Date.now());
}

async function run(): Promise<ChatListSyncResult> {
	const storage = getSitegeistStorage();
	const result: ChatListSyncResult = { ok: false, added: 0, updated: 0, removed: [], sent: 0 };
	try {
		let state: ChatListSyncState = syncStateOf(await storage.settings.get(CHATS_SYNC_STATE_SETTING));
		// Two rounds at most: the second only when the R730's list turned out to be a new one.
		for (let round = 0; round < 2; round++) {
			const entries = (await storage.sessions.getAllMetadata()).filter((m) => isPrimeSessionId(m.id));
			const outgoing = chatsToSend(entries, state.sent, MAX_PER_CALL);
			const deleted = pendingDeletesOf(await storage.settings.get(CHATS_DELETED_SETTING));
			const answer = await primeChatsSync({
				storeId: state.storeId,
				since: state.rev,
				chats: outgoing.map((m) => ({
					...m,
					agentId: agentIdFromSessionId(m.id),
					// An entry written by an old panel may have no preview.
					preview: (typeof m.preview === "string" ? m.preview : "").slice(0, PREVIEW_MAX),
				})),
				deleted: deleted.map((d) => ({ ...d, agentId: agentIdFromSessionId(d.id) })),
			});
			// Another list than last time (the R730's list folder was emptied, or this is another relay): what this
			// browser "has sent" means nothing there. Keep only what this call sent, and send the rest in round two.
			const newStore = state.storeId !== "" && answer.storeId !== state.storeId;
			const sent: Record<string, string> = newStore ? {} : { ...state.sent };
			for (const m of outgoing) sent[m.id] = m.lastModified;
			for (const d of deleted) delete sent[d.id];
			for (const remote of answer.chats) {
				const what = await storage.sessions.applyRemoteChat(remote);
				if (what === "remove") {
					result.removed.push(remote.id);
					delete sent[remote.id];
					await storage.sessionSearch.remove(remote.id).catch(() => undefined);
					continue;
				}
				if (what === "add") result.added++;
				else if (what === "refresh" || what === "behind") result.updated++;
				// Taken from the R730, or beaten by it: the R730 has this time, nothing to send for it.
				if (what !== "none") sent[remote.id] = remote.lastModified;
			}
			state = { storeId: answer.storeId, rev: answer.rev, sent };
			await storage.settings.set(CHATS_SYNC_STATE_SETTING, state);
			if (deleted.length > 0) {
				// A delete made while the call was on its way stays for the next sync.
				const told = new Set(deleted.map((d) => `${d.id}|${d.deletedAt}`));
				const left = pendingDeletesOf(await storage.settings.get(CHATS_DELETED_SETTING)).filter(
					(d) => !told.has(`${d.id}|${d.deletedAt}`),
				);
				await storage.settings.set(CHATS_DELETED_SETTING, left);
			}
			result.sent += outgoing.length + deleted.length;
			if (!newStore) break;
		}
		result.ok = true;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		console.warn("[chat list] sync failed (the browser's own list is used):", result.error);
	}
	if (result.ok)
		for (const fn of listeners) {
			try {
				fn(result);
			} catch (err) {
				console.error("[chat list] listener failed", err);
			}
		}
	return result;
}
