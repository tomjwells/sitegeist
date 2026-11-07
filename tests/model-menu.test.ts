/**
 * Model menu (Tom, 2026-11-07: "two clicks and bam, it's done"): row order and the background cache. Pure parts,
 * plain node (no chrome.* here, so the cache runs memory-only).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@mariozechner/pi-ai";
import { orderModels } from "../src/components/model-menu-order.ts";
import {
	cachedModels,
	isFresh,
	MODELS_FRESH_MS,
	refreshModels,
	resetModelCacheForTests,
} from "../src/prime/model-cache.ts";

// test fixture: only the fields the menu and cache read are meaningful; the cast fills Model's generic api typing
const m = (provider: string, id: string, name = id): Model<any> =>
	({
		provider,
		id,
		name,
		api: "x",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	}) as unknown as Model<any>;

const models = [
	m("anthropic", "claude-opus-5-5", "Claude Opus 5.5"),
	m("anthropic", "claude-opus-4-8", "Claude Opus 4.8"),
	m("anthropic", "claude-fable-5-1", "Claude Fable 5.1"),
	m("kimi-coding", "k3-256k", "Kimi K3 256k"),
	m("openai", "gpt-6", "GPT-6"),
	m("anthropic", "claude-opus-5-5", "Claude Opus 5.5"), // duplicate from a second registry: shown once
];

test("rows: recents first, then providers A-Z, names in natural order, no duplicates", () => {
	const rows = orderModels(models, "", ["openai/gpt-6", "gone/model"]);
	assert.deepEqual(
		rows.map((r) => `${r.group}:${r.model.id}`),
		[
			"Recent:gpt-6",
			"anthropic:claude-fable-5-1",
			"anthropic:claude-opus-4-8",
			"anthropic:claude-opus-5-5",
			"kimi-coding:k3-256k",
			"openai:gpt-6",
		],
	);
});

test("filter: every word must match name, id or provider; recents are not repeated while filtering", () => {
	assert.deepEqual(
		orderModels(models, "opus 5", ["anthropic/claude-opus-5-5"]).map((r) => r.model.id),
		["claude-opus-5-5"],
	);
	assert.deepEqual(
		orderModels(models, "KIMI", []).map((r) => r.model.id),
		["k3-256k"],
	);
	assert.deepEqual(orderModels(models, "fable opus", []), []);
});

test("cache: one request per agent at a time; fresh lists are not fetched again; force refetches", async () => {
	resetModelCacheForTests();
	let calls = 0;
	let release: (() => void) | undefined;
	const slow = () =>
		new Promise<Model<any>[]>((res) => {
			calls++;
			release = () => res(models.slice(0, 3));
		});
	const a = refreshModels("quantcoach", slow);
	const b = refreshModels("quantcoach", slow);
	assert.equal(calls, 1, "the second refresh joins the first");
	release?.();
	assert.equal((await a)?.length, 3);
	assert.equal((await b)?.length, 3);
	assert.equal(cachedModels("quantcoach")?.length, 3);
	assert.ok(isFresh("quantcoach"));
	await refreshModels("quantcoach", async () => {
		calls++;
		return models;
	});
	assert.equal(calls, 1, "fresh: no request");
	await refreshModels(
		"quantcoach",
		async () => {
			calls++;
			return models;
		},
		{ force: true },
	);
	assert.equal(calls, 2);
	assert.equal(cachedModels("quantcoach")?.length, 6);
	assert.ok(!isFresh("quantcoach", Date.now() + MODELS_FRESH_MS + 1));
});

test("cache: an empty or failed answer keeps the list the menu already has", async () => {
	resetModelCacheForTests();
	await refreshModels("sedcoach", async () => models.slice(0, 2));
	assert.equal((await refreshModels("sedcoach", async () => undefined, { force: true }))?.length, 2);
	assert.equal((await refreshModels("sedcoach", async () => [], { force: true }))?.length, 2);
	await assert.rejects(
		refreshModels(
			"sedcoach",
			async () => {
				throw new Error("relay down");
			},
			{ force: true },
		),
	);
	assert.equal(cachedModels("sedcoach")?.length, 2);
	assert.equal(cachedModels("never-fetched"), undefined);
});
