/**
 * Fullscreen artifacts (Tom, 2026-10-17: "Can you add ability to fullscreen previews in the artifacts UI ... This could
 * be a little icon next to the download icon in top right") in a real Chromium driven over the DevTools protocol. Only
 * raw CDP reaches a real side panel (Playwright attaches to tabs only).
 *  1. Real side panel (chrome.sidePanel, 360 px, artifacts as an overlay): the fullscreen button sits right of the
 *     download button, and there is no maximize toggle (overlay mode). Clicking it opens a new popup window (requested
 *     in fullscreen state; headless Chrome has no screen to fill, so the state itself is not asserted). It shows every
 *     artifact, starting on the one Tom was looking at, and the image there is larger than the side panel could show it.
 *     Escape closes the window, and so does the window's own exit button. The side panel never tries element
 *     fullscreen: Chrome leaves requestFullscreen() in a side panel pending forever (probe, Chrome 155).
 *  2. A stale window link (the panel moved on) shows a notice with a close button, not a blank page.
 *  3. Tab (sidepanel.html as a tab, as in split view): the artifacts panel element itself goes fullscreen and fills the
 *     window, its icon turns into "Exit fullscreen", the maximize toggle hides, Escape leaves, and no window opens.
 * Run: npm run build:chrome && npm run test:fullscreen:extension
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { makePng } from "./png.fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath();
/** Pinned by the manifest key. */
const EXT = "oinkecmkedjjomenbjealdcgbaipaadb";
const BASE = `chrome-extension://${EXT}`;
const SID = "s-fullscreen";

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls fn until ok; errors (a page still loading or navigating) count as "not yet". */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, label: string): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T | undefined;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (ok(last)) return last;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await sleep(150);
	}
	throw new Error(`timed out waiting for ${label}; last = ${JSON.stringify(last)} ${lastError}`);
}

interface TargetInfo {
	targetId: string;
	type: string;
	url: string;
}

