/**
 * Browser-side handlers for prime's browser_* tools. The relay forwards a tool call over the
 * session's WebSocket; these run it with the extension's own powers (tabs, capture, user scripts,
 * cookies) and answer with an AgentToolResult-shaped { content, details }.
 */
import { CUSTOM_INSTRUCTIONS_SETTING } from "../sidepanel.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import { CUSTOM_INSTRUCTIONS_UPDATED_SETTING, pushInstructions } from "../sync.js";
import { AskUserWhichElementTool } from "../tools/ask-user-which-element.js";
import { skillTool } from "../tools/skill.js";
import type { Json } from "./prime-client.js";
import { isJson } from "./prime-client.js";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
export interface BrowserToolResult {
	content: Array<TextBlock | ImageBlock>;
	details?: unknown;
}

const text = (t: string): BrowserToolResult => ({ content: [{ type: "text", text: t }] });
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const USER_SCRIPT_WORLD = "sitegeist-prime";

async function resolveTab(tabId: number | undefined, windowId: number): Promise<chrome.tabs.Tab> {
	if (tabId !== undefined) return chrome.tabs.get(tabId);
	const [active] = await chrome.tabs.query({ active: true, windowId });
	if (active) return active;
	const [anyActive] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (anyActive) return anyActive;
	throw new Error("no active tab");
}

/**
 * Tom wants to see prime working (2026-09-05): every tab-acting tool brings its tab to the front unless
 * the caller passes background:true. The Browser agent always acted on the visible tab; this keeps that feel.
 */
async function bringToFront(tab: chrome.tabs.Tab, args: Json): Promise<void> {
	if (args.background === true) return;
	const id = tab.id;
	if (id === undefined) return;
	if (!tab.active) await chrome.tabs.update(id, { active: true }).catch(() => undefined);
	if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
}

function requireTabId(tab: chrome.tabs.Tab): number {
	if (tab.id === undefined) throw new Error("tab has no id");
	return tab.id;
}

async function listTabs(): Promise<BrowserToolResult> {
	const tabs = await chrome.tabs.query({});
	const rows = tabs
		.filter((t) => !(t.url ?? "").startsWith("chrome-extension://"))
		.map((t) => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title ?? "", url: t.url ?? "" }));
	const lines = rows.map((r) => `${r.id}\t${r.active ? "*" : " "}\t${r.title.slice(0, 80)}\t${r.url}`);
	return { content: [{ type: "text", text: `id\tactive\ttitle\turl\n${lines.join("\n")}` }], details: { tabs: rows } };
}

async function dataUrlToResized(dataUrl: string, maxWidth: number): Promise<ImageBlock> {
	const blob = await (await fetch(dataUrl)).blob();
	const bitmap = await createImageBitmap(blob);
	const scale = bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
	const width = Math.max(1, Math.round(bitmap.width * scale));
	const height = Math.max(1, Math.round(bitmap.height * scale));
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	ctx.drawImage(bitmap, 0, 0, width, height);
	const out = await canvas.convertToBlob({ type: "image/png" });
	const buf = new Uint8Array(await out.arrayBuffer());
	let binary = "";
	for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
	return { type: "image", data: btoa(binary), mimeType: "image/png" };
}

async function screenshot(args: Json, windowId: number): Promise<BrowserToolResult> {
	const tab = await resolveTab(num(args.tabId), windowId);
	const id = requireTabId(tab);
	if (!tab.active) await chrome.tabs.update(id, { active: true });
	if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
	await new Promise((r) => setTimeout(r, tab.active ? 50 : 350));
	const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId ?? windowId, { format: "png" });
	const image = await dataUrlToResized(dataUrl, Math.min(Math.max(num(args.maxWidth) ?? 1280, 200), 2560));
	return {
		content: [{ type: "text", text: `Screenshot of tab ${id}: ${tab.title ?? ""} — ${tab.url ?? ""}` }, image],
		details: { tabId: id, url: tab.url, title: tab.title },
	};
}

