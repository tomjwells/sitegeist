/**
 * Sends on a bad connection (Tom, 2026-10-18, on a train): a message the R730 did not get is shown as "not sent" with
 * Retry and Discard, goes out by itself when the live connection is back, and is never prompted twice - the retry
 * repeats the send's clientMessageId and the relay answers duplicate:true. The status light tells the truth
 * (connected / lost / retrying). A failed message survives a panel reload, and a chat opened while offline keeps
 * trying. Real extension in Chromium against the stand-in relay (tests/prime-relay.fixture.ts), which can go
 * offline, lose a prompt's answer, and echoes accepted prompts like the bridge.
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
const SID = "sg-0f0f0f0f0f0f";
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
				tx.objectStore("settings").put("test-token", "sync.token");
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		},
		{ session: { data: seeded.data, metadata: seeded.metadata }, syncUrl },
	);
}

/** What the chat shows: user bubbles with their send state, the unsent pill, the light's tooltip. */
interface View {
	bubbles: Array<{ text: string; state: string }>;
	unsentPill: string;
	light: string;
	composer: string;
	streaming: boolean;
}

function view(page: Page): Promise<View> {
	return page.evaluate(() => ({
		bubbles: Array.from(document.querySelectorAll("sitegeist-user-message")).map((el) => ({
			text: el.querySelector(".user-message-container")?.textContent?.trim().slice(0, 40) ?? "",
			state: el.querySelector("[data-send-state]")?.getAttribute("data-send-state") ?? "sent",
		})),
		unsentPill: document.querySelector(".sg-unsent-count")?.textContent?.trim() ?? "",
		light: document.querySelector(".sg-live-dot")?.getAttribute("title") ?? "",
		composer: (document.querySelector("message-editor textarea") as HTMLTextAreaElement | null)?.value ?? "",
		streaming: Array.from(document.querySelectorAll("message-editor button")).some(
			(b) => b.getAttribute("title")?.toLowerCase().includes("stop") ?? false,
		),
	}));
}

async function send(page: Page, text: string): Promise<void> {
	await page.fill("message-editor textarea", text);
	await page.keyboard.press("Enter");
}

const states = (v: View) => v.bubbles.map((b) => b.state).join(",");