/** A minimal DevTools protocol client over Node's WebSocket (flattened sessions). */
class Cdp {
	private next = 0;
	private readonly waiting = new Map<
		number,
		{ method: string; resolve: (v: Json) => void; reject: (e: Error) => void }
	>();
	private readonly ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.ws = ws;
		ws.addEventListener("message", (ev) => {
			const msg: unknown = JSON.parse(String(ev.data));
			if (!isRecord(msg) || typeof msg.id !== "number") return;
			const waiter = this.waiting.get(msg.id);
			if (!waiter) return;
			this.waiting.delete(msg.id);
			if (isRecord(msg.error)) waiter.reject(new Error(`CDP ${waiter.method}: ${String(msg.error.message)}`));
			else waiter.resolve(isRecord(msg.result) ? msg.result : {});
		});
	}

	static async connect(url: string): Promise<Cdp> {
		const ws = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error(`CDP: cannot connect to ${url}`)), { once: true });
		});
		return new Cdp(ws);
	}

	send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
		const id = ++this.next;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`CDP ${method} timed out`));
			}, 30_000);
			this.waiting.set(id, {
				method,
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	async targets(): Promise<TargetInfo[]> {
		const r = await this.send("Target.getTargets");
		const list = Array.isArray(r.targetInfos) ? r.targetInfos : [];
		return list.flatMap((t: unknown) =>
			isRecord(t) && typeof t.targetId === "string" && typeof t.type === "string" && typeof t.url === "string"
				? [{ targetId: t.targetId, type: t.type, url: t.url }]
				: [],
		);
	}

	async attach(targetId: string): Promise<string> {
		const r = await this.send("Target.attachToTarget", { targetId, flatten: true });
		if (typeof r.sessionId !== "string") throw new Error("no CDP session");
		return r.sessionId;
	}

	/** Evaluates in a page and returns the JSON value. userGesture: the code runs with a click's user activation. */
	async eval(sessionId: string, expression: string, userGesture = false): Promise<unknown> {
		const r = await this.send(
			"Runtime.evaluate",
			{ expression, awaitPromise: true, returnByValue: true, userGesture },
			sessionId,
		);
		if (isRecord(r.exceptionDetails))
			throw new Error(`evaluate: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
		return isRecord(r.result) ? r.result.value : undefined;
	}

	/** A real Escape key press (browser input, as Tom presses it). */
	async escape(sessionId: string): Promise<void> {
		const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
		await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, sessionId);
		// Escape in the fullscreen window closes it on keydown: then there is no page left to receive the keyup.
		await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, sessionId).catch(() => undefined);
	}

	close(): void {
		this.ws.close();
	}
}

function seededSession() {
	const lastModified = "2026-10-17T07:30:00.000Z";
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const model = {
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
	const messages = [
		{ role: "user", content: "Compare the mock with the live page.", timestamp: Date.parse(lastModified) - 2000 },
		{
			role: "assistant",
			content: [{ type: "text", text: "Sure: the comparison and my notes are in the artifacts panel." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: Date.parse(lastModified) - 1000,
		},
		{
			role: "artifact",
			action: "create",
			filename: "mock-vs-live.png",
			content: makePng(1600, 500).toString("base64"),
			timestamp: lastModified,
		},
		{
			role: "artifact",
			action: "create",
			filename: "notes.md",
			content: "# Fullscreen notes\n\nThe stepper labels always show.",
			timestamp: lastModified,
		},
	];
	return {
		data: {
			id: SID,
			title: "Mock vs live",
			model,
			thinkingLevel: "off",
			messages,
			createdAt: lastModified,
			lastModified,
		},
		metadata: {
			id: SID,
			title: "Mock vs live",
			createdAt: lastModified,
			lastModified,
			messageCount: messages.length,
			usage,
			modelId: model.id,
			thinkingLevel: "off",
			preview: "Mock vs live",
		},
	};
}

/** In-page: where the fullscreen button sits among the artifacts header buttons. */
const HEADER_PROBE = `(() => {
	const fs = document.querySelector("artifacts-panel .sg-artifacts-fullscreen");
	if (!fs) return null;
	const buttons = [...fs.parentElement.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
	const at = buttons.indexOf(fs);
	return {
		before: buttons[at - 1]?.title ?? "",
		after: buttons[at + 1]?.title ?? "",
		title: fs.title,
		maximize: document.querySelector("artifacts-panel .sg-artifacts-maximize") !== null,
	};
})()`;

/** In-page: the artifacts panel's tabs, the active one, and what the active artifact shows. */
const ARTIFACTS_PROBE = `(() => {
	const tabs = [...document.querySelectorAll("artifacts-panel button[data-filename]")];
	const active = tabs.find((b) => b.classList.contains("border-primary"))?.getAttribute("data-filename") ?? null;
	const img = [...document.querySelectorAll("artifacts-panel img")].find((i) => i.offsetParent !== null);
	const text = document.querySelector("artifacts-panel")?.innerText ?? "";
	return {
		tabs: tabs.map((b) => b.getAttribute("data-filename")),
		active,
		img: img ? { natural: img.naturalWidth, shown: Math.round(img.getBoundingClientRect().width) } : null,
		notes: text.includes("Fullscreen notes"),
		width: innerWidth,
	};
})()`;

const skip = !existsSync(chromePath)
	? `Chromium not found at ${chromePath} (set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)`
	: !existsSync(join(dist, "manifest.json"))
		? "dist-chrome not built (npm run build:chrome)"
		: false;

test(
	"fullscreen artifacts: a window from the side panel, element fullscreen in a tab",
	{ skip, timeout: 180_000 },
	async () => {
		const profile = await mkdtemp(join(tmpdir(), "sitegeist-fullscreen-"));
		const chrome: ChildProcess = spawn(
			chromePath,
			[
				"--headless=new",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"--window-size=1280,800",
				`--disable-extensions-except=${dist}`,
				`--load-extension=${dist}`,
				"--no-first-run",
				"--no-default-browser-check",
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		let cdp: Cdp | undefined;
		try {
			const portFile = await until(
				() => readFile(join(profile, "DevToolsActivePort"), "utf8"),
				(t) => t.includes("\n"),
				20_000,
				"DevToolsActivePort",
			);
			const [port, path] = portFile.split("\n");
			cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
			const c = cdp;
			const pageTarget = (match: (url: string) => boolean) =>
				c.targets().then((ts) => ts.find((t) => t.type === "page" && match(t.url)));
			const open = async (url: string): Promise<{ targetId: string; session: string }> => {
				const created = await c.send("Target.createTarget", { url });
				if (typeof created.targetId !== "string") throw new Error("no target");
				const session = await c.attach(created.targetId);
				// A new target starts on about:blank (also "complete"): wait for the requested page itself.
				await until(
					() => c.eval(session, `location.href + "|" + document.readyState`),
					(s) => typeof s === "string" && s.startsWith(url) && s.endsWith("|complete"),
					20_000,
					`${url} loaded`,
				);
				return { targetId: created.targetId, session };
			};
			/** A fresh profile has no userScripts permission: the panel waits on its dialog; closing it carries on. */
			const dismissPermission = async (session: string): Promise<void> => {
				await until(
					() => c.eval(session, `!!document.querySelector("userscripts-permission-dialog")`),
					(v) => v === true,
					20_000,
					"permission dialog",
				);
				await c.eval(
					session,
					`document.querySelector("userscripts-permission-dialog").dispatchEvent(new Event("close")); true`,
				);
			};
			await until(
				() => c.targets(),
				(ts) => ts.some((t) => t.type === "service_worker" && t.url.startsWith(`${BASE}/`)),
				20_000,
				"extension service worker",
			);

			// Seed the chat (an image and a markdown artifact) through a panel document, then close it.
			const boot = await open(`${BASE}/sidepanel.html?new=true`);
			await dismissPermission(boot.session);
			await until(
				() => c.eval(boot.session, `!!document.querySelector("sessions-sidebar")`),
				(v) => v === true,
				30_000,
				"panel",
			);
			const seeded = seededSession();
			await c.eval(
				boot.session,
				`(async () => {
				const item = ${JSON.stringify(seeded)};
				const db = await new Promise((res, rej) => { const q = indexedDB.open("sitegeist-storage"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
				await new Promise((res, rej) => { const tx = db.transaction(["sessions", "sessions-metadata"], "readwrite"); tx.objectStore("sessions").put(item.data); tx.objectStore("sessions-metadata").put(item.metadata); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
				db.close();
				return true;
			})()`,
			);
			await c.send("Target.closeTarget", { targetId: boot.targetId });

			// 1. The real side panel (opened with a user gesture, as the toolbar button does). It opens the latest chat.
			const opener = await open(`${BASE}/test.html`);
			await c.eval(
				opener.session,
				"chrome.windows.getCurrent().then((w) => chrome.sidePanel.open({ windowId: w.id })).then(() => true)",
				true,
			);
			const sideTarget = await until(
				() => pageTarget((u) => u === `${BASE}/sidepanel.html`),
				(t) => t !== undefined,
				15_000,
				"side panel target",
			);
			assert.ok(sideTarget);
			const side = await c.attach(sideTarget.targetId);
			await dismissPermission(side);
			await until(
				() => c.eval(side, "document.body.innerText"),
				(t) => typeof t === "string" && t.includes("comparison and my notes"),
				30_000,
				"the chat in the side panel",
			);
			assert.ok(Number(await c.eval(side, "innerWidth")) < 800, "a narrow side panel: artifacts are an overlay");
			await c.eval(side, `document.querySelector('button[title="Show artifacts"]').click(); true`, true);
			await until(
				() => c.eval(side, ARTIFACTS_PROBE),
				(v) => isRecord(v) && Array.isArray(v.tabs) && v.tabs.length === 2,
				10_000,
				"artifacts overlay",
			);
			// Tom is looking at the notes.
			await c.eval(
				side,
				`document.querySelector('artifacts-panel button[data-filename="notes.md"]').click(); true`,
				true,
			);
			const header = await until(
				() => c.eval(side, HEADER_PROBE),
				(v) => isRecord(v) && typeof v.before === "string" && v.before.startsWith("Download"),
				10_000,
				"fullscreen button next to download",
			);
			assert.ok(isRecord(header));
			assert.equal(header.title, "Fullscreen (Esc to leave)");
			assert.equal(header.after, "Close artifacts", "then the close X");
			assert.equal(header.maximize, false, "no maximize toggle in overlay mode");

			const openViewer = async (): Promise<{ targetId: string; session: string }> => {
				await c.eval(
					side,
					`document.querySelector("artifacts-panel .sg-artifacts-fullscreen").click(); true`,
					true,
				);
				const target = await until(
					() => pageTarget((u) => u.startsWith(`${BASE}/sidepanel.html?view=artifacts&token=`)),
					(t) => t !== undefined,
					15_000,
					"fullscreen window",
				);
				assert.ok(target);
				const session = await c.attach(target.targetId);
				await until(
					() => c.eval(session, ARTIFACTS_PROBE),
					(v) => isRecord(v) && Array.isArray(v.tabs) && v.tabs.length === 2,
					15_000,
					"artifacts in the fullscreen window",
				);
				return { targetId: target.targetId, session };
			};
			const gone = (targetId: string) =>
				until(
					() => c.targets(),
					(ts) => !ts.some((t) => t.targetId === targetId),
					10_000,
					"window closed",
				);

			const viewer = await openViewer();
			const win = await c.eval(
				viewer.session,
				"chrome.windows.getCurrent().then((w) => ({ type: w.type, state: w.state }))",
			);
			assert.ok(isRecord(win) && win.type === "popup", JSON.stringify(win));
			const first = await c.eval(viewer.session, ARTIFACTS_PROBE);
			assert.ok(isRecord(first));
			assert.deepEqual(first.tabs, ["mock-vs-live.png", "notes.md"]);
			assert.equal(first.active, "notes.md", "starts on the artifact Tom was looking at");
			assert.equal(first.notes, true);
			const viewerHeader = await c.eval(viewer.session, HEADER_PROBE);
			assert.ok(isRecord(viewerHeader));
			assert.equal(viewerHeader.title, "Exit fullscreen (Esc)");
			assert.equal(viewerHeader.maximize, false, "no maximize toggle in the window");
			assert.ok(
				(await c.targets()).some((t) => t.targetId === sideTarget.targetId),
				"the side panel stays open",
			);
			// The image, larger than the side panel can show it.
			await c.eval(
				viewer.session,
				`document.querySelector('artifacts-panel button[data-filename="mock-vs-live.png"]').click(); true`,
				true,
			);
			const image = await until(
				() => c.eval(viewer.session, ARTIFACTS_PROBE),
				(v) => isRecord(v) && isRecord(v.img) && Number(v.img.shown) > 0,
				10_000,
				"image in the window",
			);
			assert.ok(isRecord(image) && isRecord(image.img));
			assert.equal(image.img.natural, 1600);
			assert.ok(
				Number(image.img.shown) > 900,
				`shown ${image.img.shown} px wide, the side panel is ${await c.eval(side, "innerWidth")} px`,
			);
			// Escape closes the window.
			await c.escape(viewer.session);
			await gone(viewer.targetId);
			// The window's own exit button closes it too.
			const again = await openViewer();
			await c.eval(
				again.session,
				`document.querySelector("artifacts-panel .sg-artifacts-fullscreen").click(); true`,
				true,
			);
			await gone(again.targetId);
			assert.equal(
				await c.eval(side, "document.fullscreenElement === null"),
				true,
				"the side panel itself never went fullscreen",
			);

			// 2. A stale link: the panel no longer has those artifacts.
			const stale = await open(`${BASE}/sidepanel.html?view=artifacts&token=stale`);
			const notice = await until(
				() => c.eval(stale.session, "document.body.innerText"),
				(t) => typeof t === "string" && t.includes("no longer available"),
				10_000,
				"stale notice",
			);
			assert.ok(String(notice).includes("Close this window"));
			await c.send("Target.closeTarget", { targetId: stale.targetId });

			// 3. sitegeist in a tab: the artifacts panel element itself goes fullscreen.
			const tab = await open(`${BASE}/sidepanel.html?session=${SID}`);
			await dismissPermission(tab.session);
			await until(
				() => c.eval(tab.session, "document.body.innerText"),
				(t) => typeof t === "string" && t.includes("comparison and my notes"),
				30_000,
				"the chat in a tab",
			);
			await c.eval(tab.session, `document.querySelector('button[title="Show artifacts"]').click(); true`, true);
			const tabHeader = await until(
				() => c.eval(tab.session, HEADER_PROBE),
				(v) => isRecord(v) && typeof v.before === "string" && v.before.startsWith("Download"),
				10_000,
				"header in the tab",
			);
			assert.ok(isRecord(tabHeader));
			assert.equal(tabHeader.maximize, true, "side by side: the maximize toggle is there");
			const windowsBefore = (await c.targets()).filter((t) => t.url.includes("view=artifacts")).length;
			await c.eval(
				tab.session,
				`document.querySelector("artifacts-panel .sg-artifacts-fullscreen").click(); true`,
				true,
			);
			const full = await until(
				() =>
					c.eval(
						tab.session,
						`(() => { const el = document.fullscreenElement; return el ? { tag: el.tagName, w: Math.round(el.getBoundingClientRect().width), win: innerWidth } : null; })()`,
					),
				(v) => isRecord(v),
				10_000,
				"element fullscreen",
			);
			assert.ok(isRecord(full));
			assert.equal(full.tag, "ARTIFACTS-PANEL");
			assert.equal(full.w, full.win, "the artifacts fill the window");
			const fullHeader = await until(
				() => c.eval(tab.session, HEADER_PROBE),
				(v) => isRecord(v) && v.title === "Exit fullscreen (Esc)",
				5_000,
				"exit icon",
			);
			assert.ok(isRecord(fullHeader));
			assert.equal(fullHeader.maximize, false, "no maximize toggle while fullscreen");
			await c.escape(tab.session);
			await until(
				() => c.eval(tab.session, "document.fullscreenElement === null"),
				(v) => v === true,
				10_000,
				"Escape leaves fullscreen",
			);
			assert.equal(
				(await c.targets()).filter((t) => t.url.includes("view=artifacts")).length,
				windowsBefore,
				"no window opened from a tab",
			);
			assert.ok(
				String(await c.eval(tab.session, "document.body.innerText")).includes("comparison and my notes"),
				"chat intact",
			);
		} finally {
			cdp?.close();
			chrome.kill("SIGKILL");
		}
	},
);
