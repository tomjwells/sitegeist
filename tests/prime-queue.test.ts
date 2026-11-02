/**
 * Two ways to send while the agent works (Tom, 2026-10-25: "I want two send buttons. One to steer and one to
 * follow-up/send a queued prompt"): Enter or the steer button goes in mid-turn, as before; Alt+Enter or the queue
 * button puts the message in the RELAY's queue (in front of prime, like the Telegram router's own queue), which sends
 * it as a plain prompt when the session is idle. While it waits it shows "Queued" at the bottom of the chat with Edit
 * and Cancel, survives a panel reload (the relay's list is the truth), runs in order, and is never sent twice. A
 * queued message the relay no longer lists is shown as not sent and waits for a click. Real extension in Chromium
 * against the stand-in relay (tests/prime-relay.fixture.ts), which keeps the queue the way the relay does.
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
	"mid-turn: Enter steers; Alt+Enter / the queue button queues, with Edit and Cancel",
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
			const bubbleAction = (state: string, label: string) =>
				page.click(`[data-send-state="${state}"] button:has-text("${label}")`);
			const composer = () =>
				page.evaluate(
					() => (document.querySelector("message-editor textarea") as HTMLTextAreaElement | null)?.value ?? "",
				);
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

			// 2. The queue button: the relay queues it; the bubble says "Queued", offers Edit and Cancel, sits at the bottom.
			await page.click("message-editor .sg-queue-send");
			await until(
				() => Promise.resolve(relay.queued()),
				(q) => q.join("|") === "Also check the Sources page.",
				20_000,
				"queued on the relay",
			);
			assert.equal(relay.prompts.length, 0, "nothing reached prime");
			v = await until(
				() => view(page),
				(x) => userBubbles(x).join("|") === "Also check the Sources page. [queued]",
				15_000,
				"queued bubble",
			);
			assert.ok(
				await page.evaluate(() => {
					const bar = document.querySelector('[data-send-state="queued"]');
					const labels = Array.from(bar?.querySelectorAll("button") ?? []).map((b) => b.textContent?.trim());
					return (
						bar?.textContent?.includes("Queued: runs when the agent is free.") &&
						labels.join("|") === "Edit|Cancel"
					);
				}),
				"the bubble says it is queued and offers Edit / Cancel",
			);
			assert.equal(v.unsentPill, "", "a queued message is not unsent");

			// 3. Enter steers, as before: it goes in mid-turn, above the queued one.
			await page.fill("message-editor textarea", "Use the red one.");
			await page.keyboard.press("Enter");
			await until(
				() => view(page),
				(x) => userBubbles(x).join("|") === "Use the red one. [sent]|Also check the Sources page. [queued]",
				20_000,
				"steer above the queued message",
			);
			assert.equal(relay.prompts[0]?.streamingBehavior, "steer");

			// 4. Alt+Enter queues too, after the first queued one.
			await page.fill("message-editor textarea", "Then the Settings page.");
			await page.keyboard.press("Alt+Enter");
			await until(
				() => Promise.resolve(relay.queued().length),
				(n) => n === 2,
				20_000,
				"second queued",
			);
			await until(
				() => view(page),
				(x) =>
					userBubbles(x).join("|") ===
					"Use the red one. [sent]|Also check the Sources page. [queued]|Then the Settings page. [queued]",
				15_000,
				"two queued, in order",
			);

			// 5. Cancel the second: gone from the relay and from the chat.
			await page.click('sitegeist-user-message:last-of-type [data-send-state="queued"] button:has-text("Cancel")');
			await until(
				() => Promise.resolve(relay.queued()),
				(q) => q.join("|") === "Also check the Sources page.",
				15_000,
				"cancelled on the relay",
			);
			await until(
				() => view(page),
				(x) => userBubbles(x).join("|") === "Use the red one. [sent]|Also check the Sources page. [queued]",
				15_000,
				"cancelled bubble gone",
			);

			// 6. Edit the first: out of the queue, its text back in the composer; queue it again, changed.
			await bubbleAction("queued", "Edit");
			await until(
				() => Promise.resolve(relay.queued().length),
				(n) => n === 0,
				15_000,
				"edited item out of the queue",
			);
			await until(
				() => composer(),
				(t) => t === "Also check the Sources page.",
				15_000,
				"text back in the composer",
			);
			await until(
				() => view(page),
				(x) => userBubbles(x).join("|") === "Use the red one. [sent]",
				15_000,
				"its bubble gone",
			);
			await page.fill("message-editor textarea", "Also check the Sources AND Help pages.");
			await page.keyboard.press("Alt+Enter");
			await until(
				() => Promise.resolve(relay.queued()),
				(q) => q.join("|") === "Also check the Sources AND Help pages.",
				20_000,
				"re-queued",
			);

			// 7. Another browser queues one more (straight into the relay); after a reload both show, in the relay's order.
			const other = await fetch(`${relay.base}/sitegeist/agents/prime/sessions/${SID}/queue`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					clientMessageId: "other-browser-0001",
					text: "From the laptop.",
					message: "From the laptop.",
				}),
			});
			assert.equal(other.status, 200);
			await open();
			await until(
				() => view(page),
				(x) =>
					userBubbles(x).join("|") ===
					"Use the red one. [sent]|Also check the Sources AND Help pages. [queued]|From the laptop. [queued]",
				20_000,
				"queued after a reload, incl. the other browser's",
			);

			// 8. The turn ends: the relay sends each queued message in order; nothing is sent twice.
			relay.endTurn();
			v = await until(
				() => view(page),
				(x) =>
					userBubbles(x).join("|") ===
						"Use the red one. [sent]|Also check the Sources AND Help pages. [sent]|From the laptop. [sent]" &&
					x.answers.some((a) => a.includes("Answer: From the laptop.")),
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
			assert.ok(at("Done working.") < at("Also check the Sources AND"), JSON.stringify(order));
			assert.ok(at("Also check the Sources AND") < at("Answer: Also check"), JSON.stringify(order));
			assert.ok(at("Answer: Also check") < at("From the laptop."), JSON.stringify(order));
			assert.equal(relay.prompts.length, 3, "one steer + two queued");
			assert.equal(relay.repeats, 0);
			assert.equal(relay.queued().length, 0);

			// 9. The relay loses a queued message. After a reload the bubble says it is no longer queued and waits for a
			//    click (it might have been cancelled from another panel), then Retry queues it again - the session is idle,
			//    so it runs at once.
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
				() => view(page),
				(x) => x.bubbles.at(-1) === "One more thing. [failed]",
				20_000,
				"held as not sent",
			);
			assert.ok(
				await page.evaluate(() =>
					document.querySelector('[data-send-state="failed"]')?.textContent?.includes("it is no longer queued"),
				),
			);
			await new Promise((r) => setTimeout(r, 2500));
			assert.equal(relay.prompts.length, 3, "not sent by itself");
			await bubbleAction("failed", "Retry now");
			await until(
				() => view(page),
				(x) => x.bubbles.at(-1) === "One more thing. [sent]",
				20_000,
				"retried and run",
			);
			assert.equal(relay.prompts.length, 4);
			assert.notEqual(relay.prompts[3]?.clientMessageId, undefined);
		} finally {
			await context.close();
			relay.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
