import { ProviderKeysStore } from "@mariozechner/pi-web-ui";
import { PRIME_PROVIDER } from "../../prime/constants.js";
import { pushAuthDelete, pushAuthKey } from "../../sync.js";

/** ProviderKeysStore that mirrors every login/logout to the sync server (see src/sync.ts). */
export class SitegeistProviderKeysStore extends ProviderKeysStore {
	/** prime-agent sessions run on the R730 with its own credentials; the UI's per-provider key gate must let them through. */
	override async get(provider: string): Promise<string | null> {
		if (provider === PRIME_PROVIDER) return "remote";
		return super.get(provider);
	}

	override async set(provider: string, key: string, opts: { sync?: boolean } = {}): Promise<void> {
		await super.set(provider, key);
		if (opts.sync !== false) void pushAuthKey(provider, key);
	}

	override async delete(provider: string, opts: { sync?: boolean } = {}): Promise<void> {
		await super.delete(provider);
		if (opts.sync !== false) void pushAuthDelete(provider);
	}
}
