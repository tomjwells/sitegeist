/**
 * Two ways to send while the agent works (Tom, 2026-10-25: "I want two send buttons. One to steer and one to
 * follow-up/send a queued prompt"): Enter or the steer button goes in mid-turn, as before; Alt+Enter or the queue
 * button waits in the R730's queue and runs when the turn ends. A queued message shows "Queued" at the bottom of the
 * chat until it runs, survives a panel reload, runs in order, and is never sent twice. If the agent loses its queue
 * (restart), the panel sends it again when it next connects. Real extension in Chromium against the stand-in relay
 * (tests/prime-relay.fixture.ts), which keeps a follow-up queue the way prime does.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { seededPrimeSession, startStandInRelay } from "./prime-relay.fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const SID = "sg-4d4d4d4d4d4d";
const seeded = seededPrimeSession(SID, "Lead page work");

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

/** What the chat shows: user bubbles (text, send state), assistant texts, the editor's mid-turn controls. */
interface View {
	bubbles: string[];
	answers: string[];
	queueButton: boolean;
	steerButton: boolean;
	placeholder: string;
	unsentPill: string;
}

function view(page: Page): Promise<View> {
	return page.evaluate(() => ({
		bubbles: Array.from(document.querySelectorAll("sitegeist-user-message")).map((el) => {
			const text = el.querySelector(".user-message-container")?.textContent?.trim().slice(0, 40) ?? "";
			const state = el.querySelector("[data-send-state]")?.getAttribute("data-send-state") ?? "sent";
			return `${text} [${state}]`;
		}),
		answers: Array.from(document.querySelectorAll("assistant-message")).map(
			(el) => el.textContent?.trim().slice(0, 40) ?? "",
		),
		queueButton: document.querySelector("message-editor .sg-queue-send") !== null,
		steerButton: document.querySelector("message-editor .sg-steer-send") !== null,
		placeholder: document.querySelector("message-editor textarea")?.getAttribute("placeholder") ?? "",
		unsentPill: document.querySelector(".sg-unsent-count")?.textContent?.trim() ?? "",
	}));
}

const userBubbles = (v: View) => v.bubbles.slice(1); // the seeded "Help me read this article." comes first

