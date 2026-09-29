import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page, type Worker } from "playwright";

/**
 * Real-extension check of page anchors (tests/anchors.test.ts covers the pure logic): the built
 * dist-chrome is loaded into Chromium, sessions are seeded straight into the extension's IndexedDB,
 * anchors into chrome.storage.local, and the side panel document is opened as an INACTIVE tab of the
 * same window (so "the active tab" is the page under test, as in the real panel). Asserts the badge,
 * resume-on-open, resume-on-tab-switch, Undo and the hand-override suppression.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

function session(id: string, title: string, lastModified: string) {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const messages = [
		{ role: "user", content: `about ${title}`, timestamp: Date.parse(lastModified) - 1000 },
		{
			role: "assistant",
			content: [{ type: "text", text: `Sure: ${title}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: Date.parse(lastModified),
		},
	];
	return {
		data: { id, title, model, thinkingLevel: "off", messages, createdAt: lastModified, lastModified },
		metadata: {
			id,
			title,
			createdAt: lastModified,
			lastModified,
			messageCount: messages.length,
			usage,
			modelId: model.id,
			thinkingLevel: "off",
			preview: title,
		},
	};
}

async function dismissPermissionDialog(page: Page): Promise<void> {
	// No userScripts API in a fresh test profile → initApp waits on the permission dialog; closing it continues.
	await page.waitForSelector("userscripts-permission-dialog", { timeout: 15_000, state: "attached" });
	await page.evaluate(() =>
		document.querySelector("userscripts-permission-dialog")?.dispatchEvent(new Event("close")),
	);
}

async function seedSessions(page: Page, list: ReturnType<typeof session>[]): Promise<void> {
	await page.evaluate(async (items) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open("sitegeist-storage");
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(["sessions", "sessions-metadata"], "readwrite");
			for (const item of items) {
				tx.objectStore("sessions").put(item.data);
				tx.objectStore("sessions-metadata").put(item.metadata);
			}
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	}, list);
}

/** Polls fn until ok; evaluation errors (the panel navigating mid-evaluate) count as "not yet". */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000, label = "condition"): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T | undefined;
	let done = false;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (ok(last)) {
				done = true;
				break;
			}
		} catch {
			/* navigation in progress */
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	if (!done || last === undefined) throw new Error(`timed out waiting for ${label}; last = ${JSON.stringify(last)}`);
	return last;
}

async function openPanelTab(
	context: BrowserContext,
	worker: Worker,
	extensionId: string,
	windowId: number,
): Promise<Page> {
	const url = `chrome-extension://${extensionId}/sidepanel.html`;
	await worker.evaluate(({ url, windowId }) => chrome.tabs.create({ url, active: false, windowId }), {
		url,
		windowId,
	});
	const page = await until(
		async () => context.pages().find((p) => p.url().startsWith(url)),
		(p) => p !== undefined,
		20_000,
		"panel tab",
	);
	if (!page) throw new Error("panel tab not found");
	await dismissPermissionDialog(page);
	return page;
}

