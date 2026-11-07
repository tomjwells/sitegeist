/**
 * Model lists for the composer's model menu, ready before the click (Tom, 2026-11-07: "can we not just load all of
 * the models one shot ... I don't think we need to fetch the models list each time when I click that menu").
 * Before this, every click in an R730 chat asked the agent for its list over the relay (a coach: 210 KB, 0.2-1.9 s,
 * creating a session first on a new chat) and only then opened the picker.
 *
 * One list per agent (main-pi or a coach), not per chat: an agent's models are the same in all its chats. Kept in
 * memory and in chrome.storage.local, so the menu opens instantly after a panel reload too. Refreshed in the
 * background (on chat open, every MODELS_FRESH_MS while the panel is open, and after a click if stale); concurrent
 * refreshes for one agent share one request.
 */
import type { Model } from "@mariozechner/pi-ai";

export const MODELS_FRESH_MS = 10 * 60_000;

interface Entry {
	models: Model<any>[];
	at: number;
}

const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<Model<any>[] | undefined>>();
const listeners = new Set<(agentId: string) => void>();
const storageKey = (agentId: string): string => `sg_models_${agentId}`;

function isModel(v: unknown): v is Model<any> {
	if (typeof v !== "object" || v === null) return false;
	const m = v as Record<string, unknown>;
	return typeof m.id === "string" && typeof m.provider === "string" && typeof m.cost === "object" && m.cost !== null;
}

function isEntry(v: unknown): v is Entry {
	if (typeof v !== "object" || v === null) return false;
	const e = v as Record<string, unknown>;
	return typeof e.at === "number" && Array.isArray(e.models) && e.models.every(isModel);
}

/** The list shown at once when the menu opens; undefined when this agent's list was never fetched. */
export function cachedModels(agentId: string): Model<any>[] | undefined {
	return memory.get(agentId)?.models;
}

export function isFresh(agentId: string, now = Date.now()): boolean {
	const e = memory.get(agentId);
	return e !== undefined && now - e.at < MODELS_FRESH_MS;
}

export function onModelsChanged(fn: (agentId: string) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function store(agentId: string, models: Model<any>[], at: number): void {
	memory.set(agentId, { models, at });
	for (const fn of listeners) {
		try {
			fn(agentId);
		} catch (err) {
			console.error("[models] listener failed", err);
		}
	}
	if (typeof chrome !== "undefined" && chrome.storage?.local)
		chrome.storage.local.set({ [storageKey(agentId)]: { models, at } }).catch(() => undefined);
}

/** Load the stored list into memory (once per agent per panel; a no-op when memory already has one). */
export async function warmModelCache(agentId: string): Promise<void> {
	if (memory.has(agentId) || typeof chrome === "undefined" || !chrome.storage?.local) return;
	try {
		const key = storageKey(agentId);
		const got = await chrome.storage.local.get(key);
		const entry: unknown = got[key];
		if (isEntry(entry) && entry.models.length > 0 && !memory.has(agentId)) memory.set(agentId, entry);
	} catch {
		/* no stored list: the first refresh fills it */
	}
}

/**
 * Fetch the agent's list in the background and keep it. Skipped while the stored list is fresh (unless force).
 * `fetcher` returns undefined when it cannot ask without side effects (e.g. a brand-new coach chat with no session).
 */
export function refreshModels(
	agentId: string,
	fetcher: () => Promise<Model<any>[] | undefined>,
	opts: { force?: boolean } = {},
): Promise<Model<any>[] | undefined> {
	if (!opts.force && isFresh(agentId)) return Promise.resolve(cachedModels(agentId));
	const running = inflight.get(agentId);
	if (running) return running;
	const p = (async () => {
		try {
			const models = await fetcher();
			if (models && models.length > 0) store(agentId, models, Date.now());
			return models && models.length > 0 ? models : cachedModels(agentId);
		} finally {
			inflight.delete(agentId);
		}
	})();
	inflight.set(agentId, p);
	return p;
}

/** Test hook: forget everything in memory. */
export function resetModelCacheForTests(): void {
	memory.clear();
	inflight.clear();
}