test(
	"a message that does not land is shown as not sent, retried without duplicates, and the light is honest",
	{ timeout: 240_000 },
	async () => {
		const relay = await startStandInRelay(SID, seeded.messages);
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-send-retry-"));
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

			const page = await context.newPage();
			await page.goto(`${panelUrl}?new=true`);
			await dismissPermissionDialog(page);
			await page.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
			await seedPanelStorage(page, `${relay.base}/sitegeist`);
			await page.goto(`${panelUrl}?session=${SID}`);
			await dismissPermissionDialog(page);
			await until(
				() => page.evaluate(() => document.body.innerText),
				(t) => t.includes("ask away"),
				30_000,
				"chat",
			);

			// 1. Connected: the light says so in words, not as a poll.
			await until(
				() => view(page),
				(v) => v.light.includes("connected (live events"),
				15_000,
				"connected light",
			);
			assert.equal(relay.openSockets(), 1);

			// 2. The train enters a tunnel: the connection dies. The light goes to "lost ... retrying".
			relay.offline = true;
			relay.dropSockets();
			await until(
				() => view(page),
				(v) => /Live connection to the R730: lost/.test(v.light) && /retrying in \d+ s/.test(v.light),
				15_000,
				"lost light",
			);

			// 3. Two messages sent in the tunnel: shown at once, marked not sent, Retry/Discard offered, counted in the header.
			await send(page, "Can you add a Sources page?");
			await until(
				() => view(page),
				(v) => states(v) === "sent,failed",
				20_000,
				"first message failed",
			);
			let v = await view(page);
			assert.equal(relay.prompts.length, 0, "nothing reached the relay");
			assert.equal(v.unsentPill, "1 unsent");
			assert.equal(v.composer, "", "the composer is cleared; the message lives in the chat");
			assert.equal(v.streaming, false, "a failed send does not leave the chat 'running'");
			assert.match(v.light, /1 message not sent yet/);
			assert.ok(
				await page.evaluate(() => {
					const bar = document.querySelector('[data-send-state="failed"]');
					const labels = Array.from(bar?.querySelectorAll("button") ?? []).map((b) => b.textContent?.trim());
					return (
						bar?.textContent?.includes("Not sent (no connection)") && labels.join("|") === "Retry now|Discard"
					);
				}),
				"the bubble says why and offers Retry now / Discard",
			);
			await send(page, "And a Settings page.");
			await until(
				() => view(page),
				(v) => states(v) === "sent,failed,failed",
				20_000,
				"second message failed",
			);
			assert.equal((await view(page)).unsentPill, "2 unsent");

			// 4. Out of the tunnel: the socket comes back and both go out by themselves, in order, once each.
			relay.offline = false;
			await page.evaluate(() => window.dispatchEvent(new Event("online")));
			await until(
				() => view(page),
				(v) => states(v) === "sent,sent,sent" && v.unsentPill === "",
				30_000,
				"both sent after reconnect",
			);
			assert.deepEqual(
				relay.prompts.map((p) => String(p.message).split("\n\n").pop()),
				["Can you add a Sources page?", "And a Settings page."],
			);
			const ids = relay.prompts.map((p) => p.clientMessageId);
			assert.ok(
				ids.every((id) => typeof id === "string" && id.length >= 8) && new Set(ids).size === 2,
				`send ids: ${ids.join(",")}`,
			);
			assert.equal(relay.repeats, 0);
			v = await view(page);
			assert.equal(v.bubbles.length, 3, "the bridge's echo replaced the bubbles, it did not add to them");
			assert.match(v.light, /connected/);

			// 5. The prompt lands but its answer is lost: the panel thinks it failed. Retry now = the same id ->
			//    duplicate:true, no second prompt, the bubble becomes sent, and no extra bubble appears.
			relay.swallowPrompt = true;
			await send(page, "Third: a Help page.");
			await until(
				() => view(page),
				(v) => states(v) === "sent,sent,sent,failed",
				30_000,
				"third looks failed",
			);
			assert.equal(relay.prompts.length, 3, "the relay did accept it");
			relay.swallowPrompt = false;
			await page.click('[data-send-state="failed"] button:has-text("Retry now")');
			await until(
				() => view(page),
				(v) => states(v) === "sent,sent,sent,sent",
				20_000,
				"retry resolved as already sent",
			);
			assert.equal(relay.prompts.length, 3, "no second prompt");
			assert.equal(relay.repeats, 1, "the retry was recognised as a repeat");
			v = await view(page);
			assert.equal(v.streaming, false, "a repeat of a finished prompt does not leave the chat 'running'");
			relay.flushEchoes();
			await new Promise((r) => setTimeout(r, 800));
			v = await view(page);
			assert.equal(v.bubbles.length, 4, "the late echo replaced the bubble, it did not add one");
			assert.equal(v.bubbles[3]?.text, "Third: a Help page.");

			// 6. Discard: a message sent in a tunnel can be dropped instead of retried.
			relay.offline = true;
			relay.dropSockets();
			await until(
				() => view(page),
				(v) => /lost/.test(v.light),
				15_000,
				"lost again",
			);
			await send(page, "Fourth: never mind.");
			await until(
				() => view(page),
				(v) => states(v) === "sent,sent,sent,sent,failed",
				20_000,
				"fourth failed",
			);
			await page.click('[data-send-state="failed"] button:has-text("Discard")');
			await until(
				() => view(page),
				(v) => states(v) === "sent,sent,sent,sent" && v.unsentPill === "",
				10_000,
				"discarded",
			);

			// 7. A failed message survives a reload, and a chat opened while offline keeps trying; once the connection is
			//    back the message goes out and the chat loads.
			await send(page, "Fifth: an About page.");
			await until(
				() => view(page),
				(v) => states(v) === "sent,sent,sent,sent,failed",
				20_000,
				"fifth failed",
			);
			await page.goto(`${panelUrl}?session=${SID}`);
			await dismissPermissionDialog(page);
			await until(
				() => view(page),
				(v) => states(v) === "sent,sent,sent,sent,failed",
				30_000,
				"fifth still there after reload",
			);
			await until(
				() => view(page),
				(v) => /Live connection to the R730: error .*retrying in \d+ s/.test(v.light),
				15_000,
				"offline open keeps trying",
			);
			assert.equal(relay.prompts.length, 3);
			relay.offline = false;
			await page.evaluate(() => window.dispatchEvent(new Event("online")));
			await until(
				() => view(page),
				(v) => states(v) === "sent,sent,sent,sent,sent" && /connected/.test(v.light),
				45_000,
				"fifth sent, chat connected",
			);
			assert.equal(relay.prompts.length, 4);
			assert.equal(relay.repeats, 1);
			assert.equal(String(relay.prompts[3]?.message).split("\n\n").pop(), "Fifth: an About page.");
		} finally {
			await context.close();
			relay.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
