/**
 * A running command is visible while it runs (Tom, 2026-11-15: "why can't I see the cell?" … "How long has it already
 * been running - has it returned anything yet? Any logs? What are those logs?"). Real extension in Chromium against
 * the stand-in relay (tests/prime-relay.fixture.ts): the model finishes writing a Python call, the tool starts, and from
 * then on the chat shows a card at the call's place: what runs, for how long, "no output yet", then the line count, the
 * last lines (following live), when it last printed, amber once quiet; Show all output / Show command; one line above
 * the prompt box (above the queue shelf) that jumps to the card. A reload mid-run keeps what the relay knows, and says
 * what it does not ("output before HH:MM not shown"). When the call finishes the usual tool block returns, with
 * "took 2m 05s". The call is drawn exactly once at every stage. Screenshots in tests/.out/running-*.png.
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
const SID = "sg-6f6f6f6f6f6f";
const seeded = seededPrimeSession(SID, "COTI trace");
const CALL = "toolu_running_0001";
const CODE = "for page in range(40):\n    rows = fetch_transfers(page)\n    for r in rows:\n        print(r)\n";
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

/** Everything the test checks, read in one go. */
function look(page: Page, id: string) {
	return page.evaluate((callId) => {
		const card = document.querySelector<HTMLElement>(`.sg-running-tool[data-call-id="${callId}"]`);
		const status = document.querySelector<HTMLElement>(".sg-run-status");
		const toolMessages = Array.from(document.querySelectorAll("tool-message")).filter(
			(t) =>
				// the patched ToolMessage keeps its toolCall as a property
				Reflect.get(t, "toolCall")?.id === callId,
		);
		const shelf = document.querySelector("sg-queue-shelf");
		return {
			card: card !== null,
			cards: document.querySelectorAll(`.sg-running-tool[data-call-id="${callId}"]`).length,
			toolMessages: toolMessages.length,
			title: card?.querySelector(".sg-run-title")?.textContent?.trim() ?? "",
			elapsed: card?.querySelector(".sg-run-elapsed")?.textContent?.trim() ?? "",
			facts: card?.querySelector(".sg-run-facts")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			note: card?.querySelector(".sg-run-note")?.textContent?.trim() ?? "",
			tail: card?.querySelector(".sg-run-tail")?.textContent ?? "",
			all: card?.querySelector(".sg-run-all")?.textContent ?? "",
			command: card?.querySelector(".sg-run-command")?.textContent ?? "",
			quiet: card?.dataset.quiet === "true",
			status: status?.textContent?.replace(/\s+/g, " ").trim() ?? "",
			statusQuiet: status?.dataset.quiet === "true",
			statusAboveShelf: status !== null && shelf !== null && status.parentElement?.nextElementSibling === shelf,
			took: document.querySelector(".sg-took")?.textContent?.trim() ?? "",
		};
	}, id);
}