async function runUserScript(tabId: number, code: string): Promise<unknown> {
	try {
		await chrome.userScripts.configureWorld({ worldId: USER_SCRIPT_WORLD, messaging: false });
	} catch {
		// already configured
	}
	// chrome.userScripts.execute awaits a returned promise (same contract as scripting.executeScript)
	const injection: chrome.userScripts.UserScriptInjection = {
		js: [{ code }],
		target: { tabId, allFrames: false },
		world: "USER_SCRIPT",
		worldId: USER_SCRIPT_WORLD,
		injectImmediately: true,
	};
	const results = await chrome.userScripts.execute(injection);
	const first: unknown = Array.isArray(results) ? results[0] : undefined;
	if (isJson(first) && typeof first.error === "string") throw new Error(first.error);
	return isJson(first) ? first.result : undefined;
}

async function readPage(args: Json, windowId: number): Promise<BrowserToolResult> {
	const tab = await resolveTab(num(args.tabId), windowId);
	const id = requireTabId(tab);
	await bringToFront(tab, args);
	const mode = str(args.mode) ?? "text";
	const maxChars = Math.min(Math.max(num(args.maxChars) ?? 40_000, 1_000), 400_000);
	const code =
		mode === "html"
			? "document.documentElement.outerHTML"
			: mode === "links"
				? "Array.from(document.querySelectorAll('a[href]')).map(a => (a.textContent || '').trim().replace(/\\s+/g,' ').slice(0,120) + ' -> ' + a.href).join('\\n')"
				: "(document.body && document.body.innerText) || document.documentElement.innerText || ''";
	const raw = await runUserScript(id, code);
	const full = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
	const truncated = full.length > maxChars;
	const body = truncated
		? `${full.slice(0, maxChars)}\n\n[truncated: ${full.length} chars total, showing ${maxChars}]`
		: full;
	return {
		content: [{ type: "text", text: `${tab.title ?? ""} — ${tab.url ?? ""}\n\n${body}` }],
		details: { tabId: id, url: tab.url, title: tab.title, mode, chars: full.length, truncated },
	};
}

/** Browser calls that can be stopped mid-flight (agent abort / relay timeout), keyed by relay call id. */
const activeCalls = new Map<string, () => Promise<void>>();

export async function cancelBrowserCall(id: string): Promise<void> {
	const cancel = activeCalls.get(id);
	activeCalls.delete(id);
	if (cancel) await cancel().catch(() => undefined);
}

