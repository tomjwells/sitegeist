import type { Attachment, StorageBackend, StoreConfig } from "@mariozechner/pi-web-ui";

/** Unsent attachments of a draft, keyed like the text draft (draft-attachments store, IndexedDB v5, 2026-10-24). */
export interface DraftAttachmentsRecord {
	key: string;
	attachments: Attachment[];
	savedAt: number;
}

export class DraftAttachmentsStore {
	private backend!: StorageBackend;
	private readonly storeName = "draft-attachments";

	setBackend(backend: StorageBackend) {
		this.backend = backend;
	}

	getConfig(): StoreConfig {
		return { name: this.storeName, keyPath: "key" };
	}

	async get(key: string): Promise<DraftAttachmentsRecord | null> {
		return this.backend.get<DraftAttachmentsRecord>(this.storeName, key);
	}

	async put(record: DraftAttachmentsRecord): Promise<void> {
		await this.backend.set(this.storeName, record.key, record);
	}

	async remove(key: string): Promise<void> {
		await this.backend.delete(this.storeName, key);
	}
}
