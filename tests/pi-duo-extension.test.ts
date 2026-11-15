import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

/**
 * New sitegeist chats run on the pi harness with Duo-start (Tom, 2026-11-15: "yes I'm fine with that"). A stand-in
 * relay offers pi for main-pi (agent list `harnesses`) and lists Duo and Duo-start first for ?harness=pi. Asserts: a new
 * chat shows duo-start; its menu lists Duo and Duo-start; sending creates the session with harness "pi" and selects
 * duo-start before the prompt; the session then reads duo. Reopening a pi chat whose history has duo's run notes shows
 * one muted line per mode change, and pi's bash call as "Shell · <command>".
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const out = join(root, "tests/.out");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const model = (id: string, name: string, api = "anthropic-messages"): Record<string, unknown> => ({
	id,
	name,
	api,
	provider: "anthropic",
	baseUrl: api === "pi-virtual" ? "" : "https://cors-proxy.tjw-private/upstream/anthropic",
	reasoning: true,
	input: ["image", "text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 128000,
});
const DUO = model("duo", "Duo (one hybrid model: implements on Opus, plans on Fable)", "pi-virtual");
const DUO_START = model("duo-start", "Duo-start (next request starts in planning mode, then duo)", "pi-virtual");
const OPUS = model("claude-opus-5-5", "Claude Opus 5.5");
type Call = { path: string; query: string; body: Record<string, unknown> };

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	try {
		const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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
	"a new chat runs on pi with Duo-start; duo's mode shows as one line; bash shows as Shell",
	{ timeout: 120_000 },
	async () => {
		const calls: Call[] = [];
		const sid = "sg-pi-0123456789ab";
		const oldSid = "sg-pi-aaaaaaaaaaaa";
		const state: { model: Record<string, unknown>; thinkingLevel: string } = { model: OPUS, thinkingLevel: "xhigh" };
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const step = (modelId: string, content: unknown[], stopReason: string, timestamp: number) => ({
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: modelId,
			usage,
			stopReason,
			timestamp,
		});
		const note = (role: string, timestamp: number) => ({
			role: "custom",
			customType: "duo-role",
			content: `[duo] mode=${role === "fable" ? "planning" : "implementation"}`,
			display: true,
			details: { role, start: false },
			timestamp,
		});
		const oldMessages = [
			{ role: "user", content: "Check the disk.", timestamp: 1 },
			note("fable", 2),
			step(
				"claude-fable-5-2",
				[{ type: "toolCall", id: "t1", name: "handoff", arguments: { brief: "plan" } }],
				"toolUse",
				3,
			),
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "handoff",
				content: [{ type: "text", text: "switched" }],
				isError: false,
				timestamp: 4,
			},
			note("opus", 5),
			step(
				"claude-opus-5-5",
				[{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "df -h /\necho done" } }],
				"toolUse",
				6,
			),
			{
				role: "toolResult",
				toolCallId: "t2",
				toolName: "bash",
				content: [{ type: "text", text: "/dev/sda1 50% /" }],
				isError: false,
				timestamp: 7,
			},
			note("opus", 8),
			step("claude-opus-5-5", [{ type: "text", text: "Half full." }], "stop", 9),
		];
		const server = createServer(async (req, res) => {
			const [path = "", query = ""] = (req.url ?? "").split("?");
			res.setHeader("content-type", "application/json");
			res.setHeader("access-control-allow-origin", "*");
			if (path === "/models") {
				res.end(JSON.stringify({ version: "test", models: { anthropic: { "claude-opus-5-5": OPUS } } }));
				return;
			}
			if (path === "/sitegeist/agents") {
				res.end(
					JSON.stringify({
						agents: [{ id: "prime", label: "main-pi (prime-agent)", ok: true, harnesses: ["prime", "pi"] }],
					}),
				);
				return;
			}
			const body = req.method === "POST" ? await readJson(req) : {};
			const p = path.replace(/^\/sitegeist\/agents\/prime/, "").replace(/^\/sitegeist\/prime/, "");
			calls.push({ path: p, query, body });
			if (p === "/models") {
				res.end(
					JSON.stringify({
						ok: true,
						models: query.includes("harness=pi") ? [DUO, DUO_START, OPUS] : [OPUS],
						notice: null,
					}),
				);
				return;
			}
			if (p === "/sessions" && req.method === "POST") {
				res.end(JSON.stringify({ ok: true, sessionId: sid, harness: body.harness, name: "x", state }));
				return;
			}
			if (p === `/sessions/${sid}/rpc`) {
				if (body.type === "set_model")
					state.model = body.modelId === "duo-start" ? DUO : body.modelId === "duo" ? DUO : OPUS;
				res.end(
					JSON.stringify({
						ok: true,
						response: { success: true, data: body.type === "get_state" ? { ...state, isStreaming: false } : {} },
					}),
				);
				return;
			}
			if (p === `/sessions/${sid}/prompt`) {
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			if (p === `/sessions/${oldSid}` && req.method === "GET") {
				res.end(
					JSON.stringify({
						ok: true,
						sessionId: oldSid,
						offset: 0,
						state: { model: DUO, thinkingLevel: "xhigh", isStreaming: false },
						messages: oldMessages,
					}),
				);
				return;
			}
			if (p === `/sessions/${oldSid}/exists`) {
				res.end(JSON.stringify({ ok: true, exists: true, name: "sitegeist / disk" }));
				return;
			}
			res.end(JSON.stringify({ ok: true, artifacts: [], queue: [] }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const base = `http://127.0.0.1:${address.port}`;
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-pi-duo-"));
		const context = await chromium.launchPersistentContext(userDataDir, {
			...(chromePath ? { executablePath: chromePath } : {}),
			headless: true,
			viewport: { width: 560, height: 900 },
			args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
		});
		try {
			await mkdir(out, { recursive: true });
			let [worker] = context.serviceWorkers();
			if (!worker) worker = await context.waitForEvent("serviceworker");
			const panelUrl = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;
			const page = await context.newPage();
			await page.goto(`${panelUrl}?new=true`);
			await dismissPermissionDialog(page);
			await page.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
			await seedSetting(page, "sync.url", `${base}/sitegeist`);
			await seedSetting(page, "models.catalogUrl", `${base}/models`);
			await seedSetting(page, "sync.token", "test-token");
			await page.goto(`${panelUrl}?new=true&agent=prime`);
			await dismissPermissionDialog(page);
			await page.waitForSelector("message-editor textarea", { timeout: 30_000, state: "attached" });
			const buttons = () =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll("message-editor button")).map((b) => b.textContent?.trim() ?? ""),
				);
			await until(buttons, (b) => b.includes("duo-start"), 15_000, "duo-start as the new chat's model");

			// the menu: the pi list (Duo, Duo-start first), asked with harness=pi
			await page.locator("message-editor button", { hasText: "duo-start" }).first().click();
			await until(
				() => page.evaluate(() => document.body.innerText),
				(t) => t.includes("Duo-start (next request"),
				15_000,
				"Duo-start in the menu",
			);
			assert.ok(
				calls.some((c) => c.path === "/models" && c.query.includes("harness=pi")),
				"menu asked for the pi list",
			);
			await page.screenshot({ path: join(out, "pi-duo-menu.png") });
			await page.keyboard.press("Escape");

			await page.fill("message-editor textarea", "hello");
			await page.keyboard.press("Enter");
			await until(
				() => Promise.resolve(calls.some((c) => c.path.endsWith("/prompt"))),
				(v) => v,
				30_000,
				"prompt sent",
			);
			const create = calls.find((c) => c.path === "/sessions");
			assert.equal(create?.body.harness, "pi", "created on pi");
			const order = calls.map((c) =>
				c.path.endsWith("/rpc")
					? `rpc:${String(c.body.type)}${c.body.modelId ? `=${String(c.body.modelId)}` : ""}`
					: c.path,
			);
			const iModel = order.indexOf("rpc:set_model=duo-start");
			const iPrompt = order.findIndex((o) => o.endsWith("/prompt"));
			assert.ok(iModel >= 0 && iModel < iPrompt, `set_model duo-start before prompt: ${order.join(" | ")}`);
			await until(buttons, (b) => b.includes("duo"), 10_000, "the chat then reads duo");
			const notices = await page.evaluate(() => document.body.innerText);
			assert.ok(
				!notices.includes("Could not apply your choice"),
				"no 'could not apply' notice for duo-start -> duo",
			);

			// an existing pi chat with duo's run notes and a bash call
			await page.goto(`${panelUrl}?session=${oldSid}`);
			await dismissPermissionDialog(page);
			const modes = await until(
				() =>
					page.evaluate(() =>
						Array.from(document.querySelectorAll(".sg-duo-mode")).map(
							(e) => e.textContent?.replace(/\s+/g, " ").trim() ?? "",
						),
					),
				(m) => m.length >= 2,
				20_000,
				"duo mode lines",
			);
			assert.deepEqual(modes, ["Planning mode", "Implementation mode"], "one line per mode change");
			const text = await page.evaluate(
				() => document.querySelector("message-list")?.textContent?.replace(/\s+/g, " ") ?? "",
			);
			assert.ok(text.includes("Shell · df -h /"), `bash shown as Shell: ${text.slice(0, 400)}`);
			assert.ok(!text.includes("[duo] mode="), "the raw run note is never shown");
			await page.screenshot({ path: join(out, "pi-duo-history.png") });
		} finally {
			await context.close();
			await rm(userDataDir, { recursive: true, force: true });
			server.close();
		}
	},
);