async function evalJs(args: Json, windowId: number, callId: string): Promise<BrowserToolResult> {
	const code = str(args.code);
	if (!code) return text("browser_eval: `code` is required");
	const tab = await resolveTab(num(args.tabId), windowId);
	const id = requireTabId(tab);
	await bringToFront(tab, args);
	const timeoutMs = Math.min(Math.max(num(args.timeoutMs) ?? 30_000, 1_000), 170_000);
	// Same as the Browser agent's browserjs(): matching site skills are injected ahead of the code.
	const skills = args.skills === false || !tab.url ? [] : await getSitegeistStorage().skills.getSkillsForUrl(tab.url);
	const skillLibrary = skills.map((sk) => sk.library).join("\n\n");
	// Body of an async function; the result is JSON-serialised in-page so odd objects cannot break the bridge.
	// Cancellation: `setTimeout` is shadowed inside the wrapper so every pending wait can be cleared when the
	// agent aborts or the relay times out (a poll loop that outlives its tool call kept re-searching Gmail,
	// 2026-09-05); `sleep(ms)` rejects and `signal.aborted` flips for code that wants to notice.
	const key = JSON.stringify(callId);
	const wrapped = `(async () => {
		const __c = { cancelled: false, timers: new Set() };
		(window.__sgEvalCancel = window.__sgEvalCancel || {})[${key}] = () => { __c.cancelled = true; for (const t of __c.timers) window.clearTimeout(t); __c.timers.clear(); };
		const setTimeout = (fn, ms, ...a) => { const t = window.setTimeout(fn, ms, ...a); __c.timers.add(t); return t; };
		const sleep = (ms) => new Promise((res, rej) => { if (__c.cancelled) return rej(new Error("cancelled")); const t = window.setTimeout(() => { __c.timers.delete(t); res(); }, ms); __c.timers.add(t); });
		const signal = { get aborted() { return __c.cancelled; } };
		try {
			${skillLibrary}
			const __r = await (async () => { ${code}\n })();
			try { return JSON.stringify(__r === undefined ? null : __r); } catch (e) { return JSON.stringify(String(__r)); }
		} finally { delete window.__sgEvalCancel[${key}]; }
	})()`;
	const cancelInPage = () =>
		runUserScript(id, `window.__sgEvalCancel?.[${key}]?.(); 'cancelled'`).then(() => undefined);
	activeCalls.set(callId, cancelInPage);
	let timedOut = false;
	try {
		const raw = await Promise.race([
			runUserScript(id, wrapped),
			new Promise<never>((_, reject) =>
				setTimeout(() => {
					timedOut = true;
					reject(new Error(`browser_eval timed out after ${timeoutMs} ms (the page script was stopped)`));
				}, timeoutMs),
			),
		]);
		const out = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
		const limited = out.length > 60_000 ? `${out.slice(0, 60_000)}\n[truncated: ${out.length} chars]` : out;
		const after = await chrome.tabs.get(id).catch(() => undefined);
		const navigated = after?.url !== undefined && after.url !== tab.url;
		const note =
			navigated && (raw === undefined || raw === null)
				? `\n[page navigated during the eval: ${tab.url ?? ""} → ${after.url}; the script's context was torn down so its result was lost — re-run against the new page]`
				: navigated
					? `\n[page navigated during the eval → ${after.url}]`
					: "";
		return {
			content: [{ type: "text", text: limited + note }],
			details: { tabId: id, url: after?.url ?? tab.url, navigated, skillsInjected: skills.map((sk) => sk.name) },
		};
	} finally {
		activeCalls.delete(callId);
		if (timedOut) await cancelInPage().catch(() => undefined);
	}
}

function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			chrome.tabs.onUpdated.removeListener(listener);
			clearTimeout(timer);
			resolve();
		};
		const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
			if (id === tabId && info.status === "complete") done();
		};
		const timer = setTimeout(done, timeoutMs);
		chrome.tabs.onUpdated.addListener(listener);
	});
}

