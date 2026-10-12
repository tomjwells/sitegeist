/**
 * sitegeist next to the page (Tom, 2026-10-12) in a real Chrome with the Split View API (Chrome 155+):
 *  1. The panel's "Open next to this page" button moves the chat, with its unsent text, into a tab in a split view
 *     beside the page: the new tab opens the chat (the session lock moves with it) and shows the text.
 *  2. prime's browser tools, called over the relay socket as on the R730, work on the page beside the panel and not on
 *     the panel: browser_eval, browser_page, browser_screenshot (shows the page; the panel stays the focused half),
 *     browser_navigate (navigates the page; the split view stays).
 *  3. Tom clicks into the page half, or goes to another tab: the tools still work on the page beside the panel.
 *  4. A tab the agent opens stays behind the split view and is "the page" until Tom's next prompt.
 *  5. The toolbar menu / shortcut for the same page brings the panel tab forward instead of opening a second one.
 * Needs Chrome 155+ (Chrome for Testing): SITEGEIST_SPLIT_CHROME, default
 * ~/.cache/sitegeist-split-test/chrome-linux64/chrome; skipped when missing.
 * Run: npm run build:chrome && npm run test:split:extension
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page, type Worker } from "playwright";
import { imageOf, seededPrimeSession, startStandInRelay, textOf } from "./prime-relay.fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath =
	process.env.SITEGEIST_SPLIT_CHROME ?? join(homedir(), ".cache", "sitegeist-split-test", "chrome-linux64", "chrome");
const SID = "sg-5b1d0e7a9c3f";
const DRAFT = "What is the main argument here?";
const seeded = seededPrimeSession(SID, "Reading companion");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls fn until ok; evaluation errors (a page navigating mid-evaluate) count as "not yet". */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, label: string): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T | undefined;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (ok(last)) return last;
		} catch {
			/* not yet */
		}
		await sleep(150);
	}
	throw new Error(`timed out waiting for ${label}; last = ${JSON.stringify(last)}`);
}

/** chrome://extensions → sitegeist → "Allow User Scripts", as Tom does once (page scripts need it in Chrome 138+). */
async function allowUserScripts(context: BrowserContext, worker: Worker, extensionId: string): Promise<void> {
	const page = await context.newPage();
	await page.goto(`chrome://extensions/?id=${extensionId}`);
	await until(
		() =>
			page.evaluate(() => {
				const find = (root: Document | ShadowRoot): Element | null => {
					const hit = root.querySelector("#allow-user-scripts");
					if (hit) return hit;
					for (const el of root.querySelectorAll("*")) {
						const inner = el.shadowRoot ? find(el.shadowRoot) : null;
						if (inner) return inner;
					}
					return null;
				};
				const toggle = find(document)?.shadowRoot?.querySelector("cr-toggle");
				if (!(toggle instanceof HTMLElement)) return false;
				toggle.click();
				return true;
			}),
		(clicked) => clicked,
		15_000,
		"Allow User Scripts toggle",
	);
	await until(
		() => worker.evaluate(() => typeof chrome.userScripts?.execute),
		(t) => t === "function",
		10_000,
		"userScripts API",
	);
	await page.close();
}

async function seedPanelStorage(page: Page, syncUrl: string): Promise<void> {
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
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		},
		{ session: { data: seeded.data, metadata: seeded.metadata }, syncUrl },
	);
}

interface TabInfo {
	id: number;
	url: string;
	active: boolean;
	split: number;
}

async function tabs(worker: Worker): Promise<TabInfo[]> {
	return worker.evaluate(async () =>
		(await chrome.tabs.query({})).map((t) => ({
			id: t.id ?? -1,
			url: t.url ?? "",
			active: t.active,
			split: t.splitViewId ?? -1,
		})),
	);
}

async function tab(worker: Worker, id: number): Promise<TabInfo> {
	const found = (await tabs(worker)).find((t) => t.id === id);
	if (!found) throw new Error(`tab ${id} is gone`);
	return found;
}

