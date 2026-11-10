/**
 * The REAL side panel (Tom, 2026-11-10: "It opens a new tab successfully, but then loads a new sitegeist session").
 * Jennifer opened a page in a new tab from an R730 chat in Tom's Edge 156; the panel fell to a blank "Pick an agent"
 * chat, her browser_navigate got no answer for 60 s, and her browser tools were gone. Cause: Edge 156 reloads a side
 * panel whose address is not its start address on every tab switch (src/utils/panel-place.ts).
 *
 * Runs in each browser that is installed: Edge 156.0.4314.50 (the one with the reload), Edge 157, and Playwright's
 * Chrome for Testing. In each: an R730 chat is open in the side panel and a turn is running; the agent opens a new
 * active tab; the call answers at once, the panel is the same document on the same chat with its relay socket, and
 * stays so through more tab switches. Then the safety net: the panel is sent to its start address by hand (what a
 * browser reload does) and comes back on the same chat.
 *
 * Browsers: SIDE_PANEL_BROWSERS (paths, comma separated), else ~/.cache/sitegeist-edge-test/root{156,}/opt/microsoft/
 * msedge/msedge (dpkg-deb -x of microsoft-edge-stable_<version>-1_amd64.deb from packages.microsoft.com) and
 * ~/.cache/ms-playwright/chromium-<n>/chrome-linux64/chrome. Skipped when none is there.
 * Run: npm run build:chrome && npm run test:side-panel:extension
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { seededPrimeSession, startStandInRelay } from "./prime-relay.fixture.ts";
import { launchWithSidePanel, sleep } from "./side-panel-cdp.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const EXTENSION_ID = "oinkecmkedjjomenbjealdcgbaipaadb"; // fixed by the manifest key
const SID = "sg-4e4e4e4e4e4e";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function browsers(): string[] {
	const named = (process.env.SIDE_PANEL_BROWSERS ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	if (named.length > 0) return named;
	const edge = join(homedir(), ".cache", "sitegeist-edge-test");
	const playwright = join(homedir(), ".cache", "ms-playwright");
	const chromes = existsSync(playwright)
		? readdirSync(playwright)
				.filter((d) => /^chromium-\d+$/.test(d))
				.sort()
				.map((d) => join(playwright, d, "chrome-linux64", "chrome"))
		: [];
	return [
		join(edge, "root156", "opt", "microsoft", "msedge", "msedge"),
		join(edge, "root", "opt", "microsoft", "msedge", "msedge"),
		...chromes.slice(-1),
	].filter((p) => existsSync(p));
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	for (;;) {
		try {
			last = await read();
			if (ok(last)) return last;
		} catch {
			/* the panel is mid-load */
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
		await sleep(150);
	}
}

const found = browsers();
if (found.length === 0) test("side panel: no browser installed", { skip: true }, () => undefined);

