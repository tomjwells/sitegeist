import { ProviderKeysStore } from "@mariozechner/pi-web-ui";
import { pushAuthDelete, pushAuthKey } from "../../sync.js";

/** ProviderKeysStore that mirrors every login/logout to the sync server (see src/sync.ts). */
export class SitegeistProviderKeysStore extends ProviderKeysStore {
	override async set(provider: string, key: string, opts: { sync?: boolean } = {}): Promise<void> {
		await super.set(provider, key);
		if (opts.sync !== false) void pushAuthKey(provider, key);
	}

	override async delete(provider: string, opts: { sync?: boolean } = {}): Promise<void> {
		await super.delete(provider);
		if (opts.sync !== false) void pushAuthDelete(provider);
	}
}
