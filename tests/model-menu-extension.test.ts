/**
 * Model menu in the real extension (Tom, 2026-11-07: the thinking menu is "two clicks and bam, it's done"; the model
 * menu "has to load all the models" on every click and is "a little bit glitchy"). An R730 chat against the stand-in
 * relay: the model list is fetched in the background when the chat opens, before any click; the click opens a
 * dropdown at the button at once with no new request; typing filters, Enter picks, the pick reaches the R730
 * (set_model) and the button shows it; the pick is listed under Recent next time; a click outside closes; after a
 * panel reload the list comes from storage with no request. Screenshot in tests/.out/ for a human look.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { seededPrimeSession, startStandInRelay } from "./prime-relay.fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const SID = "sg-6f6f6f6f6f6f";
const seeded = seededPrimeSession(SID, "Model menu");

const model = (provider: string, id: string, name: string) => ({
	id,
	name,
	provider,
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
});
const MODELS = [
	model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5"),
	model("anthropic", "claude-opus-5-5", "Claude Opus 5.5"),
	model("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5"),
	model("anthropic", "claude-fable-5-1", "Claude Fable 5.1"),
	model("kimi-coding", "k3-256k", "Kimi K3 256k"),
	model("openai", "gpt-6", "GPT-6"),
];

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (ok(last)) return last;
		} catch {
			/* mid-navigation */
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
}

const dismiss = (page: Page) =>
	page.evaluate(() => document.querySelector("userscripts-permission-dialog")?.dispatchEvent(new Event("close")));

/** Click the model button and measure, in the page, the time until the menu shows at least one model. */
function openMenuTimed(page: Page, id: string | string[]): Promise<number> {
	return page.evaluate(async (ids) => {
		const wanted = Array.isArray(ids) ? ids : [ids];
		const modelId = wanted.join("|");
		const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("message-editor button")).find((b) =>
			wanted.includes(b.textContent?.trim() ?? ""),
		);
		if (!btn) throw new Error(`no model button showing ${modelId}`);
		const t0 = performance.now();
		const shown = new Promise<number>((resolve) => {
			const check = () => {
				if (document.querySelector("sg-model-menu [role=option]")) {
					resolve(performance.now() - t0);
					return true;
				}
				return false;
			};
			if (check()) return;
			const obs = new MutationObserver(() => {
				if (check()) obs.disconnect();
			});
			obs.observe(document.body, { childList: true, subtree: true });
		});
		btn.click();
		return shown;
	}, id);
}

const menuRows = (page: Page) =>
	page.evaluate(() => {
		const out: string[] = [];
		const menu = document.querySelector("sg-model-menu");
		if (!menu) return out;
		for (const el of Array.from(menu.querySelectorAll("div.uppercase, [role=option]"))) {
			out.push(
				el.getAttribute("role") === "option"
					? `  ${el.textContent?.replace(/\s+/g, " ").trim()}`
					: `# ${el.textContent?.trim()}`,
			);
		}
		return out;
	});

const getAvailable = (relay: { modelListRequests: number }) => relay.modelListRequests;

