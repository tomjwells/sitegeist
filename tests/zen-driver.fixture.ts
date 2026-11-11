/**
 * Real Zen (headless) driven through geckodriver's W3C WebDriver HTTP API (no Selenium): the client and the
 * install-the-build start shared by the Firefox / Zen extension tests. See tests/firefox-extension.test.ts for setup.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const dist = join(root, "dist-firefox");
export const cache = join(homedir(), ".cache", "sitegeist-firefox-test");
/** ZEN_BIN picks another Zen build (e.g. ~/.cache/sitegeist-firefox-test/zen-1.24.1b/zen/zen). */
export const zen = process.env.ZEN_BIN || join(cache, "zen", "zen");
export const geckodriver = join(cache, "geckodriver");
export const EXT_ID = "sitegeist-dev@tjw-private";
export const EXT_UUID = "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
export const BASE = `moz-extension://${EXT_UUID}`;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(
	read: () => Promise<T>,
	ok: (v: T) => boolean,
	timeoutMs: number,
	what: string,
): Promise<T> {
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
export class Driver {
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
	async handle(): Promise<string> {
		const v = await this.cmd("GET", this.s("/window"));
		if (typeof v !== "string") throw new Error("no window handle");
		return v;
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
	/** A real key press (WebDriver key actions, e.g. "\uE00C" = Escape) in the current window. */
	async press(key: string): Promise<void> {
		await this.cmd("POST", this.s("/actions"), {
			actions: [
				{
					type: "key",
					id: "keyboard",
					actions: [
						{ type: "keyDown", value: key },
						{ type: "keyUp", value: key },
					],
				},
			],
		});
		// The key may close the window (Escape in the fullscreen window): then there is nothing left to release.
		await this.cmd("DELETE", this.s("/actions")).catch(() => undefined);
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

export const skip =
	!existsSync(zen) || !existsSync(geckodriver)
		? `Zen/geckodriver not cached in ${cache} (zen/zen + geckodriver); see the header of this file`
		: !existsSync(join(dist, "manifest.json"))
			? "dist-firefox not built (npm run build:firefox)"
			: false;

/** geckodriver + headless Zen with the unsigned build installed permanently, as Tom has it after the one-time setup. */
export async function startZen(opts: { dist?: string } = {}): Promise<{ d: Driver; stop: () => Promise<void> }> {
	const work = mkdtempSync(join(tmpdir(), "sitegeist-zen-"));
	const xpi = join(work, "sitegeist.xpi");
	execFileSync("zip", ["-qr", "-X", xpi, ".", "-x", "*.map"], { cwd: opts.dist ?? dist });
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

/**
 * Firefox opens a new add-on's sidebar once on install. Tests that stand a plain tab in for the sidebar close it, or
 * that real sidebar panel loads too (since 2026-11-11 a grant in another panel releases its permission dialog) and
 * counts as a second panel, e.g. a second relay socket.
 */
export async function closeInstallSidebar(d: Driver): Promise<void> {
	await d.context("chrome");
	try {
		const open = () =>
			d.run(`return Services.wm.getMostRecentWindow("navigator:browser").SidebarController.isOpen === true;`);
		await until(open, (v) => v === true, 15_000, "the sidebar Firefox opens on install");
		await d.run(`Services.wm.getMostRecentWindow("navigator:browser").SidebarController.hide(); return true;`);
		await until(open, (v) => v === false, 10_000, "install sidebar closed");
	} finally {
		await d.context("content");
	}
}
