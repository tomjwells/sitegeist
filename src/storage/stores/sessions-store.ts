import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type SessionData, type SessionMetadata, SessionsStore } from "@mariozechner/pi-web-ui";
import {
	type Decision,
	decide,
	isListOnly,
	latestUsedHere,
	pendingDeletesOf,
	type RemoteChat,
	usedHere,
} from "../../prime/chat-list.js";
import { isPrimeSessionId } from "../../prime/constants.js";
import { STORED_FORMAT } from "../../prime/stored-messages.js";

/** Settings key: R730 chats deleted in this browser that the R730's list has not been told about yet. */
export const CHATS_DELETED_SETTING = "chats.sync.deleted";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const thinkingOf = (v: string | undefined): ThinkingLevel => THINKING_LEVELS.find((level) => level === v) ?? "off";
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const fields = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};

function usageOf(v: Record<string, unknown> | undefined): SessionMetadata["usage"] {
	const u = fields(v);
	const cost = fields(u.cost);
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		totalTokens: num(u.totalTokens),
		cost: {
			input: num(cost.input),
			output: num(cost.output),
			cacheRead: num(cost.cacheRead),
			cacheWrite: num(cost.cacheWrite),
			total: num(cost.total),
		},
	};
}

/** A stored list entry with sitegeist's own fields (the marks are described in chat-list.ts and stored-messages.ts). */
type ListEntry = SessionMetadata & {
	modelId?: string;
	sgStored?: number;
	sgListOnly?: boolean;
	sgUsedHere?: string;
	sgBehind?: boolean;
};

/** The list entry for a chat this browser has no copy of (chat-list.ts: "list only"). */
function listOnlyEntry(remote: RemoteChat): ListEntry {
	return {
		id: remote.id,
		title: remote.title,
		createdAt: remote.createdAt,
		lastModified: remote.lastModified,
		messageCount: remote.messageCount,
		usage: usageOf(remote.usage),
		thinkingLevel: thinkingOf(remote.thinkingLevel),
		preview: remote.preview,
		...(remote.modelId ? { modelId: remote.modelId } : {}),
		sgStored: STORED_FORMAT,
		sgListOnly: true,
	};
}

/**
 * Sitegeist's sessions store:
 *  - migrates old tool result messages from output to content format;
 *  - keeps what the shared chat list needs (src/prime/chat-list.ts): a delete of an R730 chat is recorded for the
 *    other browsers in the same step, a save notes that this browser used the chat, and the chat resumed at start
 *    is the one this browser used last.
 */
export class SitegeistSessionsStore extends SessionsStore {
	/**
	 * An R730 chat's list entry changed here: chat-list-sync.ts sends it. "save" happens on every agent event of
	 * the open chat and may wait; a rename or a delete is something Tom did and goes out soon.
	 */
	onListChange: ((what: "save" | "rename" | "delete") => void) | undefined;

	async loadSession(id: string): Promise<SessionData | null> {
		const session = await super.loadSession(id);
		if (session) {
			return this.migrateSession(session);
		}
		return session;
	}

	async get(id: string): Promise<SessionData | null> {
		const session = await super.get(id);
		if (session) {
			return this.migrateSession(session);
		}
		return session;
	}

	override async save(data: SessionData, metadata: SessionMetadata): Promise<void> {
		if (!isPrimeSessionId(data.id)) return super.save(data, metadata);
		// A save is this browser using the chat. The entry is built new by the caller, so the list-only and behind
		// marks are gone with it.
		const entry: ListEntry = { ...metadata, sgUsedHere: metadata.lastModified };
		await super.save(data, entry);
		this.onListChange?.("save");
	}

	override async delete(id: string): Promise<void> {
		if (!isPrimeSessionId(id)) return super.delete(id);
		// In one step with the delete: the note that tells the other browsers to drop the chat too.
		await this.getBackend().transaction(["sessions", "sessions-metadata", "settings"], "readwrite", async (tx) => {
			await tx.delete("sessions", id);
			await tx.delete("sessions-metadata", id);
			const pending = pendingDeletesOf(await tx.get("settings", CHATS_DELETED_SETTING)).filter((d) => d.id !== id);
			await tx.set("settings", CHATS_DELETED_SETTING, [...pending, { id, deletedAt: new Date().toISOString() }]);
		});
		this.onListChange?.("delete");
	}

	override async updateTitle(id: string, title: string): Promise<void> {
		await super.updateTitle(id, title);
		if (!isPrimeSessionId(id)) return;
		const metadata = await this.getMetadata(id);
		if (!metadata || isListOnly(metadata)) return;
		// A rename is a change of the entry: the later change wins in the shared list, so it needs a new time.
		const now = new Date().toISOString();
		const entry: ListEntry = { ...metadata, lastModified: now, sgUsedHere: now };
		await this.getBackend().set("sessions-metadata", id, entry);
		this.onListChange?.("rename");
	}

	/** The chat this browser itself used last (not one used later in another browser: see chat-list.ts). */
	override async getLatestSessionId(): Promise<string | null> {
		return latestUsedHere(await this.getAllMetadata());
	}

	/**
	 * Apply one entry of the R730's chat list to this browser's list. Reads the current entry in the same step, so
	 * a save of that chat made while the list was being fetched is not overwritten. Records no delete note.
	 */
	async applyRemoteChat(remote: RemoteChat): Promise<Decision> {
		return this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async (tx) => {
			const local = await tx.get<SessionMetadata>("sessions-metadata", remote.id);
			const what = decide(local, remote);
			if (what === "remove") {
				await tx.delete("sessions", remote.id);
				await tx.delete("sessions-metadata", remote.id);
			} else if (what === "add" || what === "refresh") {
				await tx.set("sessions-metadata", remote.id, listOnlyEntry(remote));
			} else if (what === "behind" && local) {
				const entry: ListEntry = {
					...local,
					title: remote.title || local.title,
					lastModified: remote.lastModified,
					messageCount: remote.messageCount,
					preview: remote.preview,
					sgUsedHere: usedHere(local),
					sgBehind: true,
				};
				await tx.set("sessions-metadata", remote.id, entry);
			}
			return what;
		});
	}

	private migrateSession(session: SessionData): SessionData {
		return {
			...session,
			messages: this.migrateToolResultMessages(session.messages),
		};
	}

	private migrateToolResultMessages(messages: AgentMessage[]): AgentMessage[] {
		return messages.map((msg) => {
			if (msg.role === "toolResult" && "output" in msg && !msg.content) {
				// Old format detected - migrate it
				const { output, ...rest } = msg as any;
				return {
					...rest,
					content: [{ type: "text", text: output }],
				};
			}
			return msg;
		});
	}
}
