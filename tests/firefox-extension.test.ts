/**
 * The Firefox / Zen build in REAL Zen (headless), driven through geckodriver's W3C WebDriver HTTP API (no Selenium).
 * Covers what Firefox does differently from Chrome: unsigned permanent install, the extension sidebar opened from the
 * toolbar button, the optional userScripts permission, page scripts (isolated + page world), screenshots, the code
 * sandbox (HTML artifacts), PDFs in Firefox's own viewer, and the page-event input fallback (no debugger API).
 * Second test: sitegeist opened next to a page (2026-10-12): the tab lands right after the page with both selected, the
 * chat and its unsent text move along, and once Tom joins them in Zen's split view prime's browser tools work on the
 * page beside the panel (Zen gives extensions no split ids: the visible tab / remembered page decides).
 *
 * Needs ~/.cache/sitegeist-firefox-test/zen/zen (Zen Linux x86_64, e.g. 1.23.2b = Firefox 157) and
 * ~/.cache/sitegeist-firefox-test/geckodriver (0.37+); the test is skipped when they are missing.
 * Run: npm run build:firefox && npm run test:firefox:extension
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syntheticInputInPage } from "../src/tools/synthetic-input.ts";
import { imageOf, seededPrimeSession, startStandInRelay, textOf } from "./prime-relay.fixture.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist-firefox");
const cache = join(homedir(), ".cache", "sitegeist-firefox-test");
const zen = join(cache, "zen", "zen");
const geckodriver = join(cache, "geckodriver");
const EXT_ID = "sitegeist-dev@tjw-private";
const EXT_UUID = "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const BASE = `moz-extension://${EXT_UUID}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
	const started = Date.now();
	let last = await read();
	while (!ok(last)) {
		if (Date.now() - started > timeoutMs)
			throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
		await sleep(250);
		last = await read();
	}
	return last;
}

/** Minimal W3C WebDriver client for geckodriver. */
class Driver {
	base: string;
	session = "";
	constructor(base: string) {
		this.base = base;
	}
	async cmd(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
		const res = await fetch(`${this.base}${path}`, {
			method,
			headers: { "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(120_000),
		});
		const json: unknown = await res.json();
		const value = isRecord(json) ? json.value : undefined;
		if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(value).slice(0, 500)}`);
		return value;
	}
	s(path: string): string {
		return `/session/${this.session}${path}`;
	}
	async context(ctx: "chrome" | "content"): Promise<void> {
		await this.cmd("POST", this.s("/moz/context"), { context: ctx });
	}
	async run(script: string, args: unknown[] = []): Promise<unknown> {
		return this.cmd("POST", this.s("/execute/sync"), { script, args });
	}
	/** Runs an async body; the last argument is the WebDriver callback. */
	async runAsync(body: string, args: unknown[] = []): Promise<unknown> {
		const script = `const done = arguments[arguments.length - 1]; (async () => { ${body} })().then(done, (e) => done({ error: String(e) }));`;
		return this.cmd("POST", this.s("/execute/async"), { script, args });
	}
	async handles(): Promise<string[]> {
		const v = await this.cmd("GET", this.s("/window/handles"));
		return Array.isArray(v) ? v.filter((h): h is string => typeof h === "string") : [];
	}
	async switchTo(handle: string): Promise<void> {
		await this.cmd("POST", this.s("/window"), { handle });
	}
	async element(using: "xpath" | "css selector", value: string): Promise<string> {
		const v = await this.cmd("POST", this.s("/element"), { using, value });
		const id = isRecord(v) ? Object.values(v)[0] : undefined;
		if (typeof id !== "string") throw new Error(`no element ${value}`);
		return id;
	}
	async click(using: "xpath" | "css selector", value: string): Promise<void> {
		await this.cmd("POST", this.s(`/element/${await this.element(using, value)}/click`), {});
	}
	async frame(using: "css selector", value: string): Promise<void> {
		const id = await this.element(using, value);
		await this.cmd("POST", this.s("/frame"), { id: { "element-6066-11e4-a52e-4f735466cecf": id } });
	}
	async parentFrame(): Promise<void> {
		await this.cmd("POST", this.s("/frame/parent"), {});
	}
	/** Opens a URL in a new tab from the browser chrome (WebDriver cannot navigate to moz-extension:// itself). */
	async openTab(url: string): Promise<string> {
		const before = new Set(await this.handles());
		await this.context("chrome");
		await this.run(
			`const w = Services.wm.getMostRecentWindow("navigator:browser");
			 w.gBrowser.selectedTab = w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
			[url],
		);
		await this.context("content");
		const handles = await until(
			() => this.handles(),
			(hs) => hs.some((h) => !before.has(h)),
			10_000,
			"new tab",
		);
		const handle = handles.find((h) => !before.has(h));
		if (!handle) throw new Error("no new tab");
		await this.switchTo(handle);
		return handle;
	}
}