test("built extension: sessions resume from the page they belong to", { timeout: 120_000 }, async () => {
	const server = createServer((req, res) => {
		res.setHeader("content-type", "text/html");
		res.end(
			`<title>${req.url?.startsWith("/video") ? "The Life of a Process" : "Corne kit"}</title><h1>${req.url}</h1>`,
		);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const base = `http://127.0.0.1:${address.port}`;
	const host = `127.0.0.1:${address.port}`;
	const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-anchors-"));
	const context = await chromium.launchPersistentContext(userDataDir, {
		...(chromePath ? { executablePath: chromePath } : {}),
		headless: true,
		args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
	});
	try {
		let [worker] = context.serviceWorkers();
		if (!worker) worker = await context.waitForEvent("serviceworker");
		const extensionId = new URL(worker.url()).host;

		// 1. Bootstrap: one panel document creates the IndexedDB schema; seed two sessions through it, then close it.
		const boot = await context.newPage();
		await boot.goto(`chrome-extension://${extensionId}/sidepanel.html?new=true`);
		await dismissPermissionDialog(boot);
		await boot.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
		const video = session("s-video", "Life of a Process Q&A", "2026-09-29T01:00:00.000Z");
		const shop = session("s-shop", "Split keyboard research", "2026-09-29T02:00:00.000Z");
		await seedSessions(boot, [video, shop]);
		const windowId = await boot.evaluate(async () => (await chrome.windows.getCurrent()).id);
		assert.ok(typeof windowId === "number");
		await boot.close();
		await worker.evaluate(
			(list) => chrome.storage.local.set({ "sg.anchors": list }),
			[
				{
					key: `${host}/video`,
					url: `${base}/video`,
					pageTitle: "The Life of a Process",
					sessionId: "s-video",
					lastActive: "2026-09-29T01:00:00.000Z",
					pinned: false,
				},
				{
					key: `${host}/shop/corne`,
					url: `${base}/shop/corne`,
					pageTitle: "Corne kit",
					sessionId: "s-shop",
					lastActive: "2026-09-29T02:00:00.000Z",
					pinned: true,
				},
			],
		);

		// 2. Tom is on the video (active tab). Opening the panel resumes the video session, not the latest (shop) one.
		const videoTab = await context.newPage();
		await videoTab.goto(`${base}/video?t=42`);
		const panel = await openPanelTab(context, worker, extensionId, windowId);
		await until(
			() => panel.evaluate(() => location.search),
			(s) => s.includes("session=s-video"),
			30_000,
			"resume on open",
		);
		await until(
			() => panel.evaluate(() => document.body.innerText),
			(t) => t.includes('Resumed "Life of a Process Q&A" for this page'),
			15_000,
			"resume toast",
		);
		await until(
			() => panel.evaluate(() => document.querySelector('button[title^="This page is attached"]') !== null),
			(v) => v,
			10_000,
			"attached header button",
		);
		// the toast's Undo would go to the latest other session (shop)
		assert.ok(
			await panel.evaluate(() =>
				Array.from(document.querySelectorAll("toast-notification button")).some(
					(b) => b.textContent?.trim() === "Undo",
				),
			),
		);

		// 3. Switch to the keyboard shop tab: the panel switches to the research session and offers Undo.
		const shopTab = await context.newPage();
		await shopTab.goto(`${base}/shop/corne`);
		await shopTab.bringToFront();
		await until(
			() => panel.evaluate(() => location.search),
			(s) => s.includes("session=s-shop"),
			30_000,
			"resume on tab switch",
		);
		await dismissPermissionDialog(panel);
		await until(
			() => panel.evaluate(() => document.body.innerText),
			(t) => t.includes('Resumed "Split keyboard research" for this page'),
			20_000,
			"second toast",
		);
		await panel.evaluate(() => {
			const undo = Array.from(document.querySelectorAll("toast-notification button")).find(
				(b) => b.textContent?.trim() === "Undo",
			) as HTMLButtonElement | undefined;
			undo?.click();
		});
		await until(
			() => panel.evaluate(() => location.search),
			(s) => s.includes("session=s-video") && !s.includes("resumed="),
			30_000,
			"undo back to video session",
		);
		await dismissPermissionDialog(panel);
		await panel.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });

		// 4. Undo = Tom overrode this page by hand: bouncing between the two tabs no longer switches the session.
		await videoTab.bringToFront();
		await shopTab.bringToFront();
		await new Promise((r) => setTimeout(r, 2500));
		assert.ok((await panel.evaluate(() => location.search)).includes("session=s-video"), "suppressed after Undo");
		// ...and the shop page shows in the sidebar's "This page" section with a detach button
		await panel.evaluate(() =>
			(document.querySelector('button[title="Sessions"]') as HTMLButtonElement | null)?.click(),
		);
		await until(
			() => panel.evaluate(() => document.querySelector("sessions-sidebar")?.textContent ?? ""),
			(t) => t.includes("This page") && t.includes("Split keyboard research"),
			15_000,
			"This page section",
		);
		assert.ok(
			await panel.evaluate(
				() => document.querySelector('sessions-sidebar button[title^="Detach this page"]') !== null,
			),
		);

		// 5. Badge on the toolbar icon for the video tab (2 = nothing else bound there → "1")
		const videoTabId = await worker.evaluate(
			async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0]?.id,
			`${base}/video`,
		);
		assert.ok(typeof videoTabId === "number");
		const badge = await until(
			() => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), videoTabId),
			(t) => t === "1",
			10_000,
			"badge",
		);
		assert.equal(badge, "1");
	} finally {
		await context.close();
		server.close();
		await rm(userDataDir, { recursive: true, force: true });
	}
});
