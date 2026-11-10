/**
 * Pictures of an R730 chat are fetched by link (Tom, 2026-11-10: "have chats stored remotely and not loaded
 * locally"). Real extension in Chromium, a chat whose history has a picture Tom sent, a tool result with a picture
 * and a small inline icon:
 *  - the panel asks for the history with images=refs, and for the live events too;
 *  - the picture Tom sent is drawn in his bubble from the link (a browser that never sent it shows it), fetched with
 *    the relay token as a smaller copy;
 *  - a tool result's picture is not fetched while its card is folded, and is when the card is opened;
 *  - a click opens the stored file at full size;
 *  - the browser's stored copy of the chat holds the links and no picture data;
 *  - a picture in a live event arrives as a link and is drawn.
 * Saves a screenshot to tests/.out/ for a human look.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { makePng } from "./png.fixture.ts";
import { seededPrimeSession, startStandInRelay } from "./prime-relay.fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const SID = "sg-1a1a1a1a1a1a";
const seeded = seededPrimeSession(SID, "P&L screenshots");

const picture = (width: number, height: number) => {
	const bytes = makePng(width, height);
	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
	const ref = {
		hash,
		bytes: bytes.length,
		mimeType: "image/png",
		width,
		height,
		path: `/agents/prime/sessions/${SID}/images/${hash}`,
	};
	return { bytes, hash, block: { type: "image", mimeType: "image/png", data: "", ref } };
};
const sent = picture(900, 1200); // a screenshot Tom pasted
const shot = picture(1200, 700); // a tool result's screenshot
const live = picture(640, 400); // arrives in a live event
const icon = makePng(24, 24).toString("base64"); // small: stays inline

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
};
const t0 = Date.parse("2026-11-09T22:40:00.000Z");
const history = [
	...seeded.messages,
	{
		role: "user",
		content: [{ type: "text", text: "Here is the P&L screenshot, what do the columns mean?" }, sent.block],
		timestamp: t0,
	},
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "browser_screenshot", arguments: { tabId: 7 } }],
		...meta,
		stopReason: "toolUse",
		timestamp: t0 + 1000,
	},
	{
		role: "toolResult",
		toolCallId: "c1",
		toolName: "browser_screenshot",
		content: [
			{ type: "text", text: "Screenshot of tab 7 (1200x700)" },
			shot.block,
			{ type: "image", mimeType: "image/png", data: icon },
		],
		isError: false,
		timestamp: t0 + 2000,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "The columns are daily, month-to-date and year-to-date P&L." }],
		...meta,
		stopReason: "stop",
		timestamp: t0 + 3000,
	},
];

async function dismissPermissionDialog(page: Page): Promise<void> {
	await page.evaluate(() =>
		document.querySelector("userscripts-permission-dialog")?.dispatchEvent(new Event("close")),
	);
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
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
}

interface Drawn {
	hash: string;
	naturalWidth: number;
	width: number;
	height: number;
	inUserBubble: boolean;
}
const drawn = (page: Page): Promise<Drawn[]> =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLImageElement>("img.sg-remote-image")).map((img) => ({
			hash: img.dataset.hash ?? "",
			naturalWidth: img.naturalWidth,
			width: Math.round(img.getBoundingClientRect().width),
			height: Math.round(img.getBoundingClientRect().height),
			inUserBubble: img.closest(".user-message-container") !== null,
		})),
	);

test("pictures of an R730 chat are fetched by link, only when they are shown", { timeout: 180_000 }, async () => {
	const relay = await startStandInRelay(SID, history, {
		images: {
			[sent.hash]: { bytes: sent.bytes, mimeType: "image/png" },
			[shot.hash]: { bytes: shot.bytes, mimeType: "image/png" },
			[live.hash]: { bytes: live.bytes, mimeType: "image/png" },
		},
	});
	const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-pictures-"));
	const context = await chromium.launchPersistentContext(userDataDir, {
		...(chromePath ? { executablePath: chromePath } : {}),
		headless: true,
		viewport: { width: 520, height: 1100 },
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
		// This browser has never seen the chat: only the relay address and token are set (like the M4 opening a chat
		// that was started on the laptop).
		await page.evaluate(
			async ({ syncUrl }) => {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const req = indexedDB.open("sitegeist-storage");
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				});
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction(["settings"], "readwrite");
					tx.objectStore("settings").put(syncUrl, "sync.url");
					tx.objectStore("settings").put("test-token", "sync.token");
					tx.oncomplete = () => resolve();
					tx.onerror = () => reject(tx.error);
				});
				db.close();
			},
			{ syncUrl: `${relay.base}/sitegeist` },
		);
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
		assert.ok(relay.hydrateQueries.length >= 1, "the panel loaded the history");
		assert.ok(
			relay.hydrateQueries.every((q) => q === "images=refs"),
			`history asked with images=refs: ${JSON.stringify(relay.hydrateQueries)}`,
		);
		assert.ok(
			relay.socketQueries.every((q) => /(^|&)images=refs(&|$)/.test(q)),
			`live events asked with images=refs: ${JSON.stringify(relay.socketQueries)}`,
		);

		// The picture Tom sent is drawn in his bubble, from the link.
		const first = await until(
			() => drawn(page),
			(d) => d.some((x) => x.hash === sent.hash && x.naturalWidth > 0),
			30_000,
			"the sent picture drawn",
		);
		const mine = first.find((x) => x.hash === sent.hash);
		assert.ok(mine?.inUserBubble, "it is inside the user bubble");
		assert.equal(mine.height, 160, "drawn 160 px high");
		assert.equal(mine.width, 120, "in the picture's own shape (900x1200)");
		const sentFetch = relay.imageRequests.filter((r) => r.hash === sent.hash);
		assert.equal(sentFetch.length, 1, "fetched once");
		assert.match(sentFetch[0]?.query ?? "", /^w=(256|512)$/, "as a smaller copy");
		assert.equal(sentFetch[0]?.authorization, "Bearer test-token", "with the relay token");

		// The tool result's picture is behind a folded card: not fetched yet.
		assert.equal(
			relay.imageRequests.filter((r) => r.hash === shot.hash).length,
			0,
			"nothing fetched for a folded card",
		);
		await page.click("tool-message >> nth=0 >> .text-sm");
		const opened = await until(
			() => drawn(page),
			(d) => d.some((x) => x.hash === shot.hash && x.naturalWidth > 0),
			20_000,
			"the tool picture drawn after opening the card",
		);
		const tool = opened.find((x) => x.hash === shot.hash);
		assert.ok(tool && !tool.inUserBubble);
		assert.ok(tool.height <= 256, `no taller than 256 px: ${tool.height}`);
		assert.match(relay.imageRequests.find((r) => r.hash === shot.hash)?.query ?? "", /^w=\d+$/);
		// The small inline icon is still drawn from its data.
		const inlineIcons = await page.evaluate(
			() => Array.from(document.querySelectorAll<HTMLImageElement>('tool-message img[alt="tool image"]')).length,
		);
		assert.equal(inlineIcons, 1, "the small inline image is drawn as before");
		await mkdir(join(root, "tests/.out"), { recursive: true });
		await page.screenshot({ path: join(root, "tests/.out/remote-images.png"), fullPage: true });

		// A click opens the stored file at full size.
		await page.click(`img.sg-remote-image[data-hash="${sent.hash}"]`);
		await until(
			async () => relay.imageRequests.filter((r) => r.hash === sent.hash && r.query === "").length,
			(n) => n === 1,
			15_000,
			"the full-size file fetched",
		);
		await until(
			() => page.evaluate(() => document.querySelector("attachment-overlay") !== null),
			(v) => v,
			15_000,
			"the full-size view open",
		);
		await page.keyboard.press("Escape");

		// A picture in a live event arrives as a link and is drawn.
		relay.pushEvents([
			{ type: "agent_start" },
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "c2", name: "browser_screenshot", arguments: { tabId: 9 } }],
					...meta,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
			},
			{
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "c2",
					toolName: "browser_screenshot",
					content: [{ type: "text", text: "Screenshot of tab 9 (640x400)" }, live.block],
					isError: false,
					timestamp: Date.now(),
				},
			},
			{ type: "agent_end", messages: [] },
		]);
		await until(
			() => page.evaluate(() => document.querySelectorAll("tool-message").length),
			(n) => n === 2,
			20_000,
			"the live tool call shown",
		);
		await page.click("tool-message >> nth=1 >> .text-sm");
		await until(
			() => drawn(page),
			(d) => d.some((x) => x.hash === live.hash && x.naturalWidth > 0),
			20_000,
			"the live picture drawn",
		);

		// The browser's own copy of the chat: links, no picture data.
		const stored = await until(
			() =>
				page.evaluate(async (id) => {
					const db = await new Promise<IDBDatabase>((resolve, reject) => {
						const req = indexedDB.open("sitegeist-storage");
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(req.error);
					});
					const record = await new Promise<unknown>((resolve, reject) => {
						const req = db.transaction(["sessions"], "readonly").objectStore("sessions").get(id);
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(req.error);
					});
					db.close();
					const text = JSON.stringify(record ?? null);
					return { chars: text.length, links: (text.match(/"path":"\/agents\/prime\/sessions\//g) ?? []).length };
				}, SID),
			(s) => s.links >= 3,
			20_000,
			"the chat saved with its links",
		);
		assert.ok(stored.chars < 20_000, `the stored chat is small: ${stored.chars} chars`);
		assert.equal(stored.links, 3, "three pictures, three links");
	} finally {
		await context.close();
		await relay.close();
		await rm(userDataDir, { recursive: true, force: true });
	}
});