function minimalPdf(): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		"",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	const stream = "BT /F1 24 Tf 72 700 Td (Zen PDF test page) Tj ET";
	objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(Buffer.byteLength(out));
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out);
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out);
}

const skip =
	!existsSync(zen) || !existsSync(geckodriver)
		? `Zen/geckodriver not cached in ${cache} (zen/zen + geckodriver); see the header of this file`
		: !existsSync(join(dist, "manifest.json"))
			? "dist-firefox not built (npm run build:firefox)"
			: false;

/** geckodriver + headless Zen with the unsigned build installed permanently, as Tom has it after the one-time setup. */
async function startZen(): Promise<{ d: Driver; stop: () => Promise<void> }> {
	const work = mkdtempSync(join(tmpdir(), "sitegeist-zen-"));
	const xpi = join(work, "sitegeist.xpi");
	execFileSync("zip", ["-qr", "-X", xpi, ".", "-x", "*.map"], { cwd: dist });
	const port = 4444 + Math.floor(Math.random() * 1000);
	const gd: ChildProcess = spawn(geckodriver, ["--port", String(port), "--allow-system-access", "--log", "warn"], {
		stdio: "ignore",
	});
	const d = new Driver(`http://127.0.0.1:${port}`);
	const stop = async (): Promise<void> => {
		if (d.session) await d.cmd("DELETE", `/session/${d.session}`).catch(() => undefined);
		gd.kill("SIGTERM");
	};
	try {
		await until(
			() =>
				fetch(`${d.base}/status`).then(
					(r) => r.ok,
					() => false,
				),
			(ok) => ok,
			15_000,
			"geckodriver",
		);
		const created = await d.cmd("POST", "/session", {
			capabilities: {
				alwaysMatch: {
					browserName: "firefox",
					"moz:firefoxOptions": {
						binary: zen,
						args: ["-headless", "-width=1280", "-height=800"],
						prefs: {
							"xpinstall.signatures.required": false, // what Tom sets once in about:config
							"extensions.webextensions.uuids": JSON.stringify({ [EXT_ID]: EXT_UUID }),
							"extensions.webextOptionalPermissionPrompts": false, // stands in for clicking "Allow"
						},
					},
				},
			},
		});
		d.session = isRecord(created) && typeof created.sessionId === "string" ? created.sessionId : "";
		assert.ok(d.session, "webdriver session");
		// unsigned, permanent install (what clicking the .xpi link does once the pref is off)
		const installed = await d.cmd("POST", d.s("/moz/addon/install"), {
			addon: readFileSync(xpi).toString("base64"),
			temporary: false,
		});
		assert.equal(installed, EXT_ID);
		return { d, stop };
	} catch (err) {
		await stop();
		throw err;
	}
}

