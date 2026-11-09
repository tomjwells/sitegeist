/**
 * Top bar names the agent (Tom, 2026-11-08: "I should be able to tell quickly which agent this is. In the top bar
 * please ... at the LHS before the chat title and more prominent"), and the Browser agent is gone from new chats
 * ("Just get rid of the browser agent please"), and a new chat needs an agent picked first ("when you create a new chat,
 * you're forced to pick one of the agents"). Real extension, stand-in relay. Screenshots in tests/.out/.
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
const out = join(root, "tests/.out");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const SID = "sg-4c4c4c4c4c4c";

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

/** Header left group, in order: what each child shows. */
const headerLeft = (page: Page) =>
	page.evaluate(() => {
		const badge = document.querySelector(".sg-agent-badge");
		const pick = document.querySelector(".sg-agent-pick button");
		const title = document.querySelector('button[title="Click to edit title"]');
		const left = badge?.parentElement ?? pick?.closest("div");
		const kids = left ? Array.from(left.children) : [];
		const pos = (el: Element | null | undefined) => (el ? kids.findIndex((k) => k === el || k.contains(el)) : -1);
		const b = badge?.getBoundingClientRect();
		return {
			badge: badge?.textContent?.trim() ?? null,
			badgeAgent: badge?.getAttribute("data-agent") ?? null,
			badgeFont: badge ? getComputedStyle(badge).fontWeight : null,
			badgeLeft: b ? Math.round(b.left) : null,
			pick: pick?.textContent?.replace(/\s+/g, " ").trim() ?? null,
			badgeBeforeTitle: badge && title ? pos(badge) < pos(title) : null,
			welcomeCard: document.body.innerText.includes("Your AI companion"),
		};
	});

test(
	"top bar names the agent before the title; new chats are R730 chats with no Browser agent option",
	{ timeout: 60_000 },
	async () => {
		const seeded = seededPrimeSession(SID, "A chat with main-pi");
		const relay = await startStandInRelay(SID, seeded.messages);
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-header-"));
		const context = await chromium.launchPersistentContext(userDataDir, {
			...(chromePath ? { executablePath: chromePath } : {}),
			headless: true,
			viewport: { width: 520, height: 700 },
			args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
		});
		try {
			await mkdir(out, { recursive: true });
			let [worker] = context.serviceWorkers();
			if (!worker) worker = await context.waitForEvent("serviceworker");
			const panelUrl = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;
			const page = await context.newPage();
			await page.goto(`${panelUrl}?session=${SID}`);
			await dismiss(page);
			await page.waitForSelector("sessions-sidebar", { timeout: 20_000, state: "attached" });
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

			// 1. an open chat: the agent badge, bold, left of the title
			await page.goto(`${panelUrl}?session=${SID}`);
			const open = await until(
				async () => {
					await dismiss(page);
					return headerLeft(page);
				},
				(h) => h.badge !== null && h.badgeBeforeTitle === true,
				20_000,
				"agent badge before the title",
			);
			assert.equal(open.badge, "main-pi");
			assert.equal(open.badgeAgent, "prime");
			assert.ok(Number(open.badgeFont) >= 600, `badge is bold (${open.badgeFont})`);
			assert.ok((open.badgeLeft ?? 999) < 120, `badge is at the left (${open.badgeLeft}px)`);
			await page.screenshot({
				path: join(out, "header-agent-badge.png"),
				clip: { x: 0, y: 0, width: 520, height: 60 },
			});

			// 2. a new chat: no agent until Tom picks one ("Pick an agent", highlighted), no Browser agent option, no welcome card
			await page.goto(`${panelUrl}?new=true`);
			const fresh = await until(
				async () => {
					await dismiss(page);
					return headerLeft(page);
				},
				(h) => h.pick !== null,
				20_000,
				"agent menu on a new chat",
			);
			assert.equal(fresh.pick, "Pick an agent");
			assert.equal(await page.getAttribute(".sg-agent-pick", "data-picked"), "false");
			assert.equal(fresh.welcomeCard, false, "no Browser agent welcome card");
			await page.screenshot({
				path: join(out, "header-new-chat.png"),
				clip: { x: 0, y: 0, width: 520, height: 60 },
			});

			// sending before picking is refused: a note, the menu opens, the text stays, nothing reaches the R730
			const promptsBefore = relay.prompts.length;
			await page.fill("message-editor textarea", "hello there");
			await page.keyboard.press("Enter");
			await page.waitForSelector("toast-notification", { timeout: 5_000, state: "attached" });
			assert.match((await page.textContent("toast-notification")) ?? "", /Pick an agent for this chat first/);
			const options = await until(
				() =>
					page.evaluate(() =>
						(document.querySelector(".select-portal-container")?.textContent ?? "").replace(/\s+/g, " ").trim(),
					),
				(t) => t.length > 0,
				5_000,
				"agent menu opened by the refused send",
			);
			assert.ok(!options.includes("Browser agent"), `no Browser agent option: ${options}`);
			assert.equal(await page.inputValue("message-editor textarea"), "hello there", "the text stays in the box");
			assert.equal(relay.prompts.length, promptsBefore, "nothing sent");
			await page.screenshot({
				path: join(out, "header-pick-agent.png"),
				clip: { x: 0, y: 0, width: 520, height: 160 },
			});

			// pick main-pi: the menu shows it, no longer highlighted
			await page.locator(".select-portal-container").getByText("main-pi", { exact: true }).click();
			const picked = await until(
				() => headerLeft(page),
				(h) => h.pick === "main-pi",
				5_000,
				"main-pi picked",
			);
			assert.equal(picked.pick, "main-pi");
			assert.equal(await page.getAttribute(".sg-agent-pick", "data-picked"), "true");

			// 3. an old "?agent=browser" link opens a new chat that still needs a pick; "?agent=prime" counts as picked
			await page.goto(`${panelUrl}?new=true&agent=browser`);
			const old = await until(
				async () => {
					await dismiss(page);
					return headerLeft(page);
				},
				(h) => h.pick !== null,
				20_000,
				"agent menu for an old browser link",
			);
			assert.equal(old.pick, "Pick an agent");
			await page.goto(`${panelUrl}?new=true&agent=prime`);
			const direct = await until(
				async () => {
					await dismiss(page);
					return headerLeft(page);
				},
				(h) => h.pick !== null,
				20_000,
				"agent menu for ?agent=prime",
			);
			assert.equal(direct.pick, "main-pi");
		} finally {
			await context.close();
			relay.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