for (const bin of found) {
	test(
		`side panel keeps its chat when the agent opens a tab (${bin.replace(homedir(), "~")})`,
		{ timeout: 90_000 },
		async () => {
			const site = createServer((req, res) => {
				res.setHeader("content-type", "text/html");
				res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1>`);
			});
			await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
			const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`; // listen(0) on TCP: always an AddressInfo
			const seeded = seededPrimeSession(SID, "Side panel");
			const relay = await startStandInRelay(SID, seeded.messages);
			const b = await launchWithSidePanel(bin, dist, EXTENSION_ID);
			try {
				const first = await b.inWorker(
					`chrome.tabs.query({}).then(async (ts) => { const t = await chrome.tabs.update(ts[0].id, { url: ${JSON.stringify(`${base}/life`)} }); return { id: t.id, windowId: t.windowId }; })`,
				);
				assert.ok(isRecord(first) && typeof first.id === "number" && typeof first.windowId === "number");
				const firstTab = first.id;
				await sleep(500);
				await b.openSidePanel(first.windowId);
				// The userScripts permission dialog comes first on every load of a fresh profile; Tom's browser has the permission.
				const dismiss = () =>
					b
						.inPanel(
							`document.querySelector("userscripts-permission-dialog")?.dispatchEvent(new Event("close")); 1`,
						)
						.catch(() => undefined);
				/** Address query, the footer's chat id, whether this is still the marked document. */
				const panel = async (): Promise<{ search: string; chat: string; marked: boolean }> => {
					await dismiss();
					const v = await b.inPanel(
						`({ search: location.search + location.hash, chat: (document.body.innerText.match(/sg-[0-9a-f]{12}|new session/g) ?? []).pop() ?? "", marked: window.__sameDocument === true })`,
					);
					assert.ok(isRecord(v) && typeof v.search === "string" && typeof v.chat === "string");
					return { search: v.search, chat: v.chat, marked: v.marked === true };
				};
				const onChat = (p: { search: string; chat: string }) =>
					p.chat === SID && p.search === "" && relay.openSockets() === 1;
				await until(
					async () => {
						await dismiss();
						return b.inPanel(`document.querySelector("sessions-sidebar") !== null`);
					},
					(v) => v === true,
					30_000,
					"panel loaded",
				);
				await b.inPanel(`(async () => { const [data, metadata, syncUrl] = ${JSON.stringify([seeded.data, seeded.metadata, `${relay.base}/sitegeist`])};
				const db = await new Promise((res, rej) => { const q = indexedDB.open("sitegeist-storage"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
				await new Promise((res, rej) => { const tx = db.transaction(["sessions", "sessions-metadata", "settings"], "readwrite"); tx.objectStore("sessions").put(data); tx.objectStore("sessions-metadata").put(metadata); tx.objectStore("settings").put(syncUrl, "sync.url"); tx.objectStore("settings").put("test-token", "sync.token"); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
				db.close(); return 1; })()`);
				// A click on the chat in the sessions list is this navigation.
				await b.inPanel(`void (location.href = "sidepanel.html?session=${SID}")`).catch(() => undefined);

				// 1. the chat is open, its relay socket is up, and the side panel's address is its bare start address
				await until(panel, onChat, 30_000, "chat open in the side panel, address bare");
				await b.inPanel(`window.__sameDocument = true; 1`);

				// 2. a turn runs; the agent opens a page in a new tab (active, as browser_navigate does from a side panel)
				relay.startTurn();
				await sleep(400);
				const t0 = Date.now();
				const opened = await relay.call("browser_navigate", { url: `${base}/isla`, newTab: true });
				const ms = Date.now() - t0;
				const agentTab = isRecord(opened) && isRecord(opened.details) ? opened.details.tabId : undefined;
				assert.equal(typeof agentTab, "number", "browser_navigate answered with the new tab");
				assert.ok(ms < 10_000, `the call answered promptly (${ms} ms)`);
				assert.equal(
					await b.inWorker(`chrome.tabs.get(${String(agentTab)}).then((t) => t.active)`),
					true,
					"the new tab is in front",
				);
				await sleep(2500); // Edge 156 reloaded the panel within this time
				const after = await panel();
				assert.ok(after.marked, "the panel was not reloaded when the new tab came to the front");
				assert.ok(
					onChat(after),
					`still on the chat with its socket (${JSON.stringify(after)}, sockets ${relay.openSockets()})`,
				);
				// the browser tools still answer, on the agent's tab
				const tabs = await relay.call("browser_tabs", { query: "isla" });
				assert.ok(JSON.stringify(tabs).includes("/isla"), "browser_tabs answers after the new tab");

				// 3. Tom goes back to his page and to the agent's tab again: same document, same chat
				for (const id of [firstTab, agentTab, firstTab]) {
					await b.inWorker(`chrome.tabs.update(${String(id)}, { active: true }).then(() => 1)`);
					await sleep(1500);
					const p = await panel();
					assert.ok(p.marked && onChat(p), `tab switch kept the panel (${JSON.stringify(p)})`);
				}

				// 4. safety net: the browser reloads the panel at its start address anyway -> back on the same chat
				await b.inPanel(`void (location.href = "sidepanel.html")`).catch(() => undefined);
				const back = await until(panel, (p) => !p.marked && onChat(p), 30_000, "reloaded panel back on the chat");
				assert.equal(back.chat, SID);
				assert.ok(
					JSON.stringify(await relay.call("browser_tabs", { query: "life" })).includes("/life"),
					"tools answer after the reload",
				);
				console.log(`${b.product}: new tab answered in ${ms} ms; panel kept its chat; a reload came back to it`);
			} finally {
				await b.close();
				relay.close();
				site.close();
			}
		},
	);
}