test(
	"a running command: live card at its place, status line, reload mid-run, then the tool block with took",
	{ timeout: 240_000 },
	async () => {
		const relay = await startStandInRelay(SID, seeded.messages);
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-running-"));
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

			// 1. The model has written the call (message_end); the tool starts. The card is there at once.
			relay.startTurn();
			const startedAt = Date.now();
			const assistant = {
				role: "assistant",
				content: [{ type: "toolCall", id: CALL, name: "ipython", arguments: { code: CODE } }],
				...meta,
				timestamp: startedAt - 2000,
			};
			relay.pushEvents([
				{ type: "message_start", message: assistant },
				{ type: "message_end", message: assistant },
				{ type: "tool_execution_start", toolCallId: CALL, toolName: "ipython", args: { code: CODE } },
			]);
			let v = await until(
				() => look(page, CALL),
				(x) => x.card,
				3_000,
				"card shown",
			);
			assert.match(v.facts, /no output yet/);
			assert.equal(v.cards, 1, "drawn once");
			assert.equal(v.toolMessages, 1, "one tool message for the call");
			assert.match(v.status, /^Python · for page in range\(40\)/);
			assert.match(v.status, /no output yet/);

			// 2. Output arrives (the relay's live push); the card follows, the timer runs.
			const lines = Array.from(
				{ length: 12 },
				(_, i) => `IN 2026-09-1${i % 10} COTI ${(1000 + i * 37.5).toFixed(4)} from 0x${(i * 7919).toString(16)}`,
			);
			relay.pushRunning({
				now: Date.now(),
				running: [
					{
						toolCallId: CALL,
						toolName: "ipython",
						startedAt,
						seenFrom: startedAt,
						lastOutputAt: Date.now(),
						lines: 12,
						tail: lines.join("\n"),
						truncated: false,
						missedOutput: false,
					},
				],
				finished: {},
			});
			v = await until(
				() => look(page, CALL),
				(x) => x.facts.includes("12 lines"),
				3_000,
				"line count",
			);
			assert.equal(v.tail.trim().split("\n").length, 6, "the last 6 lines");
			assert.ok(v.tail.includes(lines[11] ?? "?"), "the newest line is shown");
			assert.match(v.facts, /started \d/);
			assert.match(v.facts, /last output \d+s ago/);
			const e1 = v.elapsed;
			await new Promise((r) => setTimeout(r, 1500));
			v = await look(page, CALL);
			assert.notEqual(v.elapsed, e1, `the timer moves (${e1} -> ${v.elapsed})`);
			assert.match(v.status, /12 lines/);

			// a queued message: the status line sits above the queue shelf
			await page.fill("message-editor textarea", "When it is done, summarise the senders.");
			await page.keyboard.press("Alt+Enter");
			v = await until(
				() => look(page, CALL),
				(x) => x.statusAboveShelf,
				10_000,
				"status line above the shelf",
			);
			await page.screenshot({ path: join(out, "running-card.png") });

			// 3. Show all output / Show command.
			relay.runningOutput.set(CALL, Array.from({ length: 50 }, (_, i) => `full line ${i + 1}`).join("\n"));
			await page.click(`.sg-running-tool[data-call-id="${CALL}"] .sg-run-show-all`);
			v = await until(
				() => look(page, CALL),
				(x) => x.all.includes("full line 50"),
				5_000,
				"all output",
			);
			await page.click(`.sg-running-tool[data-call-id="${CALL}"] .sg-run-show-command`);
			v = await until(
				() => look(page, CALL),
				(x) => x.command.includes("fetch_transfers"),
				3_000,
				"command",
			);
			await page.click(`.sg-running-tool[data-call-id="${CALL}"] .sg-run-show-all`);
			await page.click(`.sg-running-tool[data-call-id="${CALL}"] .sg-run-show-command`);

			// 4. Quiet: no output for a while -> amber, on the card and the status line.
			relay.pushRunning({
				now: Date.now(),
				running: [
					{
						toolCallId: CALL,
						toolName: "ipython",
						startedAt,
						seenFrom: startedAt,
						lastOutputAt: Date.now() - 10_000,
						lines: 12,
						tail: lines.join("\n"),
						truncated: false,
						missedOutput: false,
					},
				],
				finished: {},
			});
			v = await until(
				() => look(page, CALL),
				(x) => x.quiet && x.statusQuiet,
				3_000,
				"quiet",
			);
			assert.match(v.facts, /quiet for 1\ds/);
			await page.emulateMedia({ colorScheme: "dark" });
			await page.evaluate(() => document.documentElement.classList.add("dark"));
			await new Promise((r) => setTimeout(r, 500));
			await page.screenshot({ path: join(out, "running-quiet-dark.png") });
			await page.evaluate(() => document.documentElement.classList.remove("dark"));
			await page.emulateMedia({ colorScheme: "light" });

			// 5. The status line jumps to the card.
			await page.evaluate(() => {
				const scroller = document.querySelector("agent-interface .overflow-y-auto");
				if (scroller) scroller.scrollTop = 0;
			});
			await page.click(".sg-run-status");
			await until(
				() =>
					page.evaluate((id) => {
						const r = document.querySelector(`.sg-running-tool[data-call-id="${id}"]`)?.getBoundingClientRect();
						return r !== undefined && r.top >= 0 && r.bottom <= window.innerHeight;
					}, CALL),
				(x) => x,
				3_000,
				"card scrolled into view",
			);

			// 6. Reload mid-run, after a relay restart: the relay did not see the start; it says so.
			const seenFrom = Date.now() - 60_000;
			relay.runs = {
				now: Date.now(),
				running: [
					{
						toolCallId: CALL,
						toolName: "ipython",
						startedAt: null,
						seenFrom,
						lastOutputAt: Date.now(),
						lines: 40,
						tail: lines.join("\n"),
						truncated: false,
						missedOutput: true,
					},
				],
				toolDurations: {},
			};
			await open();
			v = await until(
				() => look(page, CALL),
				(x) => x.card && x.facts.includes("40 lines"),
				10_000,
				"card after reload",
			);
			assert.match(v.facts, /running since about \d/);
			assert.match(v.note, /^output before \d\d:\d\d not shown$/);
			assert.equal(v.cards, 1);
			assert.equal(v.toolMessages, 1);
			await page.screenshot({ path: join(out, "running-after-reload.png") });

			// 7. It finishes: the usual block returns, with how long it took; the status line goes.
			relay.runs = undefined;
			relay.pushRunning({ now: Date.now(), running: [], finished: { [CALL]: 125_000 } });
			relay.pushEvents([
				{
					type: "tool_execution_end",
					toolCallId: CALL,
					toolName: "ipython",
					isError: false,
					result: { content: [] },
				},
				{
					type: "message_end",
					message: {
						role: "toolResult",
						toolCallId: CALL,
						toolName: "ipython",
						content: [{ type: "text", text: lines.join("\n") }],
						isError: false,
						timestamp: Date.now(),
					},
				},
			]);
			v = await until(
				() => look(page, CALL),
				(x) => !x.card && x.took !== "",
				5_000,
				"finished",
			);
			assert.equal(v.took, "took 2m 05s");
			assert.equal(v.status, "", "status line gone");
			assert.equal(v.toolMessages, 1, "still drawn once");
			await page.screenshot({ path: join(out, "running-finished.png") });
			relay.endTurn();
		} finally {
			await context.close();
			relay.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
