/**
 * One chat list for every browser (Tom, 2026-11-10: "view a session created on Omarchy on the m4"). Real extension
 * in Chromium, two browser profiles ("laptop" and "Mac") on one stand-in relay:
 *  - a chat the laptop has is in the Mac's list soon after the Mac's panel starts, marked as not opened there yet;
 *  - the Mac's panel does not open that chat by itself at start (the agent's browser tools follow the newest panel
 *    attached to a chat: a panel opening on another machine must not take a chat over);
 *  - a click on it in the Mac's list opens it from the R730, and it is then a normal entry there;
 *  - deleting it on the Mac removes it from the laptop's list too.
 * Saves a screenshot of the Mac's list to tests/.out/ for a human look.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page } from "playwright";
import { seededPrimeSession, startStandInRelay } from "./prime-relay.fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const SID = "sg-2b2b2b2b2b2b";
const TITLE = "Chat started on the laptop";
const seeded = seededPrimeSession(SID, TITLE);

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
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
}

const dismiss = (page: Page) =>
	page.evaluate(() => document.querySelector("userscripts-permission-dialog")?.dispatchEvent(new Event("close")));

/**
 * The panel has started. The permission dialog is added some time after the page loads and holds the panel on
 * "Loading..." until it is closed, so it is closed inside the wait, not once before it.
 */
async function panelUp(page: Page): Promise<void> {
	await until(
		async () => {
			await dismiss(page);
			return page.evaluate(() => document.querySelector("sessions-sidebar") !== null);
		},
		(up) => up,
		30_000,
		"the panel started",
	);
}

async function launch(dir: string): Promise<{ context: BrowserContext; panelUrl: string }> {
	const context = await chromium.launchPersistentContext(dir, {
		...(chromePath ? { executablePath: chromePath } : {}),
		headless: true,
		viewport: { width: 520, height: 900 },
		args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
	});
	let [worker] = context.serviceWorkers();
	if (!worker) worker = await context.waitForEvent("serviceworker");
	return { context, panelUrl: `chrome-extension://${new URL(worker.url()).host}/sidepanel.html` };
}

/** Relay address and token, and (for the laptop) the chat it already has. */
async function seed(page: Page, syncUrl: string, session?: { data: unknown; metadata: unknown }): Promise<void> {
	await page.evaluate(
		async ({ syncUrl, session }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const req = indexedDB.open("sitegeist-storage");
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(["sessions", "sessions-metadata", "settings"], "readwrite");
				if (session) {
					tx.objectStore("sessions").put(session.data);
					tx.objectStore("sessions-metadata").put(session.metadata);
				}
				tx.objectStore("settings").put(syncUrl, "sync.url");
				tx.objectStore("settings").put("test-token", "sync.token");
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		},
		{ syncUrl, session },
	);
}

/** This browser's stored list entry and whether it has the chat's messages. */
const stored = (page: Page, id: string) =>
	page.evaluate(async (id) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open("sitegeist-storage");
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const get = (store: string) =>
			new Promise<unknown>((resolve, reject) => {
				const req = db.transaction([store], "readonly").objectStore(store).get(id);
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
		const entry = await get("sessions-metadata");
		const data = await get("sessions");
		db.close();
		const e = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
		return {
			listed: e !== undefined,
			title: typeof e?.title === "string" ? e.title : "",
			listOnly: e?.sgListOnly === true,
			usedHere: typeof e?.sgUsedHere === "string",
			hasMessages: data !== undefined && data !== null,
		};
	}, id);

async function openSidebar(page: Page): Promise<void> {
	await until(
		async () => {
			await dismiss(page);
			return page.evaluate(() => {
				if (document.querySelector("sessions-sidebar")?.hasAttribute("open")) return true;
				(document.querySelector('button[title="Sessions"]') as HTMLButtonElement | null)?.click();
				return false;
			});
		},
		(open) => open,
		20_000,
		"sessions sidebar open",
	);
}

const rows = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>("sessions-sidebar [data-session-id]")).map((row) => ({
			id: row.dataset.sessionId ?? "",
			listOnly: row.dataset.listOnly === "true",
			title: row.querySelector(".text-sm.truncate")?.textContent?.trim() ?? "",
		})),
	);

