import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { StorageBackend, StoreConfig } from "@mariozechner/pi-web-ui";
import { buildSearchText, type SearchRecord } from "../../sessions/session-search.js";

/**
 * Full-text index of sessions, one record per session (sessions-search store, IndexedDB v4). Written
 * alongside every session save; sessions saved before the store existed are indexed lazily by the
 * sidebar (see SessionsSidebar.ensureIndexed). Kept separate from sessions-metadata so the session
 * list stays light and the text is only loaded when searching.
 */
export class SessionSearchStore {
	private backend!: StorageBackend;
	private readonly storeName = "sessions-search";

	setBackend(backend: StorageBackend) {
		this.backend = backend;
	}

	getConfig(): StoreConfig {
		return {
			name: this.storeName,
			keyPath: "id",
			indices: [{ name: "lastModified", keyPath: "lastModified" }],
		};
	}

	async index(
		id: string,
		title: string,
		messages: AgentMessage[],
		lastModified: string,
		aliases: string[] = [],
	): Promise<SearchRecord> {
		const record: SearchRecord = {
			id,
			lastModified,
			messageCount: messages.length,
			text: buildSearchText(messages, title),
			aliases,
		};
		await this.backend.set(this.storeName, id, record);
		return record;
	}

	async get(id: string): Promise<SearchRecord | null> {
		return this.backend.get<SearchRecord>(this.storeName, id);
	}

	async all(): Promise<SearchRecord[]> {
		return this.backend.getAllFromIndex<SearchRecord>(this.storeName, "lastModified", "desc");
	}

	async remove(id: string): Promise<void> {
		await this.backend.delete(this.storeName, id);
	}
}