test(
	"mid-turn: Enter steers, Alt+Enter / the queue button queues for after the turn",
	{ timeout: 240_000 },
	async () => {
		const relay = await startStandInRelay(SID, seeded.messages);
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-queue-"));
		const context = await chromium.launchPersistentContext(userDataDir, {
			...(chromePath ? { executablePath: chromePath } : {}),
			headless: true,
			args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
		});
		try {
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
			};
			await open();

			// 1. The agent is working. Typing shows both sends; the placeholder says which key does what.
			relay.startTurn();
			await page.waitForSelector("message-editor textarea", { timeout: 15_000 });
			await page.fill("message-editor textarea", "Also check the Sources page.");
			let v = await until(
				() => view(page),
				(x) => x.queueButton && x.steerButton,
				15_000,
				"two send buttons",
			);
			assert.equal(v.placeholder, "Enter steers now · Alt+Enter queues it for after this turn");

			// 2. The queue button: the R730 queues it (followUp); the bubble says "Queued" and sits at the bottom.
			await page.click("message-editor .sg-queue-send");
			await until(
				() => Promise.resolve(relay.queued().length),
				(n) => n === 1,
				20_000,
				"queued on the R730",
			);
			assert.equal(relay.prompts[0]?.streamingBehavior, "followUp");
			v = await until(
				() => view(page),
				(x) => userBubbles(x).join("|") === "Also check the Sources page. [queued]",
				15_000,
				"queued bubble",
			);
			assert.ok(
				await page.evaluate(() =>
					document
						.querySelector('[data-send-state="queued"]')
						?.textContent?.includes("Queued: runs when the current turn ends."),
				),
			);
			assert.equal(v.unsentPill, "", "a queued message is not unsent");

			// 3. Enter steers, as before: it goes in mid-turn, above the queued one.
			await page.fill("message-editor textarea", "Use the red one.");
			await page.keyboard.press("Enter");
			v = await until(
				() => view(page),
				(x) => userBubbles(x).join("|") === "Use the red one. [sent]|Also check the Sources page. [queued]",
				20_000,
				"steer above the queued message",
			);
			assert.equal(relay.prompts[1]?.streamingBehavior, "steer");

			// 4. Alt+Enter queues too, after the first queued one.
			await page.fill("message-editor textarea", "Then the Settings page.");
			await page.keyboard.press("Alt+Enter");
			await until(
				() => Promise.resolve(relay.queued().length),
				(n) => n === 2,
				20_000,
				"second queued",
			);
			assert.equal(relay.prompts[2]?.streamingBehavior, "followUp");
			await until(
				() => view(page),
				(x) =>
					userBubbles(x).join("|") ===
					"Use the red one. [sent]|Also check the Sources page. [queued]|Then the Settings page. [queued]",
				15_000,
				"two queued, in order",
			);

			// 5. A reload while they wait: still queued, still at the bottom.
			await open();
			await until(
				() => view(page),
				(x) =>
					userBubbles(x).join("|") ===
					"Use the red one. [sent]|Also check the Sources page. [queued]|Then the Settings page. [queued]",
				20_000,
				"queued after a reload",
			);

			// 6. The turn ends: each queued message runs in order with its answer; nothing is sent twice.
			relay.endTurn();
			v = await until(
				() => view(page),
				(x) =>
					userBubbles(x).join("|") ===
						"Use the red one. [sent]|Also check the Sources page. [sent]|Then the Settings page. [sent]" &&
					x.answers.some((a) => a.includes("Answer: Then the Settings page.")),
				20_000,
				"queued messages ran",
			);
			const order = await page.evaluate(() =>
				Array.from(document.querySelectorAll("sitegeist-user-message, assistant-message")).map(
					(el) => el.textContent?.trim().slice(0, 30) ?? "",
				),
			);
			const at = (s: string) => order.findIndex((t) => t.startsWith(s));
			assert.ok(at("Use the red one.") < at("Done working."), JSON.stringify(order));
			assert.ok(at("Done working.") < at("Also check the Sources page."), JSON.stringify(order));
			assert.ok(at("Also check the Sources page.") < at("Answer: Also check"), JSON.stringify(order));
			assert.ok(at("Answer: Also check") < at("Then the Settings page."), JSON.stringify(order));
			assert.equal(relay.prompts.length, 3);
			assert.equal(relay.repeats, 0);

			// 7. The agent restarts with a message queued and loses it. After a reload the panel sees it neither queued nor
			//    run, and sends it again by itself (the turn is over, so it runs now) - with a new id, because the relay
			//    would answer a repeat of the old one with "already sent".
			relay.startTurn();
			await page.fill("message-editor textarea", "One more thing.");
			await page.keyboard.press("Alt+Enter");
			await until(
				() => Promise.resolve(relay.queued().length),
				(n) => n === 1,
				20_000,
				"queued again",
			);
			relay.dropQueue();
			relay.endTurn();
			await open();
			await until(
				() => Promise.resolve(relay.prompts.length),
				(n) => n === 5,
				20_000,
				"the lost message sent again",
			);
			assert.equal(relay.prompts[4]?.streamingBehavior, undefined, "idle: a plain prompt");
			assert.notEqual(relay.prompts[4]?.clientMessageId, relay.prompts[3]?.clientMessageId, "a new send id");
			await until(
				() => view(page),
				(x) =>
					x.bubbles.at(-1) === "One more thing. [sent]" &&
					x.bubbles.filter((b) => b.startsWith("One more")).length === 1,
				20_000,
				"one bubble, sent",
			);
		} finally {
			await context.close();
			relay.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