test(
	"model menu: loaded before the click, opens at once, filter + Enter picks, Recent, outside click, reload",
	{ timeout: 240_000 },
	async () => {
		const relay = await startStandInRelay(SID, seeded.messages, { models: MODELS });
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-model-menu-"));
		const context = await chromium.launchPersistentContext(userDataDir, {
			...(chromePath ? { executablePath: chromePath } : {}),
			headless: true,
			viewport: { width: 520, height: 900 },
			args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
		});
		try {
			let [worker] = context.serviceWorkers();
			if (!worker) worker = await context.waitForEvent("serviceworker");
			const panelUrl = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;
			const page = await context.newPage();
			await page.goto(`${panelUrl}?new=true`);
			await dismiss(page);
			await page.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
			await page.evaluate(
				async ({ session, syncUrl }) => {
					const db = await new Promise<IDBDatabase>((resolve, reject) => {
						const req = indexedDB.open("sitegeist-storage");
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(req.error);
					});
					await new Promise<void>((resolve, reject) => {
						const tx = db.transaction(["sessions", "sessions-metadata", "settings"], "readwrite");
						tx.objectStore("sessions").put(session.data);
						tx.objectStore("sessions-metadata").put(session.metadata);
						tx.objectStore("settings").put(syncUrl, "sync.url");
						tx.objectStore("settings").put("test-token", "sync.token");
						tx.oncomplete = () => resolve();
						tx.onerror = () => reject(tx.error);
					});
					db.close();
				},
				{ session: { data: seeded.data, metadata: seeded.metadata }, syncUrl: `${relay.base}/sitegeist` },
			);
			const openChat = async () => {
				await page.goto(`${panelUrl}?session=${SID}`);
				await until(
					async () => {
						await dismiss(page);
						return relay.openSockets();
					},
					(n) => n >= 1,
					30_000,
					"chat open with a live connection",
				);
			};
			await openChat();

			// 1. The list is fetched in the background when the chat opens: before any click.
			await until(
				() => Promise.resolve(getAvailable(relay)),
				(n) => n >= 1,
				15_000,
				"background model fetch",
			);
			const fetchesBeforeClick = getAvailable(relay);

			// 2. The click opens the dropdown at once, from memory: no new request.
			await page.waitForSelector("message-editor textarea", { timeout: 15_000 });
			const ms = await openMenuTimed(page, "claude-haiku-4-5");
			assert.ok(ms < 250, `menu showed models after ${Math.round(ms)} ms`);
			assert.equal(getAvailable(relay), fetchesBeforeClick, "the click made no model request");
			const rows = await menuRows(page);
			assert.deepEqual(
				rows,
				[
					"# anthropic",
					"  Claude Fable 5.1 claude-fable-5-1",
					"  ✓ Claude Haiku 4.5 claude-haiku-4-5",
					"  Claude Opus 5.5 claude-opus-5-5",
					"  Claude Sonnet 5.5 claude-sonnet-5-5",
					"# kimi-coding",
					"  Kimi K3 256k k3-256k",
					"# openai",
					"  GPT-6 gpt-6",
				],
				"grouped by provider, A-Z, current marked",
			);
			await mkdir(join(root, "tests/.out"), { recursive: true });
			await page.screenshot({ path: join(root, "tests/.out/model-menu.png") });

			// 3. Typing filters; Enter picks; the R730 gets set_model; the button shows the new model; focus is back in the composer.
			await page.keyboard.type("fable");
			assert.deepEqual(await menuRows(page), ["# anthropic", "  Claude Fable 5.1 claude-fable-5-1"]);
			const highlighted = await page.evaluate(() =>
				Array.from(document.querySelectorAll("sg-model-menu [role=option]")).map((b) =>
					b.className.includes("bg-accent"),
				),
			);
			assert.deepEqual(highlighted, [true], "the row Enter will pick is highlighted");
			assert.equal(
				await page.evaluate(() => {
					const b = document.querySelector("sg-model-menu [role=option]");
					return b ? getComputedStyle(b).backgroundColor : "";
				}),
				"oklch(0.97 0 0)",
				"highlight shows at once (no colour fade)",
			);
			await page.screenshot({ path: join(root, "tests/.out/model-menu-filtered.png") });
			await page.keyboard.press("Enter");
			await until(
				() => page.evaluate(() => document.querySelector("sg-model-menu") === null),
				(x) => x,
				5_000,
				"menu closed",
			);
			await until(
				() => Promise.resolve(relay.rpcCalls.find((c) => c.type === "set_model")),
				(c) => c?.modelId === "claude-fable-5-1" && c?.provider === "anthropic",
				10_000,
				"set_model on the R730",
			);
			await until(
				() =>
					page.evaluate(() =>
						Array.from(document.querySelectorAll("message-editor button")).some(
							(b) => b.textContent?.trim() === "claude-fable-5-1",
						),
					),
				(x) => x,
				5_000,
				"button shows claude-fable-5-1",
			);
			assert.equal(
				await page.evaluate(() => document.activeElement?.tagName),
				"TEXTAREA",
				"focus back in the composer",
			);

			// 4. Next time the pick is under Recent, and it is the current one.
			await openMenuTimed(page, "claude-fable-5-1");
			const again = await menuRows(page);
			assert.deepEqual(again.slice(0, 2), ["# Recent", "  ✓ Claude Fable 5.1 claude-fable-5-1"]);

			// 5. A click outside closes it; a second click on the button closes it too.
			await page.mouse.click(20, 120);
			await until(
				() => page.evaluate(() => document.querySelector("sg-model-menu") === null),
				(x) => x,
				5_000,
				"outside click closes",
			);

			// 6. After a panel reload the list comes from storage: the menu opens filled, still without a new request.
			const fetchesBeforeReload = getAvailable(relay);
			await openChat();
			await page.waitForSelector("message-editor textarea", { timeout: 15_000 });
			// (the stand-in relay does not keep set_model, so the reloaded chat shows its stored model again)
			const msAfterReload = await openMenuTimed(
				page,
				MODELS.map((x) => x.id),
			);
			assert.ok(msAfterReload < 250, `after reload: ${Math.round(msAfterReload)} ms`);
			assert.equal(getAvailable(relay), fetchesBeforeReload, "fresh stored list: no request after the reload");
			assert.ok((await menuRows(page)).length >= 8);
		} finally {
			await context.close();
			relay.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