const skip = !existsSync(chromePath)
	? `Chrome 155+ not found at ${chromePath} (set SITEGEIST_SPLIT_CHROME)`
	: !existsSync(join(dist, "manifest.json"))
		? "dist-chrome not built (npm run build:chrome)"
		: false;

test(
	"sitegeist next to the page: split view, the chat moves along, tools work on the page beside the panel",
	{ skip, timeout: 240_000 },
	async () => {
		const relay = await startStandInRelay(SID, seeded.messages);
		const { base } = relay;
		const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "sitegeist-split-")), {
			executablePath: chromePath,
			headless: true,
			viewport: null,
			args: [
				"--headless=new",
				"--window-size=1400,900",
				`--disable-extensions-except=${dist}`,
				`--load-extension=${dist}`,
			],
		});
		try {
			let [worker] = context.serviceWorkers();
			if (!worker) worker = await context.waitForEvent("serviceworker");
			const extensionId = new URL(worker.url()).host;
			const panelPage = `chrome-extension://${extensionId}/sidepanel.html`;
			await allowUserScripts(context, worker, extensionId);

			// The side panel stand-in (a plain panel tab behaves like the side panel): seed the chat and the relay URL.
			const side = await context.newPage();
			await side.goto(`${panelPage}?new=true`);
			await side.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
			await seedPanelStorage(side, `${base}/sitegeist`);

			// Tom reads an article; the side panel shows the chat, with an unsent question typed.
			const article = await context.newPage();
			await article.goto(`${base}/article`);
			const articleId = (await tabs(worker)).find((t) => t.url === `${base}/article`)?.id;
			assert.ok(articleId !== undefined, "article tab");
			await side.goto(`${panelPage}?session=${SID}`);
			await until(
				() => side.evaluate(() => document.body.innerText),
				(t) => t.includes("ask away"),
				30_000,
				"chat",
			);
			await side.fill("message-editor textarea", DRAFT);
			await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), articleId);

			// 1. "Open next to this page" in the panel header.
			await until(
				() =>
					side.evaluate(() => {
						const button = document.querySelector('button[title^="Open next to this page"]');
						if (!(button instanceof HTMLButtonElement)) return false;
						button.click();
						return true;
					}),
				(clicked) => clicked,
				15_000,
				"move button",
			);
			const [panelTab] = await until(
				async () => (await tabs(worker)).filter((t) => t.url.startsWith(`${panelPage}?page=${articleId}`)),
				(list) => list.length === 1,
				15_000,
				"panel tab",
			);
			assert.ok(panelTab);
			const panelId = panelTab.id;
			assert.ok(panelTab.url.includes(`session=${SID}`), panelTab.url);
			const articleTab = await tab(worker, articleId);
			assert.notEqual(articleTab.split, -1, "the page is in a split view");
			assert.equal(articleTab.split, panelTab.split, "the panel tab is the other half of the page's split view");
			assert.equal(panelTab.active, true, "the panel half has the focus");
			await side.close(); // the side panel closes after the move

			const panel = await until(
				async () => context.pages().find((p) => p.url().startsWith(`${panelPage}?page=`)),
				(p) => p !== undefined,
				15_000,
				"panel page",
			);
			assert.ok(panel);
			await until(
				() => panel.evaluate(() => document.body.innerText),
				(t) => t.includes("ask away"),
				30_000,
				"moved chat",
			);
			const draft = await until(
				() =>
					panel.evaluate(
						() => document.querySelector<HTMLTextAreaElement>("message-editor textarea")?.value ?? "",
					),
				(v) => v === DRAFT,
				10_000,
				"unsent text in the new tab",
			);
			assert.equal(draft, DRAFT);
			const beside = () => panel.evaluate(() => document.querySelector("[data-sg-beside]")?.textContent ?? "");
			await until(beside, (t) => t.includes("Article"), 10_000, "beside label");
			const locks = await worker.evaluate(
				async () => (await chrome.storage.session.get("session_locks")).session_locks,
			);
			assert.deepEqual(locks, { [SID]: `t:${panelId}` }, "the panel tab holds the chat");

			// 2. prime's browser tools work on the page beside the panel, and the panel keeps the focus.
			await until(
				async () => relay.openSockets(),
				(n) => n === 1,
				20_000,
				"one relay socket",
			);
			const where = async (): Promise<unknown> =>
				JSON.parse(
					textOf(await relay.call("browser_eval", { code: "return document.title + '|' + location.pathname" })),
				);
			assert.equal(await where(), "Article|/article");
			assert.equal((await tab(worker, panelId)).active, true, "eval did not move the focus out of the chat");
			assert.ok(textOf(await relay.call("browser_page")).includes("ARTICLE"));
			const listed = textOf(await relay.call("browser_tabs"));
			assert.ok(listed.includes(`${articleId}\t>\tArticle`), `the page beside the panel is marked: ${listed}`);
			assert.ok(!listed.includes("sidepanel.html"), "the panel itself is not listed");
			const shot = imageOf(await relay.call("browser_screenshot"));
			assert.ok(shot, "screenshot image");
			const pixel = await panel.evaluate(async (b64) => {
				const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const ctx = canvas.getContext("2d");
				if (!ctx) return [];
				ctx.drawImage(bitmap, 0, 0);
				return Array.from(ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data);
			}, shot);
			assert.ok((pixel[0] ?? 0) > 150 && (pixel[1] ?? 255) < 60, `screenshot shows the article (red), got ${pixel}`);
			assert.equal((await tab(worker, panelId)).active, true, "the panel has the focus again after the screenshot");

			// 3. Tom clicks into the page half: same page. Tom goes to another tab: still the page beside the panel.
			await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), articleId);
			assert.equal(await panel.evaluate(() => document.visibilityState), "visible", "both halves stay on screen");
			assert.equal(await where(), "Article|/article");
			// (Headless Chrome reports background tabs as "visible", so this checks the split-view rule; the Zen test
			// covers the visibility rule.)
			const other = await context.newPage();
			await other.goto(`${base}/other`);
			assert.equal((await tab(worker, panelId)).active, false, "Tom is on another tab");
			assert.equal(await where(), "Article|/article", "Tom on another tab: the page beside the panel");
			const navigated = await relay.call("browser_navigate", { url: `${base}/next` });
			assert.ok(textOf(navigated).includes(`tab ${articleId}`), textOf(navigated));
			const nextTab = await tab(worker, articleId);
			assert.equal(nextTab.url, `${base}/next`);
			assert.equal(nextTab.split, panelTab.split, "the split view stays");
			assert.equal((await tab(worker, panelId)).url.startsWith(panelPage), true, "the panel did not navigate");
			await until(beside, (t) => t.includes("Next"), 10_000, "beside label follows the page");

			// 4. A tab the agent opens stays behind the split view and is the page until Tom's next prompt.
			await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), panelId);
			const opened = await relay.call("browser_navigate", { url: `${base}/other`, newTab: true });
			const openedId = isRecord(opened) && isRecord(opened.details) ? opened.details.tabId : undefined;
			assert.equal(typeof openedId, "number");
			assert.equal((await tab(worker, panelId)).active, true, "the new tab opened behind the split view");
			assert.equal(await where(), "Other|/other", "the agent's own tab is the page for now");
			await panel.fill("message-editor textarea", "and now?");
			await panel.press("message-editor textarea", "Enter");
			await until(
				async () => relay.prompts.length,
				(n) => n > 0,
				10_000,
				"prompt sent to the relay",
			);
			assert.equal(await where(), "Next|/next", "Tom's prompt: back to the page beside the panel");

			// 5. Toolbar menu / shortcut on the same page: the existing panel tab comes forward, no second one.
			const again = await panel.evaluate(
				(pageTabId) => chrome.runtime.sendMessage({ type: "sg-open-beside", pageTabId }),
				articleId,
			);
			assert.ok(isRecord(again) && again.ok === true && again.tabId === panelId, JSON.stringify(again));
			const panels = (await tabs(worker)).filter((t) => t.url.startsWith(panelPage));
			assert.equal(panels.length, 1, "one panel tab");
		} finally {
			await context.close();
			relay.close();
		}
	},
);
