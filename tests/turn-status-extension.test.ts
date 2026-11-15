/**
 * The status line says what a turn waits on, and a turn cut by a restart never looks busy (Tom, 2026-11-15: "both
 * these sessions seem stopped and I cant tell what it's waiting on"). Stand-in relay (tests/prime-relay.fixture.ts):
 * a running turn with no command shows its phase; the relay's turn_status "cut" (with its synthetic agent_end) ends
 * the running look and says so; the relay's resume prompt is one muted line; and a panel that looks busy while
 * nothing happens asks the relay after 45 s and reads the chat again.
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
const SID = "sg-7a7a7a7a7a7a";
const seeded = seededPrimeSession(SID, "Wallet scan");
const meta = {
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-haiku-4-5",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
};

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (ok(last)) return last;
		} catch {
			/* page busy */
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out: ${what} (last: ${JSON.stringify(last)})`);
}

async function dismissPermissionDialog(page: Page): Promise<void> {
	await page.waitForFunction(
		() => document.querySelector("userscripts-permission-dialog, sessions-sidebar, [data-boot-error]") !== null,
		undefined,
		{ timeout: 30_000 },
	);
	await page.evaluate(() =>
		document.querySelector("userscripts-permission-dialog")?.dispatchEvent(new Event("close")),
	);
}

test(
	"a turn says what it waits on; a cut turn says so and stops looking busy; a stale busy look repairs itself",
	{ timeout: 240_000 },
	async () => {
		const relay = await startStandInRelay(SID, seeded.messages);
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-turn-"));
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
			const open = async () => {
				await page.goto(`${panelUrl}?session=${SID}`);
				await until(
					async () => {
						await dismissPermissionDialog(page);
						return relay.openSockets();
					},
					(n) => n >= 1,
					30_000,
					"chat open with a live connection",
				);
				await page.evaluate(() => {
					// "quiet" after 3 s instead of 2 minutes
					Reflect.set(globalThis, "__sgRunQuietMs", 3000);
				});
			};
			await open();
			const line = () =>
				page.evaluate(() => {
					const l = document.querySelector<HTMLElement>(".sg-turn-line");
					return {
						text: l?.textContent?.replace(/\s+/g, " ").trim() ?? "",
						kind: l?.dataset.kind ?? "",
						placeholder: document.querySelector("message-editor textarea")?.getAttribute("placeholder") ?? "",
						resumeLines: Array.from(document.querySelectorAll(".sg-auto-resume")).map(
							(e) => e.textContent?.replace(/\s+/g, " ").trim() ?? "",
						),
						bubbles: Array.from(document.querySelectorAll("user-message"))
							.map((e) => e.textContent ?? "")
							.join("|"),
					};
				});
			// 1. A running turn with no command: the line says what it waits on.
			relay.startTurn();
			let v = await until(line, (x) => x.text.startsWith("Waiting for the model ·"), 5_000, "waiting line");
			relay.pushEvents([
				{
					type: "message_update",
					message: { role: "assistant", content: [] },
					assistantMessageEvent: { type: "thinking_delta", delta: "hm" },
				},
			]);
			v = await until(line, (x) => x.text.startsWith("Thinking ·"), 5_000, "thinking line");
			await page.screenshot({ path: join(out, "turn-thinking.png") });
			// 2. Silent for a while: "no activity for …" (and amber once quiet: 3 s in this test)
			v = await until(line, (x) => x.text.includes("no activity for"), 30_000, "silence shown");

			// 3. The relay says the turn was cut by a restart and not resumed (with its synthetic agent_end).
			relay.setBusy(false);
			const cut = {
				state: "cut",
				at: Date.now(),
				cutAt: Date.now(),
				note: "Cut by a restart at 15:37 UTC. Nothing is running. Send a message to continue.",
			};
			relay.turn = cut;
			relay.pushFrame({
				type: "events",
				events: [{ type: "agent_end", synthetic: true, reason: "cut", messages: [] }],
			});
			relay.pushFrame({ type: "turn_status", ...cut });
			v = await until(line, (x) => x.kind === "cut", 5_000, "cut note");
			assert.equal(v.text, cut.note);
			assert.ok(!/steers now/i.test(v.placeholder), `not busy any more: ${v.placeholder}`);
			await page.screenshot({ path: join(out, "turn-cut.png") });

			// 4. The relay's resume prompt is one muted line, never a bubble; the resumed turn then runs as usual.
			relay.startTurn();
			const resume = {
				role: "user",
				content: [
					{
						type: "text",
						text: "[sitegeist auto-resume — this is not a message from Tom]\nYour turn on this request was cut at about 15:37 UTC: the agent process was restarted.",
					},
				],
				timestamp: Date.now(),
			};
			relay.pushEvents([
				{ type: "message_start", message: resume },
				{ type: "message_end", message: resume },
			]);
			relay.pushFrame({
				type: "turn_status",
				state: "cut_resumed",
				at: Date.now(),
				cutAt: Date.parse("2026-11-15T15:37:00Z"),
				resumedAt: Date.now(),
				note: "Cut by a restart at 15:37 UTC · resumed automatically",
			});
			v = await until(
				line,
				(x) => x.resumeLines.length === 1 && x.text.includes("resumed after a restart at 15:37 UTC"),
				5_000,
				"resume line and note",
			);
			assert.equal(v.resumeLines[0], "Turn cut by a restart at 15:37 UTC · resumed automatically");
			assert.ok(!v.bubbles.includes("sitegeist auto-resume"), "no bubble for the resume prompt");
			await page.screenshot({ path: join(out, "turn-resumed.png") });
			relay.endTurn();
			await until(line, (x) => x.text === "", 5_000, "line gone after the turn");

			// 5. Busy look with nothing behind it (an end that never arrived): after 45 s silent, the panel asks the relay
			//    and reads the chat again.
			relay.setBusy(true);
			relay.turn = undefined;
			await open(); // the hydrate says busy
			v = await until(line, (x) => x.text.startsWith("Waiting for the model"), 10_000, "busy after reopen");
			relay.setBusy(false); // the turn died; no event will come
			const hydratesBefore = relay.hydrateQueries.length;
			await until(
				() => Promise.resolve(relay.turnRequests),
				(n) => n >= 1,
				90_000,
				"self-check asked the relay",
			);
			await until(
				() => Promise.resolve(relay.hydrateQueries.length),
				(n) => n > hydratesBefore,
				15_000,
				"chat read again",
			);
			v = await until(line, (x) => x.text === "" && !/steers now/i.test(x.placeholder), 10_000, "not busy any more");
		} finally {
			await context.close();
			relay.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
