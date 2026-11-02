/**
 * R730 tool calls render like the Browser agent's (Tom, 2026-11-02, Quant Coach chat: three browser calls shown as
 * "Tool Call" + raw JSON + raw output, all open - "Why does it look so different from when the browser agent reads a
 * page?"). Real extension in Chromium, a hydrated prime session with the calls from that chat plus a successful read
 * and a Python call: every call shows a one-line title and a subtitle, the details stay folded until the chevron is
 * clicked, and the word "Tool Call" appears nowhere. Saves a screenshot to tests/.out/ for a human look.
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
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const SID = "sg-5e5e5e5e5e5e";
const seeded = seededPrimeSession(SID, "LinkedIn profile");

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
const t0 = Date.parse("2026-11-02T20:57:51.000Z");
const call = (id: string, name: string, args: Record<string, unknown>, at: number) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	...meta,
	timestamp: t0 + at,
});
const result = (id: string, name: string, text: string, at: number, isError = false) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError,
	timestamp: t0 + at,
});
const TIMEOUT = "browser tool browser_page (reader script) failed: browser_call_timeout";
const history = [
	...seeded.messages,
	{
		role: "user",
		content:
			"If we were to make my linkedin profile more snazzy, what changes would you make (please read the webpage)",
		timestamp: t0 - 5000,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "I'll read the actual profile page now." }],
		...meta,
		stopReason: "stop",
		timestamp: t0 - 1000,
	},
	call("c1", "browser_page", { tabId: 121, links: false }, 0),
	result("c1", "browser_page", TIMEOUT, 35_000),
	call("c2", "browser_page", { tabId: 121, mode: "text", selector: "main" }, 38_000),
	result("c2", "browser_page", TIMEOUT, 73_000),
	call(
		"c3",
		"browser_eval",
		{
			tabId: 121,
			code: "const main = document.querySelector('main') || document.body;\nconst txt = main.innerText || '';\nreturn {url: location.href, title: document.title, len: txt.length};",
			timeoutMs: 20000,
		},
		77_000,
	),
	result("c3", "browser_eval", "browser tool browser_eval failed: browser_call_timeout", 102_000),
	call("c4", "browser_tabs", { query: "linkedin" }, 105_000),
	result(
		"c4",
		"browser_tabs",
		'id\tmark\twin\ttitle\turl\n60\t*>\t38\tTomos Wells | LinkedIn\thttps://www.linkedin.com/in/tomos-wells/\nShowing 1; 1 of 14 open tabs match "linkedin".',
		105_500,
	),
	call("c5", "browser_page", { tabId: 60 }, 106_000),
	result(
		"c5",
		"browser_page",
		"Tomos Wells | LinkedIn — https://www.linkedin.com/in/tomos-wells/\n[browser_page: main via semantic; 3,540 chars of markdown (whole page text 3,540); 12 form controls; complete]\n\n# Tomos Wells\n\nQuantitative researcher · London\n\n## About\n\nI build systematic strategies…",
		106_200,
	),
	call("c6", "ipython", { code: "import json\nh = await bash('ls ~/cv')\nprint(h.output)" }, 107_000),
	result("c6", "ipython", "cv-2026.pdf\ncv-2026.tex\n", 107_300),
	{
		role: "assistant",
		content: [{ type: "text", text: "Your profile is readable now. Three changes I would make: …" }],
		...meta,
		stopReason: "stop",
		timestamp: t0 + 110_000,
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

interface ToolView {
	headers: string[];
	subtitles: string[];
	openBodies: number;
	unfoldedInputs: number;
	rawToolCallWords: number;
	pageText: string;
}

function toolView(page: Page): Promise<ToolView> {
	return page.evaluate(() => {
		const cards = Array.from(document.querySelectorAll("tool-message"));
		const headers = cards.map((c) => (c.querySelector(".text-sm") as HTMLElement | null)?.innerText.trim() ?? "");
		const subtitles = cards.map(
			(c) => (c.querySelector(".text-xs.mt-1") as HTMLElement | null)?.innerText.trim() ?? "",
		);
		const openBodies = cards.filter((c) => c.querySelector(".max-h-\\[2000px\\]") !== null).length;
		// innerText still includes clipped (max-h-0, overflow-hidden) content; the fold is the container's height.
		const unfoldedInputs = cards.filter((c) => {
			const fold = c.querySelector(".overflow-hidden.transition-all") as HTMLElement | null;
			return fold !== null && fold.clientHeight > 0;
		}).length;
		const pageText = document.body.innerText;
		const rawToolCallWords = (pageText.match(/\bTool Call\b/g) ?? []).length;
		return { headers, subtitles, openBodies, unfoldedInputs, rawToolCallWords, pageText };
	});
}

test(
	"R730 tool calls show a title and a subtitle, details folded, no raw 'Tool Call' card",
	{ timeout: 180_000 },
	async () => {
		const relay = await startStandInRelay(SID, history);
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-render-"));
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
			const v = await until(
				() => toolView(page),
				(x) => x.headers.length >= 6,
				30_000,
				"six tool cards rendered",
			);
			await mkdir(join(root, "tests/.out"), { recursive: true });
			await page.screenshot({ path: join(root, "tests/.out/prime-tool-render.png"), fullPage: true });

			assert.equal(v.rawToolCallWords, 0, "no generic 'Tool Call' header anywhere");
			assert.deepEqual(v.headers, [
				"Reading the page · tab 121",
				"Reading the page · tab 121 · main · text",
				"Running JavaScript in the page · tab 121 · const main = document.querySelector('main') || document.bod…",
				'Finding tabs matching "linkedin"',
				"Reading the page · tab 60",
				"Python · import json",
			]);
			assert.equal(v.subtitles[0], TIMEOUT);
			assert.equal(v.subtitles[3], 'Showing 1; 1 of 14 open tabs match "linkedin".');
			assert.equal(v.subtitles[4], "Tomos Wells | LinkedIn — https://www.linkedin.com/in/tomos-wells/");
			assert.equal(v.subtitles[5], "cv-2026.pdf");
			assert.equal(v.openBodies, 0, "details are folded until clicked");
			assert.equal(v.unfoldedInputs, 0, "no input/output block is visible before a click");

			// Opening one card shows its input and output.
			await page.click("tool-message >> nth=4 >> .text-sm");
			const opened = await until(
				() => toolView(page),
				(x) => x.openBodies === 1 && x.unfoldedInputs === 1,
				10_000,
				"one card open",
			);
			assert.ok(opened.pageText.includes("3,540 chars of markdown"), "the opened card shows the full output");
			await page.screenshot({ path: join(root, "tests/.out/prime-tool-render-open.png"), fullPage: true });
		} finally {
			await context.close();
			await relay.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
