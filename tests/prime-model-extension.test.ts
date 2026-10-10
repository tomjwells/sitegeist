import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

/**
 * Real-extension check of the prime model/thinking fix (Tom, 2026-10-10: picked claude-opus-5-5 + XHigh on a new
 * prime-agent session; it ran on claude-sonnet-5-5 / high and the label flipped). A stand-in relay plays the R730
 * bridge: a new session starts on its automation default (sonnet-5-5 / high), and every command the panel sends is
 * recorded. Asserts the panel applies the shown model + chosen thinking level BEFORE the first prompt, and that the
 * footer shows the build and session id.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const CATALOG: Record<string, Record<string, unknown>> = {
	"claude-opus-5-5": {
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://cors-proxy.tjw-private/upstream/anthropic",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["image", "text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	"claude-sonnet-5-5": {
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://cors-proxy.tjw-private/upstream/anthropic",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["image", "text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
};

type Call = { path: string; body: Record<string, unknown> };

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	try {
		const v: unknown = JSON.parse(raw || "{}");
		return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, label: string): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T | undefined;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (ok(last)) return last;
		} catch {
			/* navigation in progress */
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`timed out waiting for ${label}; last = ${JSON.stringify(last)}`);
}

async function seedSetting(page: Page, key: string, value: string): Promise<void> {
	await page.evaluate(
		async ({ key, value }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const req = indexedDB.open("sitegeist-storage");
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(["settings"], "readwrite");
				tx.objectStore("settings").put(value, key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		},
		{ key, value },
	);
}

async function dismissPermissionDialog(page: Page): Promise<void> {
	await page.waitForSelector("userscripts-permission-dialog", { timeout: 15_000, state: "attached" });
	await page.evaluate(() =>
		document.querySelector("userscripts-permission-dialog")?.dispatchEvent(new Event("close")),
	);
}

test(
	"built extension: a new prime session runs the model and thinking level the panel shows",
	{ timeout: 120_000 },
	async () => {
		const calls: Call[] = [];
		const state: { model: Record<string, unknown> | undefined; thinkingLevel: string } = {
			model: CATALOG["claude-sonnet-5-5"],
			thinkingLevel: "high",
		};
		const sid = "sg-0123456789ab";
		const server = createServer(async (req, res) => {
			const url = req.url ?? "";
			res.setHeader("content-type", "application/json");
			res.setHeader("access-control-allow-origin", "*");
			if (url === "/models") {
				res.end(JSON.stringify({ version: "test", models: { anthropic: CATALOG } }));
				return;
			}
			if (url === "/sitegeist/agents") {
				res.end(JSON.stringify({ agents: [{ id: "prime", label: "main-pi (prime-agent)", ok: true }] }));
				return;
			}
			const body = req.method === "POST" ? await readJson(req) : {};
			const p = url.replace(/^\/sitegeist\/agents\/prime/, "");
			calls.push({ path: p, body });
			if (p === "/sessions" && req.method === "POST") {
				res.end(JSON.stringify({ ok: true, sessionId: sid, name: "x", state }));
				return;
			}
			if (p === `/sessions/${sid}/rpc`) {
				if (body.type === "set_model") {
					const m = CATALOG[String(body.modelId)];
					if (m) state.model = m;
					res.end(JSON.stringify({ ok: true, response: { success: !!m, data: m } }));
					return;
				}
				if (body.type === "set_thinking_level") {
					state.thinkingLevel = String(body.level);
					res.end(JSON.stringify({ ok: true, response: { success: true } }));
					return;
				}
				if (body.type === "get_state") {
					res.end(
						JSON.stringify({
							ok: true,
							response: { success: true, data: { ...state, sessionId: "native-uuid", isStreaming: false } },
						}),
					);
					return;
				}
				res.end(JSON.stringify({ ok: true, response: { success: true, data: {} } }));
				return;
			}
			if (p === `/sessions/${sid}/prompt`) {
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			res.statusCode = 404;
			res.end(JSON.stringify({ error: "not found" }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const base = `http://127.0.0.1:${address.port}`;
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-prime-model-"));
		const context = await chromium.launchPersistentContext(userDataDir, {
			...(chromePath ? { executablePath: chromePath } : {}),
			headless: true,
			args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
		});
		try {
			let [worker] = context.serviceWorkers();
			if (!worker) worker = await context.waitForEvent("serviceworker");
			const extensionId = new URL(worker.url()).host;
			const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;

			// Point the panel at the stand-in relay + model catalog, then open a brand-new prime-agent session.
			const boot = await context.newPage();
			await boot.goto(`${panelUrl}?new=true`);
			await dismissPermissionDialog(boot);
			await boot.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
			await seedSetting(boot, "sync.url", `${base}/sitegeist`);
			await seedSetting(boot, "models.catalogUrl", `${base}/models`);
			await seedSetting(boot, "sync.token", "test-token");
			const page = boot;
			await page.goto(`${panelUrl}?new=true&agent=prime`);
			await dismissPermissionDialog(page);
			await page.waitForSelector("message-editor textarea", { timeout: 30_000, state: "attached" });

			// Before sending: the picker shows the interactive default (opus-5-5), the footer says "new session".
			await until(
				() => page.evaluate(() => document.body.innerText),
				(t) => t.includes("claude-opus-5-5"),
				15_000,
				"opus default label",
			);
			const footer0 = await page.evaluate(
				() => document.querySelector(".sg-footer-info")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			);
			assert.match(footer0, /^v1\.0\.0 · [0-9a-f]{7}(-dirty)? · new session$/, footer0);

			// Choose XHigh in the composer's thinking dropdown.
			await page.evaluate(() => {
				const buttons = Array.from(document.querySelectorAll("message-editor button"));
				const trigger = buttons.find((b) =>
					/^(Off|Minimal|Low|Medium|High|XHigh|Max)$/.test(b.textContent?.trim() ?? ""),
				);
				(trigger as HTMLButtonElement | undefined)?.click();
			});
			await until(
				() =>
					page.evaluate(() =>
						Array.from(document.querySelectorAll("[role=option], button, div")).some(
							(el) => el.textContent?.trim() === "XHigh",
						),
					),
				(v) => v,
				5_000,
				"XHigh option",
			);
			await page.evaluate(() => {
				const opt = Array.from(document.querySelectorAll("[role=option], button, div"))
					.filter((el) => el.textContent?.trim() === "XHigh")
					.pop();
				(opt as HTMLElement | undefined)?.click();
			});
			await until(
				() =>
					page.evaluate(() =>
						Array.from(document.querySelectorAll("message-editor button")).some(
							(b) => b.textContent?.trim() === "XHigh",
						),
					),
				(v) => v,
				5_000,
				"XHigh selected",
			);

			// Send. The relay starts the session on sonnet-5-5 / high; the panel must switch it before the prompt.
			await page.fill("message-editor textarea", "hello");
			await page.keyboard.press("Enter");
			await until(
				() => Promise.resolve(calls.some((c) => c.path.endsWith("/prompt"))),
				(v) => v,
				30_000,
				"prompt sent",
			);
			const order = calls.map((c) =>
				c.path.endsWith("/rpc")
					? `rpc:${String(c.body.type)}${c.body.modelId ? `=${String(c.body.modelId)}` : ""}${c.body.level ? `=${String(c.body.level)}` : ""}`
					: c.path,
			);
			const iPrompt = order.findIndex((o) => o.endsWith("/prompt"));
			const iModel = order.indexOf("rpc:set_model=claude-opus-5-5");
			const iThink = order.indexOf("rpc:set_thinking_level=xhigh");
			assert.ok(iModel >= 0 && iModel < iPrompt, `set_model before prompt: ${order.join(" | ")}`);
			assert.ok(iThink >= 0 && iThink < iPrompt, `set_thinking_level before prompt: ${order.join(" | ")}`);
			assert.equal(state.model, CATALOG["claude-opus-5-5"]);
			assert.equal(state.thinkingLevel, "xhigh");

			// After sending: the labels still say what runs, and the footer shows the session id.
			await until(
				() => page.evaluate(() => document.body.innerText),
				(t) => t.includes("claude-opus-5-5") && !t.includes("claude-sonnet-5-5"),
				10_000,
				"label stays opus",
			);
			await until(
				() =>
					page.evaluate(
						() => document.querySelector(".sg-footer-info")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
					),
				(t) => t.endsWith(`· ${sid}`),
				15_000,
				"footer session id",
			);
		} finally {
			await context.close();
			server.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
