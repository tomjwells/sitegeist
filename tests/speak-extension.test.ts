/**
 * Read aloud in the real extension (Tom, 2026-11-07): an R730 chat against the stand-in relay, plus a stand-in speak
 * server that answers like the real one (no CORS headers, OpenAI-style errors, real mp3 audio made with ffmpeg).
 * Checks: 🔊 on each answer (tooltip names Fish Audio); click -> spinner while chunk 1 renders -> playing, the audio's
 * currentTime advances; the next chunk is requested while the current one plays; all chunks play in order and the
 * requests are exactly chunkMarkdown(message) in order; replay comes from memory (no request); click while playing
 * stops; with speak returning 503 the button shows "speak is offline (M4 asleep?)" after one request (no retry);
 * Settings → Read aloud switches the buttons off. Player state comes from the panel's sitegeist_speak diagnostic over
 * the relay socket, the path main-pi uses in Tom's real browser. Screenshots of each button state in tests/.out/.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { chunkMarkdown } from "../src/speak/chunk.ts";
import { seededPrimeSession, startStandInRelay } from "./prime-relay.fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const out = join(root, "tests/.out");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const SID = "sg-5e5e5e5e5e5e";

const LONG = [
	"Here is the plan for the speak button. It reads an answer aloud with main-pi's voice, chunk by chunk, so it starts quickly.",
	"## What it does",
	"The panel splits the answer at block boundaries and sends each chunk to speak. The first chunk is short, so the first words arrive within seconds. Each later chunk renders while the one before it plays.",
	"- Click the speaker to play.\n- Click again to stop.\n- Only one answer plays at a time.\n  - Starting another stops the first.",
	"| State | Icon |\n| --- | --- |\n| idle | speaker |\n| rendering | spinner |\n| playing | stop square |",
	"```ts\nconst audio = new Audio();\n\naudio.play();\n```",
	"Audio for each answer stays in memory, so a replay is instant. If speak is offline, the button says so once and does not retry. The voice is the agent's own when speak has one by that name, otherwise main-pi.",
	"## Why the first chunk is short",
	"speak renders about two and a half times faster than real time. An eight hundred character chunk is close to a minute of speech and takes around twenty seconds to render, which is too long to wait for the first word. A short opening chunk renders in about five seconds instead.",
	"After that the chunks grow. Each one is longer than the one before, so the next chunk is always ready before the current one ends, and the answer plays without gaps.",
	"## Limits",
	"speak takes at most five thousand characters per request, so every chunk stays well under that. A table or a list is never cut in the middle; only a very long paragraph is cut, and only at the end of a sentence.",
	"When the Mac is asleep, speak is offline. The button then shows a short note instead of trying again and again.",
	"That is the whole feature. The tooltip credits Fish Audio, as the licence asks.",
].join("\n\n");
const SHORT = "A second, short answer for the offline check.";
const EXPECTED = chunkMarkdown(LONG);

function tone(seconds: number): Buffer {
	return execFileSync("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		"-ac",
		"1",
		"-ar",
		"24000",
		"-b:a",
		"48k",
		"-f",
		"mp3",
		"pipe:1",
	]);
}

interface SpeechRequest {
	input: string;
	voice: string;
	at: number;
}

async function startStandInSpeak() {
	const mp3 = tone(1.2);
	const speech: SpeechRequest[] = [];
	const state = { mode: "ok" as "ok" | "offline", firstDelayMs: 1500 };
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c: Buffer) => {
			body += c.toString();
		});
		req.on("end", () => {
			const json = (status: number, v: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(v));
			};
			if (req.url === "/v1/voices")
				return json(200, {
					voices: [
						{ name: "random", locked: false },
						{ name: "main-pi", locked: true },
					],
					attribution: "Built with Fish Audio",
				});
			if (req.url === "/health") return json(state.mode === "ok" ? 200 : 503, { ok: state.mode === "ok" });
			if (req.url !== "/v1/audio/speech" || req.method !== "POST")
				return json(404, { error: { message: "not found", type: "not_found" } });
			const parsed: unknown = JSON.parse(body);
			assert.ok(typeof parsed === "object" && parsed !== null);
			const r = parsed as Record<string, unknown>; // checked above: a JSON object
			assert.equal(r.prepare, true);
			assert.equal(r.response_format, "mp3");
			speech.push({ input: String(r.input), voice: String(r.voice), at: Date.now() });
			if (state.mode === "offline")
				return json(503, { error: { message: "engine unavailable", type: "engine_unavailable" } });
			const delay = speech.length === 1 ? state.firstDelayMs : 250;
			setTimeout(() => {
				res.writeHead(200, { "content-type": "audio/mpeg", "x-speak-attribution": "Built with Fish Audio" });
				res.end(mp3);
			}, delay);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo; // listen() on a TCP port: address() is an AddressInfo
	return { url: `http://127.0.0.1:${port}`, speech, state, close: () => server.close() };
}

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
		await new Promise((r) => setTimeout(r, 80));
	}
	throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
}

const dismiss = (page: Page) =>
	page.evaluate(() => document.querySelector("userscripts-permission-dialog")?.dispatchEvent(new Event("close")));
const phases = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll("sg-speak-button button.sg-speak")).map(
			(b) => b.getAttribute("data-phase") ?? "",
		),
	);

interface Status {
	phase: string;
	chunkIndex: number;
	chunkCount: number;
	played: number[];
	fetched: number[];
	currentTime: number;
	paused: boolean;
	lastNote: string | null;
	buttons: number;
}

/** Shot of one message's footer row (usage + copy + 🔊 + note), with a margin. */
async function footerShot(page: Page, index: number, name: string) {
	const box = await page.evaluate((i) => {
		const btn = document.querySelectorAll("sg-speak-button")[i];
		const row = btn?.parentElement;
		const r = row?.getBoundingClientRect();
		return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
	}, index);
	assert.ok(box, "footer row present");
	await page.screenshot({
		path: join(out, name),
		clip: { x: 0, y: Math.max(0, box.y - 70), width: 520, height: box.height + 100 },
	});
}

