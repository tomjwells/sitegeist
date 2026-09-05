/**
 * Drop-in replacement for @mariozechner/pi-ai's models.js (wired in by scripts/build.mjs).
 *
 * pi-ai builds its model registry once at module load from the bundled, generated model list, which
 * goes stale as soon as the package does. This keeps the same API but makes the registry mutable so a
 * fresh catalog can be merged in at runtime (see registerModels / sidepanel.ts).
 */
// Deep import: the package "exports" map hides dist/, so go through node_modules directly

import type { Api, KnownProvider, Model, Usage } from "@mariozechner/pi-ai";
import { MODELS } from "../node_modules/@mariozechner/pi-ai/dist/models.generated.js";

type AnyModel = Model<Api>;

const modelRegistry = new Map<string, Map<string, AnyModel>>();
for (const [provider, models] of Object.entries(MODELS as Record<string, Record<string, AnyModel>>)) {
	modelRegistry.set(provider, new Map(Object.entries(models)));
}

/** APIs the bundled pi-ai can actually drive; catalog entries using anything else are ignored. */
const SUPPORTED_APIS = new Set<string>();
for (const models of modelRegistry.values()) {
	for (const model of models.values()) SUPPORTED_APIS.add(model.api);
}

export function getModel(provider: string, modelId: string): AnyModel | undefined {
	return modelRegistry.get(provider)?.get(modelId);
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels(provider: string): AnyModel[] {
	const models = modelRegistry.get(provider);
	return models ? Array.from(models.values()) : [];
}

export function calculateCost(model: AnyModel, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

export function supportsXhigh(model: AnyModel): boolean {
	if (model.id.includes("gpt-5.2") || model.id.includes("gpt-5.3") || model.id.includes("gpt-5.4")) return true;
	if (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) return true;
	// Newer catalog entries say so explicitly
	const levels = (model as { thinkingLevelMap?: Record<string, unknown> }).thinkingLevelMap;
	return levels !== undefined && "xhigh" in levels;
}

export function modelsAreEqual(a: AnyModel | null | undefined, b: AnyModel | null | undefined): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}

function isModelLike(value: unknown): value is AnyModel {
	if (typeof value !== "object" || value === null) return false;
	const m = value as Record<string, unknown>;
	const cost = m.cost as Record<string, unknown> | undefined;
	return (
		typeof m.id === "string" &&
		typeof m.name === "string" &&
		typeof m.api === "string" &&
		typeof m.provider === "string" &&
		typeof m.baseUrl === "string" &&
		typeof m.reasoning === "boolean" &&
		Array.isArray(m.input) &&
		typeof cost === "object" &&
		cost !== null &&
		typeof cost.input === "number" &&
		typeof cost.output === "number" &&
		typeof cost.cacheRead === "number" &&
		typeof cost.cacheWrite === "number" &&
		typeof m.contextWindow === "number" &&
		typeof m.maxTokens === "number"
	);
}

/** Providers whose model list came from the catalog (the proxy's callable set) rather than the bundle. */
const catalogProviderSet = new Set<string>();

export function catalogProviders(): string[] {
	return Array.from(catalogProviderSet);
}

export function isCatalogProvider(provider: string): boolean {
	return catalogProviderSet.has(provider);
}

/**
 * Load a catalog ({ provider: { modelId: Model } }) into the registry. The catalog is the single source
 * of truth for what is callable, so for every provider it lists the bundled models are REPLACED by the
 * catalog's (a bundled entry the proxy cannot serve would only be a dead picker row). Providers the
 * catalog does not mention keep their bundled list (they need the user's own key). Entries with an
 * unsupported api or a malformed shape are skipped. Returns how many models were registered.
 */
export function registerModels(catalog: unknown): number {
	if (typeof catalog !== "object" || catalog === null) return 0;
	let count = 0;
	for (const [provider, models] of Object.entries(catalog as Record<string, unknown>)) {
		if (typeof models !== "object" || models === null) continue;
		const providerModels = new Map<string, AnyModel>();
		for (const [id, model] of Object.entries(models as Record<string, unknown>)) {
			if (!isModelLike(model) || !SUPPORTED_APIS.has(model.api) || model.provider !== provider) continue;
			providerModels.set(id, model);
			count++;
		}
		if (providerModels.size === 0) continue;
		modelRegistry.set(provider, providerModels);
		catalogProviderSet.add(provider);
	}
	return count;
}
