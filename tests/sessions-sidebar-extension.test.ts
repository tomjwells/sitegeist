/**
 * Sessions list in the real extension (Tom, 2026-11-07, Zen): the agent filter is a dropdown, not a row of chips that
 * runs off the side of the sidebar with seven agents. Seeds chats for eight agents, opens the list, checks nothing
 * overflows sideways, picks an agent in the dropdown and sees only that agent's chats. Screenshots in tests/.out/.
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

const AGENTS = [
	"sedcoach",
	"quantcoach",
	"jennifer",
	"startupoperator",
	"shreddedcoach",
	"cassianvale",
	"wealthmindset",
];
const CHATS = [
	{ id: "sg-1a1a1a1a1a1a", title: "main-pi chat about the R730" },
	...AGENTS.map((a, i) => ({ id: `sg-${a}-${String(i).repeat(12).slice(0, 12)}`, title: `${a} chat number ${i}` })),
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
const rowTitles = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll("sessions-sidebar .group .text-sm.truncate")).map(
			(e) => e.textContent?.trim() ?? "",
		),
	);

test(
	"sessions list: the agent filter is a dropdown that fits the sidebar and filters",
	{ timeout: 180_000 },
	async () => {
		const first = CHATS[0];
		assert.ok(first);
		const seeded = seededPrimeSession(first.id, first.title);
		const relay = await startStandInRelay(first.id, seeded.messages);
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-sidebar-"));
		const context = await chromium.launchPersistentContext(userDataDir, {
			...(chromePath ? { executablePath: chromePath } : {}),
			headless: true,
			viewport: { width: 420, height: 800 },
			args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
		});
		try {
			await mkdir(out, { recursive: true });
			let [worker] = context.serviceWorkers();
			if (!worker) worker = await context.waitForEvent("serviceworker");
			const panelUrl = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;
			const page = await context.newPage();
			await page.goto(`${panelUrl}?new=true`);
			await dismiss(page);
			await page.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
			const sessions = CHATS.map((c, i) => {
				const s = seededPrimeSession(c.id, c.title);
				const at = new Date(Date.parse("2026-11-07T12:00:00Z") - i * 60_000).toISOString();
				return { data: { ...s.data, lastModified: at }, metadata: { ...s.metadata, lastModified: at } };
			});
			await page.evaluate(
				async ({ sessions, syncUrl }) => {
					const db = await new Promise<IDBDatabase>((resolve, reject) => {
						const req = indexedDB.open("sitegeist-storage");
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(req.error);
					});
					await new Promise<void>((resolve, reject) => {
						const tx = db.transaction(["sessions", "sessions-metadata", "settings"], "readwrite");
						for (const s of sessions) {
							tx.objectStore("sessions").put(s.data);
							tx.objectStore("sessions-metadata").put(s.metadata);
						}
						tx.objectStore("settings").put(syncUrl, "sync.url");
						tx.objectStore("settings").put("test-token", "sync.token");
						tx.oncomplete = () => resolve();
						tx.onerror = () => reject(tx.error);
					});
					db.close();
				},
				{ sessions, syncUrl: `${relay.base}/sitegeist` },
			);
			await page.goto(`${panelUrl}?session=${first.id}`); // an R730 chat: no first-run provider dialog
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
			await until(
				() => rowTitles(page),
				(t) => t.length === CHATS.length,
				15_000,
				"all chats listed",
			);

			// 1. a dropdown, no chips; nothing in the list runs off the side
			const layout = await page.evaluate(() => {
				const sidebar = document.querySelector("sessions-sidebar");
				const filter = sidebar?.querySelector(".sg-agent-filter");
				const trigger = filter?.querySelector("button");
				const s = sidebar?.firstElementChild?.getBoundingClientRect();
				const t = trigger?.getBoundingClientRect();
				return {
					trigger: trigger?.textContent?.replace(/\s+/g, " ").trim() ?? null,
					buttonsInFilter: filter?.querySelectorAll("button").length ?? 0,
					insideSidebar: !!(s && t && t.left >= s.left && t.right <= s.right),
					overflow: filter ? filter.scrollWidth - filter.clientWidth : -1,
				};
			});
			assert.equal(layout.trigger, "All agents");
			assert.equal(layout.buttonsInFilter, 1, "one dropdown button, not a chip per agent");
			assert.ok(layout.insideSidebar, "the dropdown sits inside the sidebar");
			assert.ok(layout.overflow <= 0, `no sideways overflow (${layout.overflow}px)`);

			// 2. open it: every agent is listed; pick sedcoach -> only sedcoach's chat
			await page.click("sessions-sidebar .sg-agent-filter button");
			const options = await until(
				() =>
					page.evaluate(() =>
						Array.from(
							document.querySelectorAll(
								".select-portal-container [role=option], .select-portal-container button, .select-portal-container div.relative",
							),
						)
							.map((e) => e.textContent?.trim() ?? "")
							.filter(Boolean),
					),
				(o) => o.length >= 2,
				5_000,
				"dropdown options",
			);
			for (const want of ["All agents", "main-pi", ...AGENTS])
				assert.ok(options.includes(want), `option ${want} in ${JSON.stringify(options)}`);
			await page.screenshot({ path: join(out, "sessions-agent-dropdown.png") });
			await page.locator(".select-portal-container").getByText("sedcoach", { exact: true }).click();
			await until(
				() => rowTitles(page),
				(t) => t.length === 1,
				5_000,
				"filtered to one chat",
			);
			assert.deepEqual(await rowTitles(page), ["sedcoach chat number 0"]);
			assert.equal(
				await page
					.textContent("sessions-sidebar .sg-agent-filter button")
					.then((t) => t?.replace(/\s+/g, " ").trim()),
				"sedcoach",
			);
			await page.screenshot({ path: join(out, "sessions-agent-filtered.png") });
		} finally {
			await context.close();
			relay.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