test(
	"a chat started in one browser is in the other browser's list, opens there, and a delete reaches both",
	{ timeout: 240_000 },
	async () => {
		const relay = await startStandInRelay(SID, seeded.messages);
		const dirA = await mkdtemp(join(tmpdir(), "sitegeist-list-laptop-"));
		const dirB = await mkdtemp(join(tmpdir(), "sitegeist-list-mac-"));
		const laptop = await launch(dirA);
		const mac = await launch(dirB);
		try {
			// --- the laptop has the chat and opens it
			const a = await laptop.context.newPage();
			await a.goto(`${laptop.panelUrl}?new=true`);
			await panelUp(a);
			await seed(a, `${relay.base}/sitegeist`, { data: seeded.data, metadata: seeded.metadata });
			await a.goto(`${laptop.panelUrl}?session=${SID}`);
			await until(
				async () => {
					await dismiss(a);
					return relay.openSockets();
				},
				(n) => n === 1,
				30_000,
				"the laptop's chat open",
			);
			await until(
				() => Promise.resolve(relay.chatList()),
				(list) => list.some((c) => c.id === SID && !c.deletedAt && c.title === TITLE),
				30_000,
				"the laptop's chat in the R730's list",
			);

			// --- the Mac has never seen it
			const b = await mac.context.newPage();
			await b.goto(`${mac.panelUrl}?new=true`);
			await panelUp(b);
			await seed(b, `${relay.base}/sitegeist`);
			await b.goto(mac.panelUrl); // a plain start: the panel was opened from the toolbar
			const entry = await until(
				async () => {
					await dismiss(b);
					return stored(b, SID);
				},
				(s) => s.listed,
				30_000,
				"the chat in the Mac's list",
			);
			assert.deepEqual(entry, { listed: true, title: TITLE, listOnly: true, usedHere: false, hasMessages: false });

			// A second plain start, now with the chat in the Mac's list: it is not opened by itself.
			await b.goto(mac.panelUrl);
			await until(
				async () => {
					await dismiss(b);
					return b.evaluate(() => document.querySelector("message-editor textarea") !== null);
				},
				(ready) => ready,
				30_000,
				"the Mac's panel ready",
			);
			await new Promise((r) => setTimeout(r, 2500));
			assert.equal(relay.openSockets(), 1, "only the laptop is attached to the chat");
			assert.equal(new URL(b.url()).searchParams.get("session"), null, "the Mac's panel is on a new chat");
			assert.equal(await b.evaluate(() => document.body.innerText.includes("ask away")), false);

			// --- the Mac's list shows it, marked as not opened here yet
			await openSidebar(b);
			const listed = await until(
				() => rows(b),
				(r) => r.some((x) => x.id === SID),
				15_000,
				"the chat in the Mac's sidebar",
			);
			assert.deepEqual(
				listed.find((x) => x.id === SID),
				{ id: SID, listOnly: true, title: TITLE },
			);
			await mkdir(join(root, "tests/.out"), { recursive: true });
			await b.screenshot({ path: join(root, "tests/.out/chat-list-other-browser.png") });

			// --- a word said only on the laptop finds the chat on the Mac, which has not opened it
			const WORD = "zymurgically";
			await a.fill("message-editor textarea", `Note this word: ${WORD}`);
			await a.keyboard.press("Enter");
			await until(
				() => Promise.resolve(relay.chatText(SID) ?? ""),
				(text) => text.includes(WORD),
				60_000,
				"the laptop's search text, with the word, on the R730",
			);
			assert.equal(
				relay.chatText(SID)?.includes("Help me read this article"),
				true,
				"the whole transcript is in it",
			);
			const found = await until(
				async () => {
					await b.fill("sessions-sidebar input", WORD);
					await new Promise((r) => setTimeout(r, 400));
					return rows(b);
				},
				(r) => r.some((x) => x.id === SID),
				60_000,
				"the chat found on the Mac by a word from the laptop's transcript",
			);
			assert.equal(found.length, 1);
			const macSearch = await b.evaluate(
				() => (document.querySelector("sessions-sidebar mark") as HTMLElement | null)?.textContent ?? "",
			);
			assert.equal(macSearch, WORD, "the word is marked in the snippet");
			assert.equal((await stored(b, SID)).hasMessages, false, "still not opened on the Mac");
			await b.screenshot({ path: join(root, "tests/.out/chat-list-search-other-browser.png") });
			await b.fill("sessions-sidebar input", "");

			// --- a click opens it from the R730
			await b.click(`sessions-sidebar [data-session-id="${SID}"]`);
			await until(
				async () => {
					await dismiss(b);
					return b.evaluate(() => document.body.innerText);
				},
				(t) => t.includes("ask away"),
				30_000,
				"the chat's history on the Mac",
			);
			assert.equal(new URL(b.url()).searchParams.get("session"), SID);
			const opened = await until(
				() => stored(b, SID),
				(s) => s.hasMessages,
				20_000,
				"the chat saved on the Mac",
			);
			assert.deepEqual(opened, { listed: true, title: TITLE, listOnly: false, usedHere: true, hasMessages: true });

			// --- deleting it on the Mac removes it from the laptop's list too
			b.on("dialog", (dialog) => {
				assert.match(dialog.message(), /every browser/);
				void dialog.accept();
			});
			await openSidebar(b);
			await b.hover(`sessions-sidebar [data-session-id="${SID}"]`);
			await b.click(`sessions-sidebar [data-session-id="${SID}"] button[title="Delete"]`);
			await until(
				async () => {
					await dismiss(b); // the Mac's panel starts again on a new chat: its start sends the delete
					return relay.chatList();
				},
				(list) => list.some((c) => c.id === SID && c.deletedAt !== undefined),
				30_000,
				"the delete in the R730's list",
			);
			assert.equal((await stored(b, SID)).listed, false, "gone on the Mac");
			await a.goto(`${laptop.panelUrl}?new=true`); // the laptop's panel starts again and asks for changes
			await until(
				async () => {
					await dismiss(a);
					return stored(a, SID);
				},
				(s) => !s.listed && !s.hasMessages,
				30_000,
				"the chat gone from the laptop",
			);
		} finally {
			await laptop.context.close();
			await mac.context.close();
			await relay.close();
			await rm(dirA, { recursive: true, force: true });
			await rm(dirB, { recursive: true, force: true });
		}
	},
);
