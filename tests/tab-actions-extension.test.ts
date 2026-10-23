/**
 * Tab organizing (Tom, 2026-10-24: "I want to organize my tabs ... into targeted windows"): prime's
 * browser_tab_action, called over the relay socket as on the R730, in a real Chromium with the built extension:
 *  1. move two tabs into a new window, then a third into that window; the windows hold what they should;
 *  2. browser_tabs reports each tab's window;
 *  3. close two tabs: they are gone, details lists their title and url, an unknown id is reported, not fatal;
 *  4. the panel itself is never closed, and a bad call (move without a target) is refused.
 * Run: npm run build:chrome && npm run test:tabs:extension
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Worker } from "playwright";
import { seededPrimeSession, startStandInRelay, textOf } from "./prime-relay.fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const SID = "sg-7ab5ac710a5e";
const seeded = seededPrimeSession(SID, "Tab organizing");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, what: string): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T | undefined;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (ok(last)) return last;
		} catch {
			/* not yet */
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
}

async function dismissPermissionDialog(page: Page): Promise<void> {
	await page.evaluate(() =>
		document.querySelector("userscripts-permission-dialog")?.dispatchEvent(new Event("close")),
	);
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
	windowId: number;
	url: string;
}

function tabs(worker: Worker): Promise<TabInfo[]> {
	return worker.evaluate(async () =>
		(await chrome.tabs.query({})).map((t) => ({ id: t.id ?? -1, windowId: t.windowId, url: t.url ?? "" })),
	);
}

const skip = !existsSync(join(dist, "manifest.json")) ? "dist-chrome not built (npm run build:chrome)" : false;

test(
	"browser_tab_action moves tabs into windows and closes tabs, never the panel",
	{ skip, timeout: 180_000 },
	async () => {
		const relay = await startStandInRelay(SID, seeded.messages);
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-tabs-"));
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
			const panel = await context.newPage();
			await panel.goto(`${panelUrl}?new=true`);
			await dismissPermissionDialog(panel);
			await panel.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
			await seedPanelStorage(panel, `${relay.base}/sitegeist`);
			await panel.goto(`${panelUrl}?session=${SID}`);
			await dismissPermissionDialog(panel);
			await until(
				async () => relay.openSockets(),
				(n) => n === 1,
				30_000,
				"one relay socket",
			);

			for (const path of ["/article", "/other", "/next"])
				await (await context.newPage()).goto(`${relay.base}${path}`);
			const all = await tabs(worker);
			const idOf = (path: string): number => {
				const t = all.find((x) => x.url === `${relay.base}${path}`);
				assert.ok(t, `tab ${path}`);
				return t.id;
			};
			const [article, other, next] = [idOf("/article"), idOf("/other"), idOf("/next")];
			const panelTabId = await panel.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
			const panelTab = all.find((t) => t.id === panelTabId);
			assert.ok(panelTab, "panel tab");
			const homeWindow = panelTab.windowId;

			// 1. Move two tabs into a new window, then the third into it.
			const moved = await relay.call("browser_tab_action", {
				action: "move",
				tabIds: [article, other],
				newWindow: true,
			});
			assert.match(textOf(moved), /^Moved 2 tabs to new window \d+\.$/);
			const newWindow = isRecord(moved) && isRecord(moved.details) ? moved.details.windowId : undefined;
			assert.equal(typeof newWindow, "number");
			assert.notEqual(newWindow, homeWindow);
			await relay.call("browser_tab_action", { action: "move", tabIds: [next], windowId: newWindow });
			const after = await tabs(worker);
			const inNew = after.filter((t) => t.windowId === newWindow).map((t) => t.id);
			assert.deepEqual(inNew, [article, other, next], "the new window holds the three pages in order");
			assert.equal(after.find((t) => t.id === panelTab.id)?.windowId, homeWindow, "the panel stayed put");

			// 2. browser_tabs reports each tab's window.
			const listed = await relay.call("browser_tabs");
			const rows =
				isRecord(listed) && isRecord(listed.details) && Array.isArray(listed.details.tabs)
					? listed.details.tabs
					: [];
			const articleRow = rows.find((r) => isRecord(r) && r.id === article);
			assert.ok(isRecord(articleRow) && articleRow.windowId === newWindow, "browser_tabs knows the window");

			// 3. Close two tabs plus an id that does not exist.
			const closed = await relay.call("browser_tab_action", { action: "close", tabIds: [article, other, 999999] });
			assert.match(textOf(closed), /^Closed 2 tabs\. Not found \(already closed\?\): 999999\.$/);
			const closedRows =
				isRecord(closed) && isRecord(closed.details) && Array.isArray(closed.details.closed)
					? closed.details.closed
					: [];
			assert.deepEqual(
				closedRows.map((r) => (isRecord(r) ? r.url : "")),
				[`${relay.base}/article`, `${relay.base}/other`],
				"details lists what was closed, for the reopen log",
			);
			const left = (await tabs(worker)).map((t) => t.id);
			assert.ok(!left.includes(article) && !left.includes(other), "closed tabs are gone");
			assert.ok(left.includes(next), "the others stay");

			// 4. The panel is never closed; a move without a target is refused.
			const self = await relay.call("browser_tab_action", { action: "close", tabIds: [panelTab.id] });
			assert.match(textOf(self), /Nothing to close\. Skipped the sitegeist panel/);
			assert.ok(
				(await tabs(worker)).some((t) => t.id === panelTab.id),
				"the panel is still open",
			);
			const refused = await relay.call("browser_tab_action", { action: "move", tabIds: [next] });
			assert.match(textOf(refused), /move needs exactly one of windowId or newWindow:true/);
		} finally {
			await context.close();
			relay.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