test(
	"Firefox / Zen build: installs, opens as a sidebar, reads and drives pages, renders artifacts",
	{ skip },
	async () => {
		// a page for the agent to read and drive
		const site = createServer((req, res) => {
			res.setHeader("content-type", "text/html");
			res.end(`<!doctype html><title>Zen test page</title><h1 id="h">waiting</h1>
			<button id="b" onclick="document.getElementById('h').textContent='clicked'">Go</button>
			<form id="f" onsubmit="event.preventDefault(); document.getElementById('h').textContent='submitted:' + document.getElementById('q').value"><input id="q"></form>
			<script>window.pageSecret = 42;</script>`);
		});
		await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
		const pageUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`; // listen(0) on TCP: always an AddressInfo

		// 1. unsigned, permanent install (startZen)
		const { d, stop } = await startZen();
		try {
			// 2. the toolbar button toggles the sitegeist sidebar (Firefox also opens it once on install)
			await d.context("chrome");
			const sidebar = () =>
				d.run(`const w = Services.wm.getMostRecentWindow("navigator:browser"); const sc = w.SidebarController;
				const b = w.document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser");
				return { id: sc.currentID, open: sc.isOpen, url: b?.currentURI?.spec ?? null };`);
			const clickToolbar = () =>
				d.run(`Services.wm.getMostRecentWindow("navigator:browser").document
				.getElementById("sitegeist-dev_tjw-private-browser-action")
				.querySelector(".unified-extensions-item-action-button").click();`);
			const first = await until(
				sidebar,
				(v) => isRecord(v) && v.open === true,
				15_000,
				"sidebar open after install",
			);
			assert.ok(isRecord(first));
			await clickToolbar();
			await until(sidebar, (v) => isRecord(v) && v.open === false, 10_000, "toolbar click closes the sidebar");
			await clickToolbar();
			const reopened = await until(
				sidebar,
				(v) => isRecord(v) && v.open === true && v.url === `${BASE}/sidepanel.html`,
				10_000,
				"toolbar click opens the sitegeist sidebar",
			);
			assert.equal(isRecord(reopened) ? reopened.id : "", "sitegeist-dev_tjw-private-sidebar-action");
			await d.context("content");

			// 3. panel UI + the optional userScripts permission (one click on "Grant Permission")
			const pageTab = await d.openTab(pageUrl);
			assert.ok(pageTab);
			const panelTab = await d.openTab(`${BASE}/sidepanel.html`);
			await until(
				() => d.run(`return document.body?.innerText ?? ""`),
				(t) => typeof t === "string" && t.includes("Grant Permission"),
				20_000,
				"permission dialog",
			);
			await d.click("xpath", "//button[normalize-space(.)='Grant Permission']");
			const granted = await until(
				() =>
					d.runAsync(
						`return { granted: await chrome.permissions.contains({ permissions: ["userScripts"] }), execute: typeof chrome.userScripts?.execute };`,
					),
				(v) => isRecord(v) && v.granted === true && v.execute === "function",
				10_000,
				"userScripts granted",
			);
			assert.ok(isRecord(granted));

			// 4. page scripts (isolated world and the page's own world) + a screenshot of the page tab
			const pageCheck = await d.runAsync(
				`const page = (await chrome.tabs.query({})).find((t) => (t.url ?? "").startsWith(arguments[0])); // match patterns cannot carry a port
			 const iso = await chrome.userScripts.execute({ js: [{ code: "({ title: document.title, secret: typeof window.pageSecret })" }], target: { tabId: page.id }, world: "USER_SCRIPT" });
			 const main = await chrome.userScripts.execute({ js: [{ code: "window.pageSecret" }], target: { tabId: page.id }, world: "MAIN" });
			 await chrome.tabs.update(page.id, { active: true });
			 await new Promise((r) => setTimeout(r, 300));
			 const shot = await chrome.tabs.captureVisibleTab(page.windowId, { format: "png" });
			 await chrome.tabs.update((await chrome.tabs.getCurrent()).id, { active: true });
			 return { iso: iso[0]?.result, main: main[0]?.result, shot: shot.slice(0, 22), shotLen: shot.length, tabId: page.id };`,
				[pageUrl],
			);
			assert.ok(isRecord(pageCheck), JSON.stringify(pageCheck));
			assert.deepEqual(pageCheck.iso, { title: "Zen test page", secret: "undefined" }, JSON.stringify(pageCheck)); // isolated: no page globals
			assert.equal(pageCheck.main, 42); // page world sees them
			assert.equal(pageCheck.shot, "data:image/png;base64,");
			assert.ok(typeof pageCheck.shotLen === "number" && pageCheck.shotLen > 1000);

			// 5. no debugger API in Firefox: nativeClick/nativeType/nativePress fall back to page events (synthetic-input.ts)
			const input = await d.runAsync(
				`const tabId = arguments[1];
			 const run = async (p) => (await chrome.userScripts.execute({ js: [{ code: "(" + arguments[0] + ")(" + JSON.stringify(p) + ")" }], target: { tabId }, world: "USER_SCRIPT", worldId: "sitegeist-synthetic-input" }))[0]?.result;
			 const m = { alt: false, ctrl: false, meta: false, shift: false };
			 const read = async (code) => (await chrome.userScripts.execute({ js: [{ code }], target: { tabId }, world: "MAIN" }))[0]?.result;
			 const out = {};
			 out.click = await run({ ...m, action: "click", selector: "#b" });
			 out.afterClick = await read("document.getElementById('h').textContent");
			 out.type = await run({ ...m, action: "type", selector: "#q", text: "zen" });
			 out.enter = await run({ ...m, action: "press", key: { key: "Enter", code: "Enter", keyCode: 13 } });
			 out.afterEnter = await read("document.getElementById('h').textContent");
			 out.missing = await run({ ...m, action: "click", selector: "#nope" });
			 return out;`,
				[syntheticInputInPage.toString(), pageCheck.tabId],
			);
			assert.ok(isRecord(input), JSON.stringify(input));
			assert.equal(input.afterClick, "clicked");
			assert.equal(input.afterEnter, "submitted:zen");
			assert.deepEqual(input.missing, { ok: false, error: "Selector not found: #nope" });

			// 6. artifacts: a PDF in Firefox's own viewer, an HTML artifact running its script in the extension sandbox
			const now = new Date().toISOString();
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
				{ role: "user", content: "Show me the report and a page.", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "Both are in the artifacts panel." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage,
					stopReason: "stop",
					timestamp: 2,
				},
				{
					role: "artifact",
					action: "create",
					filename: "report.pdf",
					content: minimalPdf().toString("base64"),
					timestamp: now,
				},
				{
					role: "artifact",
					action: "create",
					filename: "page.html",
					content:
						"<!doctype html><div id=o>no</div><script>document.getElementById('o').textContent = 'script ran: ' + 6 * 7</script>",
					timestamp: now,
				},
			];
			const sid = "zen-artifacts-test";
			await d.runAsync(
				`const [data, metadata] = arguments;
			 const db = await new Promise((res, rej) => { const q = indexedDB.open("sitegeist-storage"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
			 await new Promise((res, rej) => { const tx = db.transaction(["sessions", "sessions-metadata"], "readwrite"); tx.objectStore("sessions").put(data); tx.objectStore("sessions-metadata").put(metadata); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
			 db.close();
			 location.href = "sidepanel.html?session=" + data.id;`,
				[
					{
						id: sid,
						title: "Zen artifacts",
						model,
						thinkingLevel: "off",
						messages,
						createdAt: now,
						lastModified: now,
					},
					{
						id: sid,
						title: "Zen artifacts",
						createdAt: now,
						lastModified: now,
						messageCount: messages.length,
						usage,
						modelId: model.id,
						thinkingLevel: "off",
						preview: "Zen artifacts",
					},
				],
			);
			await until(
				() =>
					d.run(
						`return [...document.querySelectorAll("artifacts-panel [data-filename]")].map((b) => b.getAttribute("data-filename"))`,
					),
				(v) => Array.isArray(v) && v.includes("report.pdf") && v.includes("page.html"),
				20_000,
				"artifact tabs",
			);
			await d.click("xpath", "//button[@title='Show artifacts' or .//span[normalize-space(.)='Artifacts']]");
			await d.click("css selector", "artifacts-panel [data-filename='report.pdf']");
			await until(
				() => d.run(`return document.querySelector("sg-pdf-artifact iframe")?.src ?? ""`),
				(s) => typeof s === "string" && s.startsWith("blob:"),
				10_000,
				"pdf iframe",
			);
			await d.frame("css selector", "sg-pdf-artifact iframe");
			const viewer = await until(
				() => d.run(`return { title: document.title, pages: document.querySelectorAll(".page").length }`),
				(v) => isRecord(v) && typeof v.pages === "number" && v.pages >= 1,
				15_000,
				"Firefox PDF viewer",
			);
			assert.ok(isRecord(viewer) && viewer.title === "PDF.js viewer", JSON.stringify(viewer));
			await d.parentFrame();
			await d.click("css selector", "artifacts-panel [data-filename='page.html']");
			await until(
				() =>
					d.run(
						`return [...document.querySelectorAll("iframe")].some((f) => f.src.endsWith("/sandbox.html") && f.offsetParent !== null)`,
					),
				(v) => v === true,
				10_000,
				"sandbox iframe",
			);
			await d.frame("css selector", "iframe[src$='/sandbox.html']");
			await until(
				() => d.run(`return document.getElementById("o")?.textContent ?? null`),
				(v) => v === "script ran: 42",
				15_000,
				"HTML artifact script",
			);
			await d.parentFrame();
			assert.ok(panelTab);
		} finally {
			await stop();
			site.close();
		}
	},
);

/** Runs a script in the browser chrome (Zen's own UI code), then returns to the page context. */
async function inChrome(d: Driver, script: string, args: unknown[] = []): Promise<unknown> {
	await d.context("chrome");
	try {
		return await d.run(script, args);
	} finally {
		await d.context("content");
	}
}

/** Polls a read that may fail while a page navigates (failures count as "not yet"). */
async function untilOk<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
	return until(
		() => read().catch((): undefined => undefined),
		(v): v is T => v !== undefined && ok(v),
		timeoutMs,
		what,
	).then((v) => {
		if (v === undefined) throw new Error(`no value for ${what}`);
		return v;
	});
}

const ZEN_TABS = `const w = Services.wm.getMostRecentWindow("navigator:browser"); const g = w.gBrowser;
	const find = (part) => [...g.tabs].find((t) => t.linkedBrowser.currentURI.spec.includes(part));`;

test("Zen: sitegeist opened next to the page works on that page once Tom joins the two tabs", { skip }, async () => {
	const SID = "sg-7c2e4a9b1d3f";
	const DRAFT = "Which claim is weakest?";
	const seeded = seededPrimeSession(SID, "Zen reading companion");
	const relay = await startStandInRelay(SID, seeded.messages);
	const { base } = relay;
	const { d, stop } = await startZen();
	try {
		// The pages Tom has open, and a plain panel tab standing in for the sidebar: page scripts granted, chat seeded.
		await d.openTab(`${base}/other`);
		await d.openTab(`${base}/article`);
		await d.openTab(`${BASE}/sidepanel.html?new=true`);
		await untilOk(
			() => d.run(`return document.body?.innerText ?? ""`),
			(t) => typeof t === "string" && t.includes("Grant Permission"),
			20_000,
			"permission dialog",
		);
		await d.click("xpath", "//button[normalize-space(.)='Grant Permission']");
		await until(
			() => d.runAsync(`return await chrome.permissions.contains({ permissions: ["userScripts"] });`),
			(v) => v === true,
			10_000,
			"userScripts granted",
		);
		await d.runAsync(
			`const [data, metadata, syncUrl] = arguments;
			 const db = await new Promise((res, rej) => { const q = indexedDB.open("sitegeist-storage"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
			 await new Promise((res, rej) => { const tx = db.transaction(["sessions", "sessions-metadata", "settings"], "readwrite"); tx.objectStore("sessions").put(data); tx.objectStore("sessions-metadata").put(metadata); tx.objectStore("settings").put(syncUrl, "sync.url"); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
			 db.close();
			 location.href = "sidepanel.html?session=" + data.id;`,
			[seeded.data, seeded.metadata, `${base}/sitegeist`],
		);
		await untilOk(
			() => d.run(`return document.body?.innerText ?? ""`),
			(t) => typeof t === "string" && t.includes("ask away"),
			30_000,
			"chat",
		);
		const editor = await d.element("css selector", "message-editor textarea");
		await d.cmd("POST", d.s(`/element/${editor}/value`), { text: DRAFT });

		// Tom is on the article; "Open next to this page" in the panel.
		const articleId = await d.runAsync(
			`const t = (await chrome.tabs.query({})).find((x) => (x.url ?? "").startsWith(arguments[0]));
			 await chrome.tabs.update(t.id, { active: true });
			 return t.id;`,
			[`${base}/article`],
		);
		assert.equal(typeof articleId, "number");
		const before = new Set(await d.handles());
		await untilOk(
			() =>
				d.run(
					`const b = document.querySelector('button[title^="Open next to this page"]'); if (!b) return false; b.click(); return true;`,
				),
			(v) => v === true,
			15_000,
			"move button",
		);

		// Zen cannot be split by extensions: the panel opens as the tab right after the page, both tabs selected.
		const handle = await until(
			() => d.handles(),
			(hs) => hs.some((h) => !before.has(h)),
			15_000,
			"panel tab",
		).then((hs) => hs.find((h) => !before.has(h)));
		assert.ok(handle);
		await d.switchTo(handle);
		const placed = await untilOk(
			() =>
				d.runAsync(
					`const me = await chrome.tabs.getCurrent();
				 const page = await chrome.tabs.get(arguments[0]);
				 return { url: me.url, index: me.index, active: me.active, highlighted: me.highlighted, pageIndex: page.index, pageHighlighted: page.highlighted };`,
					[articleId],
				),
			(v) => isRecord(v) && typeof v.url === "string",
			15_000,
			"panel tab info",
		);
		assert.ok(isRecord(placed), JSON.stringify(placed));
		assert.ok(String(placed.url).includes(`page=${articleId}`) && String(placed.url).includes(`session=${SID}`));
		assert.equal(placed.index, Number(placed.pageIndex) + 1, "right after the page");
		assert.equal(placed.active, true);
		assert.equal(placed.highlighted, true);
		assert.equal(placed.pageHighlighted, true, "both tabs selected, ready for Join 2 Tabs");
		// The sidebar closes after the move (here: the plain tab standing in for it), and its relay socket with it.
		await inChrome(
			d,
			`const w = Services.wm.getMostRecentWindow("navigator:browser"); const g = w.gBrowser;
			 const standIn = [...g.tabs].find((t) => { const s = t.linkedBrowser.currentURI.spec; return s.includes("sidepanel.html") && !s.includes("page="); });
			 if (standIn) g.removeTab(standIn); return !!standIn;`,
		);
		await untilOk(
			() => d.run(`return document.body?.innerText ?? ""`),
			(t) => typeof t === "string" && t.includes("ask away") && t.includes("Join 2 Tabs"),
			20_000,
			"moved chat and the join hint",
		);
		assert.equal(await d.run(`return document.querySelector("message-editor textarea")?.value ?? ""`), DRAFT);
		assert.ok(
			String(await d.run(`return document.querySelector("[data-sg-beside]")?.textContent ?? ""`)).includes(
				"Article",
			),
		);

		// Tom joins them (right-click → "Join 2 Tabs") and types in sitegeist.
		const joined = await inChrome(
			d,
			`${ZEN_TABS} w.gZenViewSplitter.splitTabs([find("/article"), find("sidepanel.html?page=")]);
				 g.selectedTab = find("sidepanel.html?page="); return w.gZenViewSplitter.splitViewActive;`,
		);
		assert.equal(joined, true);
		const selected = () => inChrome(d, `${ZEN_TABS} return g.selectedTab.linkedBrowser.currentURI.spec;`);
		const where = async (): Promise<unknown> =>
			JSON.parse(
				textOf(await relay.call("browser_eval", { code: "return document.title + '|' + location.pathname" })),
			);
		await until(
			async () => relay.openSockets(),
			(n) => n === 1,
			20_000,
			"one relay socket",
		);
		assert.equal(await where(), "Article|/article");
		assert.ok(String(await selected()).includes("sidepanel.html?page="), "the chat keeps the focus");
		const shot = imageOf(await relay.call("browser_screenshot"));
		assert.ok(shot, "screenshot");
		const pixel = await d.runAsync(
			`const img = await createImageBitmap(await (await fetch("data:image/png;base64," + arguments[0])).blob());
			 const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext("2d"); x.drawImage(img, 0, 0);
			 return Array.from(x.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data);`,
			[shot],
		);
		assert.ok(Array.isArray(pixel) && Number(pixel[0]) > 150 && Number(pixel[1]) < 60, `red page, got ${pixel}`);
		assert.ok(String(await selected()).includes("sidepanel.html?page="), "screenshot took no focus");

		// Tom clicks into the page half: same page. Tom goes to another tab: the panel is off screen, the tools stay
		// on the page beside it (and bring the split view back, so Tom can watch).
		await inChrome(d, `${ZEN_TABS} g.selectedTab = find("/article"); return true;`);
		assert.equal(await d.run("return document.visibilityState"), "visible", "both halves on screen");
		assert.equal(await where(), "Article|/article");
		await inChrome(d, `${ZEN_TABS} g.selectedTab = find("/other"); return true;`);
		await until(
			() => d.run("return document.visibilityState"),
			(v) => v === "hidden",
			10_000,
			"panel off screen",
		);
		assert.equal(await where(), "Article|/article", "the page beside the panel, not the tab Tom went to");
		assert.ok(String(await selected()).includes("/article"), "the split view came back to the front");
	} finally {
		await stop();
		relay.close();
	}
});