async function navigate(args: Json, windowId: number): Promise<BrowserToolResult> {
	const url = str(args.url);
	if (!url || !/^https?:\/\//i.test(url)) return text("browser_navigate: `url` must be an http(s) URL");
	let tabId: number;
	if (args.newTab === true) {
		tabId = requireTabId(await chrome.tabs.create({ url, windowId, active: args.background !== true }));
	} else {
		const tab = await resolveTab(num(args.tabId), windowId);
		tabId = requireTabId(tab);
		await chrome.tabs.update(tabId, { url, active: args.background === true ? tab.active : true });
		if (args.background !== true && tab.windowId !== undefined)
			await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
	}
	await waitForLoad(tabId, 30_000);
	await new Promise((r) => setTimeout(r, 300));
	const after = await chrome.tabs.get(tabId);
	return {
		content: [{ type: "text", text: `Loaded tab ${tabId}: ${after.title ?? ""} — ${after.url ?? ""}` }],
		details: { tabId, url: after.url, title: after.title },
	};
}

function netscapeLine(c: chrome.cookies.Cookie): string {
	const domain = c.domain.startsWith(".") ? c.domain : c.hostOnly ? c.domain : `.${c.domain}`;
	const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
	const expires = c.expirationDate ? String(Math.floor(c.expirationDate)) : "0";
	return [domain, includeSubdomains, c.path, c.secure ? "TRUE" : "FALSE", expires, c.name, c.value].join("\t");
}

async function exportCookies(args: Json): Promise<BrowserToolResult> {
	const domain = (str(args.domain) ?? "").trim().replace(/^\./, "").toLowerCase();
	if (!/^[a-z0-9.-]+$/.test(domain)) return text("browser_cookies: `domain` is required (e.g. youtube.com)");
	if (!chrome.cookies)
		return text(
			"browser_cookies: the extension has no `cookies` permission — reload the unpacked extension so the new manifest applies",
		);
	const cookies = await chrome.cookies.getAll({ domain });
	const lines = [
		"# Netscape HTTP Cookie File",
		`# exported by sitegeist-dev for ${domain} at ${new Date().toISOString()}`,
		...cookies.map(netscapeLine),
	];
	// The cookie text travels only in `details` (relay -> prime extension -> 0600 file); the visible
	// result is the count, so values never land in the conversation.
	return {
		content: [{ type: "text", text: `${cookies.length} cookies for ${domain}` }],
		details: { netscape: `${lines.join("\n")}\n`, count: cookies.length, domain },
	};
}

const UPLOAD_CHUNK = 3_000_000; // base64 chars per userScripts.execute call

/** Put a file (bytes shipped from the R730) into a page: <input type=file> via DataTransfer, or a synthetic drop. */
async function uploadFile(args: Json, windowId: number): Promise<BrowserToolResult> {
	const dataBase64 = str(args.dataBase64);
	if (!dataBase64) return text("browser_upload_file: no file data received");
	const fileName = (str(args.fileName) ?? "upload.bin").replace(/[^\w.() -]/g, "_");
	const mimeType = str(args.mimeType) ?? "application/octet-stream";
	const selector = str(args.selector);
	const dropSelector = str(args.dropSelector);
	const tab = await resolveTab(num(args.tabId), windowId);
	const id = requireTabId(tab);
	await bringToFront(tab, args);
	// Stage the base64 in the page in chunks (one giant code string is slow to inject), then assemble.
	await runUserScript(id, "window.__sgUploadChunks = []; 'ok'");
	for (let i = 0; i < dataBase64.length; i += UPLOAD_CHUNK) {
		await runUserScript(
			id,
			`window.__sgUploadChunks.push(${JSON.stringify(dataBase64.slice(i, i + UPLOAD_CHUNK))}); window.__sgUploadChunks.length`,
		);
	}
	const code = `(async () => {
		const b64 = (window.__sgUploadChunks || []).join(""); delete window.__sgUploadChunks;
		const bin = atob(b64); const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const file = new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} });
		const dt = new DataTransfer(); dt.items.add(file);
		const describe = (el) => el ? (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.name ? "[name=" + el.name + "]" : "") + (el.getAttribute("aria-label") ? "[aria-label=" + el.getAttribute("aria-label") + "]" : "")) : null;
		let input = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "null"};
		if (input && !(input instanceof HTMLInputElement && input.type === "file")) return JSON.stringify({ ok: false, error: "selector did not match an <input type=file>: " + describe(input) });
		if (!input) {
			const dialog = document.querySelector('[role="dialog"]');
			const scope = dialog || document;
			input = scope.querySelector('input[type="file"]') || document.querySelector('input[type="file"]');
		}
		if (input) {
			input.files = dt.files;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			return JSON.stringify({ ok: true, method: "input", target: describe(input), bytes: file.size });
		}
		const target = ${dropSelector ? `document.querySelector(${JSON.stringify(dropSelector)})` : "(document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body)"};
		if (!target) return JSON.stringify({ ok: false, error: "no file input found and drop target selector matched nothing" });
		for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
		return JSON.stringify({ ok: true, method: "drop", target: describe(target), bytes: file.size });
	})()`;
	const raw = await runUserScript(id, code);
	let parsed: unknown;
	try {
		parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
	} catch {
		parsed = { ok: false, error: `unexpected page result: ${String(raw).slice(0, 200)}` };
	}
	if (!isJson(parsed)) return text("browser_upload_file: unexpected page result");
	if (parsed.ok !== true) return text(`browser_upload_file failed: ${str(parsed.error) ?? "unknown error"}`);
	return {
		content: [
			{
				type: "text",
				text: `Attached ${fileName} (${String(parsed.bytes)} bytes, ${mimeType}) in tab ${id} via ${String(parsed.method)} → ${String(parsed.target)}. Verify the page picked it up (e.g. attachment chip visible) before relying on it.`,
			},
		],
		details: { tabId: id, url: tab.url, method: parsed.method, target: parsed.target, bytes: parsed.bytes },
	};
}

/** Sitegeist's own element picker (overlay in the tab; Tom clicks; abort after timeoutMs). */
async function pickElement(args: Json, windowId: number, callId: string): Promise<BrowserToolResult> {
	const tab = await resolveTab(num(args.tabId), windowId);
	const id = requireTabId(tab);
	// The picker injects into the active tab of the panel's window: make sure that is this tab and that
	// the window is in front, otherwise the overlay waits on a page Tom is not looking at.
	if (!tab.active) await chrome.tabs.update(id, { active: true });
	if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
	const controller = new AbortController();
	const timeoutMs = Math.min(Math.max(num(args.timeoutMs) ?? 120_000, 5_000), 175_000);
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const where = `tab ${id} "${tab.title ?? ""}" ${tab.url ?? ""}`;
	try {
		const result = await new AskUserWhichElementTool().execute(
			"prime",
			{ message: str(args.message) },
			controller.signal,
		);
		return {
			content: [{ type: "text", text: `Tom picked an element on ${where}:\n` }, ...result.content],
			details: { tabId: id, url: tab.url, element: result.details },
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (controller.signal.aborted) {
			return text(
				`browser_pick_element: no element was picked within ${Math.round(timeoutMs / 1000)} s (picker overlay was shown on ${where}; ask Tom whether he saw the banner, or retry with the right tabId).`,
			);
		}
		return text(`browser_pick_element failed on ${where}: ${message}`);
	} finally {
		clearTimeout(timer);
		activeCalls.delete(callId);
	}
}

/** The Browser agent's own skill tool (create/update/list/get/delete site skills; the store syncs to the R730). */
async function manageSkill(args: Json): Promise<BrowserToolResult> {
	// skillTool validates/uses the fields it knows; the schema is mirrored on the prime side.
	const result = await skillTool.execute("prime", args as Parameters<typeof skillTool.execute>[1]);
	return { content: result.content, details: result.details };
}

/** Custom instructions = the user-editable part of sitegeist's system prompt (Settings → Instructions); synced. */
async function manageInstructions(args: Json): Promise<BrowserToolResult> {
	const settings = getSitegeistStorage().settings;
	const current = ((await settings.get<string>(CUSTOM_INSTRUCTIONS_SETTING)) ?? "").trim();
	if (args.command === "get")
		return {
			content: [{ type: "text", text: current || "(no custom instructions set)" }],
			details: { text: current },
		};
	if (args.command === "set") {
		const next = (str(args.text) ?? "").trim();
		if (next === current) return text("Custom instructions unchanged.");
		await settings.set(CUSTOM_INSTRUCTIONS_SETTING, next);
		const updatedAt = new Date().toISOString();
		await settings.set(CUSTOM_INSTRUCTIONS_UPDATED_SETTING, updatedAt);
		await pushInstructions(next, updatedAt);
		return {
			content: [
				{
					type: "text",
					text: `Custom instructions saved (${next.length} chars) and synced; the Browser agent sees them on its next new or reopened session.`,
				},
			],
			details: { chars: next.length, updatedAt },
		};
	}
	return text("browser_instructions: command must be get or set");
}

export async function handleBrowserCall(
	tool: string,
	args: Json,
	windowId: number,
	callId: string,
): Promise<BrowserToolResult> {
	switch (tool) {
		case "browser_tabs":
			return listTabs();
		case "browser_screenshot":
			return screenshot(args, windowId);
		case "browser_page":
			return readPage(args, windowId);
		case "browser_eval":
			return evalJs(args, windowId, callId);
		case "browser_navigate":
			return navigate(args, windowId);
		case "browser_cookies":
			return exportCookies(args);
		case "browser_upload_file":
			return uploadFile(args, windowId);
		case "browser_pick_element":
			return pickElement(args, windowId, callId);
		case "browser_skill":
			return manageSkill(args);
		case "browser_instructions":
			return manageInstructions(args);
		default:
			return text(`unknown browser tool: ${tool}`);
	}
}
