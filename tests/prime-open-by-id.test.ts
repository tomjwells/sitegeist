/**
 * Chats the panel's own list does not have (Tom, 2026-10-25: a new Jennifer chat about whey "disappeared" - the
 * panel left it before the first reply arrived, and a prime chat only went into the list with its first reply, so
 * only the R730 knew it existed):
 * 1. a new R730 chat is in the list as soon as the R730 has its first message, not only after a reply;
 * 2. pasting an R730 chat id into the sidebar search offers "Open it from the R730", which opens it (history from
 *    the R730) and adds it to the list;
 * 3. an id the R730 does not have says so and never creates a chat.
 * Real extension in Chromium against the stand-in relay (tests/prime-relay.fixture.ts).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page } from "playwright";
import { seededPrimeSession, startStandInRelay } from "./prime-relay.fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (ok(last)) return last;
		} catch {
			/* evaluating mid-navigation: not yet */
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

/** A fresh profile pointed at the stand-in relay; returns the panel URL. */
async function openProfile(syncUrl: string): Promise<{ context: BrowserContext; panelUrl: string; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "sitegeist-open-by-id-"));
	const context = await chromium.launchPersistentContext(dir, {
		...(chromePath ? { executablePath: chromePath } : {}),
		headless: true,
		args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
	});
	let [worker] = context.serviceWorkers();
	if (!worker) worker = await context.waitForEvent("serviceworker");
	const panelUrl = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;
	const boot = await context.newPage();
	await boot.goto(`${panelUrl}?new=true`);
	await dismissPermissionDialog(boot);
	await boot.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
	await boot.evaluate(async (url) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open("sitegeist-storage");
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(["settings"], "readwrite");
			tx.objectStore("settings").put(url, "sync.url");
			tx.objectStore("settings").put("test-token", "sync.token");
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	}, syncUrl);
	await boot.close();
	return { context, panelUrl, dir };
}

/** The panel's own list: session id -> title. */
function listed(page: Page): Promise<Record<string, string>> {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open("sitegeist-storage");
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const rows = await new Promise<unknown[]>((resolve, reject) => {
			const q = db.transaction(["sessions-metadata"]).objectStore("sessions-metadata").getAll();
			q.onsuccess = () => resolve(q.result);
			q.onerror = () => reject(q.error);
		});
		db.close();
		const out: Record<string, string> = {};
		for (const r of rows) {
			if (typeof r === "object" && r !== null && "id" in r && typeof r.id === "string")
				out[r.id] = "title" in r && typeof r.title === "string" ? r.title : "";
		}
		return out;
	});
}

async function search(page: Page, q: string): Promise<void> {
	// open the sidebar (the panel may still be asking for the userScripts permission after a reload)
	await until(
		async () => {
			await dismissPermissionDialog(page);
			return page.evaluate(() => {
				const sidebar = document.querySelector("sessions-sidebar");
				if (sidebar?.hasAttribute("open")) return true;
				(document.querySelector('button[title="Sessions"]') as HTMLButtonElement | null)?.click();
				return false;
			});
		},
		(open) => open,
		20_000,
		"sessions sidebar open",
	);
	await page.waitForSelector("sessions-sidebar input[type=text]", { timeout: 15_000 });
	await page.evaluate((value) => {
		const input = document.querySelector("sessions-sidebar input[type=text]") as HTMLInputElement | null;
		if (!input) throw new Error("no search box");
		input.value = value;
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
	}, q);
}

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

test("a new R730 chat is in the list as soon as the R730 has its first message", { timeout: 180_000 }, async () => {
	const SID = "sg-1a1a1a1a1a1a";
	const relay = await startStandInRelay(SID, []); // no history: the panel's new chat becomes this session
	const { context, panelUrl, dir } = await openProfile(`${relay.base}/sitegeist`);
	try {
		const page = await context.newPage();
		await page.goto(`${panelUrl}?new=true&agent=prime`);
		await dismissPermissionDialog(page);
		await until(
			async () => {
				await dismissPermissionDialog(page);
				return page.evaluate(() => document.querySelector("message-editor textarea") !== null);
			},
			(ok) => ok,
			30_000,
			"composer",
		);
		await page.fill("message-editor textarea", "Help me find some whey protein to buy.");
		await page.keyboard.press("Enter");
		await until(
			() => Promise.resolve(relay.prompts.length),
			(n) => n === 1,
			30_000,
			"the R730 has the message",
		);
		assert.equal(relay.created(), 1);
		// No reply has come (the stand-in only echoes the message), and the chat is in the list already.
		const list = await until(
			() => listed(page),
			(l) => SID in l,
			15_000,
			"chat in the list before any reply",
		);
		assert.match(list[SID] ?? "", /^Help me find some whey protein/);
		assert.ok((await page.evaluate(() => location.search)).includes(`session=${SID}`));
	} finally {
		await context.close();
		relay.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a pasted R730 chat id opens the chat from the R730; an unknown id says so", { timeout: 180_000 }, async () => {
	const SID = "sg-2b2b2b2b2b2b";
	const seeded = seededPrimeSession(SID, "unused");
	const relay = await startStandInRelay(SID, seeded.messages);
	const { context, panelUrl, dir } = await openProfile(`${relay.base}/sitegeist`);
	try {
		const page = await context.newPage();
		await page.goto(`${panelUrl}?new=true`);
		await dismissPermissionDialog(page);
		await page.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
		assert.ok(!(SID in (await listed(page))), "this browser has never seen the chat");

		// Paste the id: not in the list, but the sidebar offers to open it from the R730.
		await search(page, SID);
		await until(
			() => page.evaluate(() => document.querySelector("sessions-sidebar")?.textContent ?? ""),
			(t) => t.includes("is not in this browser's list") && t.includes("Open it from the R730"),
			15_000,
			"open-from-R730 offer",
		);
		await page.evaluate(() =>
			(document.querySelector("sessions-sidebar .sg-open-r730") as HTMLButtonElement | null)?.click(),
		);
		await until(
			async () => {
				await dismissPermissionDialog(page); // the panel reloads on the new URL and asks again
				return page.evaluate(() => `${location.search}|${document.body.innerText}`);
			},
			(t) => t.includes(`session=${SID}`) && t.includes("ask away") && t.includes("Opened from the R730"),
			30_000,
			"chat opened from the R730",
		);
		await dismissPermissionDialog(page);
		const list = await until(
			() => listed(page),
			(l) => SID in l,
			15_000,
			"chat added to the list",
		);
		assert.equal(list[SID], "Help me read this article.", "titled from the R730");

		// An id the R730 does not have: said so, back on a new chat, nothing created.
		await page.goto(`${panelUrl}?new=true`);
		await dismissPermissionDialog(page);
		await page.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
		await search(page, "sg-3c3c3c3c3c3c");
		await page.waitForSelector("sessions-sidebar .sg-open-r730", { timeout: 15_000 });
		await page.evaluate(() =>
			(document.querySelector("sessions-sidebar .sg-open-r730") as HTMLButtonElement | null)?.click(),
		);
		await until(
			async () => {
				await dismissPermissionDialog(page);
				return bodyText(page);
			},
			(t) => t.includes("Could not open sg-3c3c3c3c3c3c: the R730 has no chat with that id."),
			30_000,
			"unknown id notice",
		);
		assert.ok(!(await page.evaluate(() => location.search)).includes("session="), "no session in the URL");
		assert.equal(relay.created(), 0, "asking never creates a chat");
		assert.ok(!("sg-3c3c3c3c3c3c" in (await listed(page))));
	} finally {
		await context.close();
		relay.close();
		await rm(dir, { recursive: true, force: true });
	}
});
