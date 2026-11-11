/**
 * How the sitegeist panel starts in REAL Zen (Tom 2026-11-11: after a reinstall the sidebar stayed black; the
 * permission dialog he had to answer was in another Zen window's panel).
 * 1. Two panels both ask for the userScripts permission; "Grant Permission" in one releases the other.
 * 2. Four panels opened at the same moment all reach the app (the boot loader lets one at a time load sidepanel.js).
 * 3. A build whose sidepanel.js does not parse shows the error and a Reload button after its retries, never a blank panel.
 * Run: npm run build:firefox && npm run test:boot:extension (ZEN_BIN=… for another Zen build; see zen-driver.fixture.ts)
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BASE, type Driver, dist, skip, startZen, until } from "./zen-driver.fixture.ts";

/** What a panel tab shows: the app's top bar, the permission dialog, the boot error, or still loading. */
const PANEL_STATE = `const t = document.body?.innerText ?? "";
	if (document.querySelector("[data-boot-error]")) return "error:" + t.replace(/\\s+/g, " ").slice(0, 200);
	if (t.includes("Grant Permission")) return "permission";
	if (t.includes("Pick an agent") || document.querySelector('button[title="Sessions"]')) return "app";
	return "loading:" + t.replace(/\\s+/g, " ").slice(0, 80);`;

async function stateOf(d: Driver, handle: string): Promise<string> {
	await d.switchTo(handle);
	const v = await d.run(PANEL_STATE);
	return typeof v === "string" ? v : "?";
}

/** Opens several panel tabs from one chrome-context call, so they all start loading at the same moment. */
async function openPanelsAtOnce(d: Driver, n: number): Promise<string[]> {
	const before = new Set(await d.handles());
	await d.context("chrome");
	await d.run(
		`const w = Services.wm.getMostRecentWindow("navigator:browser");
		 for (let i = 0; i < arguments[1]; i++) w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
		[`${BASE}/sidepanel.html`, n],
	);
	await d.context("content");
	const all = await until(
		() => d.handles(),
		(hs) => hs.filter((h) => !before.has(h)).length >= n,
		10_000,
		`${n} new tabs`,
	);
	return all.filter((h) => !before.has(h));
}

test("Zen panel start: a grant in one panel releases the other; four panels at once all load", { skip }, async () => {
	const { d, stop } = await startZen();
	try {
		// 1. two panels, both waiting on the permission dialog (fresh install: no userScripts yet)
		const a = await d.openTab(`${BASE}/sidepanel.html`);
		const b = await d.openTab(`${BASE}/sidepanel.html`);
		for (const h of [a, b]) {
			await until(
				() => stateOf(d, h),
				(s) => s === "permission",
				30_000,
				"permission dialog in both panels",
			);
		}
		await d.switchTo(a);
		await d.click("xpath", "//button[normalize-space(.)='Grant Permission']");
		await until(
			() => stateOf(d, a),
			(s) => s === "app",
			30_000,
			"panel A reaches the app after its grant",
		);
		// B was never clicked: the grant in A must close its dialog, and B must then have the API itself
		await until(
			() => stateOf(d, b),
			(s) => s === "app",
			30_000,
			"panel B released by the grant in panel A",
		);
		await d.switchTo(b);
		assert.equal(await d.run("return typeof chrome.userScripts?.register;"), "function", "panel B has userScripts");

		// 2. four panels at the same moment
		const four = await openPanelsAtOnce(d, 4);
		for (const h of four) {
			await until(
				() => stateOf(d, h),
				(s) => s === "app",
				60_000,
				"every one of four panels reaches the app",
			);
		}
	} finally {
		await stop();
	}
});

test("Zen panel start: a sidepanel.js that does not parse shows the error and a Reload button", { skip }, async () => {
	const broken = mkdtempSync(join(tmpdir(), "sitegeist-broken-"));
	cpSync(dist, broken, { recursive: true });
	writeFileSync(join(broken, "sidepanel.js"), "export const x = ;\n");
	const { d, stop } = await startZen({ dist: broken });
	try {
		const h = await d.openTab(`${BASE}/sidepanel.html`);
		const shown = await until(
			() => stateOf(d, h),
			(s) => s.startsWith("error:"),
			30_000,
			"boot error view",
		);
		assert.match(shown, /could not load/);
		assert.match(shown, /SyntaxError/);
		assert.match(shown, /Reload/);
	} finally {
		await stop();
	}
});