test(
	"read aloud: spinner, plays chunks in order with prefetch, replay from memory, stop, offline note, settings switch",
	{ timeout: 240_000 },
	async () => {
		assert.ok(EXPECTED.length >= 4, `expected several chunks, got ${EXPECTED.length}`);
		const speak = await startStandInSpeak();
		const seeded = seededPrimeSession(SID, "Speak test");
		const [user, assistant] = seeded.messages;
		assert.ok(user && assistant);
		const messages = [
			user,
			{ ...assistant, content: [{ type: "text", text: LONG }] },
			{ ...user, content: "And another?", timestamp: user.timestamp + 5000 },
			{ ...assistant, content: [{ type: "text", text: SHORT }], timestamp: assistant.timestamp + 6000 },
		];
		const data = { ...seeded.data, messages };
		const metadata = { ...seeded.metadata, messageCount: messages.length };
		const relay = await startStandInRelay(SID, messages);
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-speak-"));
		const context = await chromium.launchPersistentContext(userDataDir, {
			...(chromePath ? { executablePath: chromePath } : {}),
			headless: true,
			viewport: { width: 520, height: 900 },
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
			await page.evaluate(
				async ({ session, syncUrl, speakUrl }) => {
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
						tx.objectStore("settings").put(speakUrl, "speak.url");
						tx.oncomplete = () => resolve();
						tx.onerror = () => reject(tx.error);
					});
					db.close();
				},
				{ session: { data, metadata }, syncUrl: `${relay.base}/sitegeist`, speakUrl: speak.url },
			);
			await page.goto(`${panelUrl}?session=${SID}`);
			await until(
				async () => {
					await dismiss(page);
					return relay.openSockets();
				},
				(n) => n >= 1,
				30_000,
				"chat open with a live connection",
			);
			const status = async (action = "status", extra: Record<string, unknown> = {}): Promise<Status> => {
				const r = await relay.call("sitegeist_speak", { action, ...extra });
				assert.ok(typeof r === "object" && r !== null && "details" in r);
				return (r as { details: Status }).details; // the panel's sitegeist_speak answers { content, details: status }
			};

			// browser_tabs honours query in the panel too (a raw relay call once got every tab back)
			const none = await relay.call("browser_tabs", { query: "zz-no-such-tab-zz" });
			assert.deepEqual((none as { details: { tabs: unknown[] } }).details.tabs, []); // listTabs answers { details: { tabs } }

			// 1. a 🔊 on both answers, idle, tooltip credits Fish Audio
			await until(
				() => phases(page),
				(p) => p.length === 2 && p.every((x) => x === "idle"),
				15_000,
				"two idle speak buttons",
			);
			const title = await page.getAttribute("sg-speak-button button.sg-speak", "title");
			assert.equal(title, "Read aloud · Built with Fish Audio");
			await footerShot(page, 0, "speak-idle.png");

			// 2. click: spinner while chunk 1 renders (the stand-in holds it 1.5 s)
			await page.locator("sg-speak-button button.sg-speak").first().click();
			await until(
				() => phases(page),
				(p) => p[0] === "loading",
				3_000,
				"spinner",
			);
			await footerShot(page, 0, "speak-loading.png");

			// 3. playing: currentTime advances; chunk 2 was requested while chunk 1 plays
			await until(
				() => phases(page),
				(p) => p[0] === "playing",
				10_000,
				"playing",
			);
			await footerShot(page, 0, "speak-playing.png");
			const s1 = await status();
			await new Promise((r) => setTimeout(r, 400));
			const s2 = await status();
			assert.equal(s2.chunkCount, EXPECTED.length);
			assert.ok(
				s2.currentTime > s1.currentTime || s2.chunkIndex > s1.chunkIndex,
				`currentTime advances (${s1.currentTime} -> ${s2.currentTime})`,
			);
			assert.ok(speak.speech.length >= 2, "the next chunk is fetched while the first one plays");
			assert.equal(speak.speech[0]?.voice, "main-pi");

			// 4. all chunks play, in order; the requests are the chunks, in order
			const done = await until(
				() => status(),
				(s) => s.phase === "idle",
				60_000,
				"playback finished",
			);
			assert.deepEqual(
				done.played,
				EXPECTED.map((_, i) => i),
			);
			assert.deepEqual(
				speak.speech.map((r) => r.input),
				EXPECTED,
			);
			assert.deepEqual(await phases(page), ["idle", "idle"]);

			// 5. replay: from memory (no request), starts at once
			const before = speak.speech.length;
			await page.locator("sg-speak-button button.sg-speak").first().click();
			await until(
				() => phases(page),
				(p) => p[0] === "playing",
				1_500,
				"replay playing at once",
			);
			assert.equal(speak.speech.length, before, "replay made no request");

			// 6. click while playing: stops
			await new Promise((r) => setTimeout(r, 300));
			await page.locator("sg-speak-button button.sg-speak").first().click();
			const stopped = await until(
				() => status(),
				(s) => s.phase === "idle",
				3_000,
				"stopped",
			);
			assert.ok(stopped.paused, "audio paused");
			const playedAtStop = stopped.played.length;
			await new Promise((r) => setTimeout(r, 1_500));
			assert.equal((await status()).played.length, playedAtStop, "nothing more plays after stop");
			assert.deepEqual(await phases(page), ["idle", "idle"]);

			// 7. speak offline (503): a short note, one request, no retry
			speak.state.mode = "offline";
			const offlineBefore = speak.speech.length;
			await page.locator("sg-speak-button button.sg-speak").nth(1).click();
			await page.waitForSelector("sg-speak-button .sg-speak-note", { timeout: 5_000 });
			assert.equal(await page.textContent("sg-speak-button .sg-speak-note"), "speak is offline (M4 asleep?)");
			await footerShot(page, 1, "speak-offline.png");
			await new Promise((r) => setTimeout(r, 1_500));
			assert.equal(speak.speech.length - offlineBefore, 1, "one request, no retry");
			assert.equal((await status()).lastNote, "speak is offline (M4 asleep?)");

			// 8. Settings → Read aloud: URL shown, switch off hides the buttons
			await page.click('button[title="Settings"]');
			await page.getByText("Read aloud", { exact: true }).filter({ visible: true }).click();
			await page.waitForSelector("speak-tab input[type=url]");
			assert.equal(await page.inputValue("speak-tab input[type=url]"), speak.url);
			await page.click("speak-tab button:has-text('Test')");
			await page.waitForFunction(() =>
				document.querySelector("speak-tab .sg-speak-status")?.textContent?.includes("engine is down"),
			);
			await page.screenshot({ path: join(out, "speak-settings.png") });
			await page.click("speak-tab input[type=checkbox]");
			await page.keyboard.press("Escape");
			await until(
				() => phases(page),
				(p) => p.length === 0,
				5_000,
				"buttons hidden when switched off",
			);
		} finally {
			await context.close();
			relay.close();
			speak.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
