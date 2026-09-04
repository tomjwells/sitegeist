import {
	AppStorage as BaseAppStorage,
	CustomProvidersStore,
	getAppStorage,
	IndexedDBStorageBackend,
	SessionsStore,
	SettingsStore,
} from "@mariozechner/pi-web-ui";
import { CostStore } from "./stores/cost-store.js";
import { SitegeistProviderKeysStore } from "./stores/provider-keys-store.js";
import { SitegeistSessionsStore } from "./stores/sessions-store.js";
import { SkillsStore } from "./stores/skills-store.js";

/**
 * Extended AppStorage for Sitegeist with skills, memories, and prompts stores.
 */
export class SitegeistAppStorage extends BaseAppStorage {
	readonly skills: SkillsStore;
	readonly costs: CostStore;
	/** Narrowed type of the base `providerKeys` so callers can pass `{ sync: false }`. */
	declare readonly providerKeys: SitegeistProviderKeysStore;

	constructor() {
		// 1. Create all stores (no backend yet)
		const settings = new SettingsStore();
		const providerKeys = new SitegeistProviderKeysStore();
		const sessions = new SitegeistSessionsStore();
		const customProviders = new CustomProvidersStore();
		const skills = new SkillsStore();
		const costs = new CostStore();

		// 2. Gather configs from all stores
		const configs = [
			settings.getConfig(),
			SessionsStore.getMetadataConfig(),
			providerKeys.getConfig(),
			customProviders.getConfig(),
			sessions.getConfig(),
			skills.getConfig(),
			costs.getConfig(),
		];

		// 3. Create backend with all configs
		const backend = new IndexedDBStorageBackend({
			dbName: "sitegeist-storage",
			version: 3, // Increment version to add custom-providers store
			stores: configs,
		});

		// 4. Wire backend to all stores
		settings.setBackend(backend);
		providerKeys.setBackend(backend);
		customProviders.setBackend(backend);
		sessions.setBackend(backend);
		skills.setBackend(backend);
		costs.setBackend(backend);

		// 5. Pass base stores to parent
		super(settings, providerKeys, sessions, customProviders, backend);

		// 6. Store references to sitegeist-specific stores
		this.skills = skills;
		this.costs = costs;
	}
}

/**
 * Helper to get typed Sitegeist storage.
 */
export function getSitegeistStorage(): SitegeistAppStorage {
	return getAppStorage() as SitegeistAppStorage;
}
