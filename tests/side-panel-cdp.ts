/**
 * A real Chrome / Edge side panel for tests: the browser is started headless with the extension and driven over the
 * DevTools protocol on a debugging port. Playwright cannot do this part: it has no handle on a side panel, and
 * sidePanel.open needs a user gesture (given here to an extension page through Runtime.evaluate userGesture).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface Target {
	targetId: string;
	type: string;
	url: string;
}

export interface SidePanelBrowser {
	/** "Edg/156.0.4314.50", "Chrome/151.0.7922.34" */
	product: string;
	extensionId: string;
	targets(): Promise<Target[]>;
	/** Evaluates in the extension's service worker. */
	inWorker(expression: string): Promise<unknown>;
	/** Evaluates in the side panel's document (the current one: the panel may have been reloaded). */
	inPanel(expression: string): Promise<unknown>;
	/** Opens the side panel in this window (sidePanel.open with a user gesture). */
	openSidePanel(windowId: number): Promise<void>;
	close(): Promise<void>;
}

/** Starts the browser at `bin` with the unpacked extension in `dist`. */
export async function launchWithSidePanel(bin: string, dist: string, extensionId: string): Promise<SidePanelBrowser> {
	const dir = mkdtempSync(join(tmpdir(), "sitegeist-side-panel-"));
	const port = 9300 + Math.floor(Math.random() * 500);
	const proc: ChildProcess = spawn(
		bin,
		[
			"--headless=new",
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${dir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-features=DisableLoadExtensionCommandLineSwitch",
			`--disable-extensions-except=${dist}`,
			`--load-extension=${dist}`,
			"--window-size=1300,900",
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	const stop = async (): Promise<void> => {
		proc.kill("SIGKILL");
		await sleep(300);
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	};
	let wsUrl = "";
	let product = "";
	for (let i = 0; i < 80 && !wsUrl; i++) {
		try {
			const info: unknown = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
			if (isRecord(info) && typeof info.webSocketDebuggerUrl === "string") {
				wsUrl = info.webSocketDebuggerUrl;
				product = typeof info.Browser === "string" ? info.Browser : "";
			}
		} catch {
			await sleep(150);
		}
	}
	if (!wsUrl) {
		await stop();
		throw new Error(`${bin}: no DevTools endpoint on port ${port}`);
	}
	const ws = new WebSocket(wsUrl);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("DevTools socket failed"));
	});
	let seq = 0;
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	ws.onmessage = (event) => {
		const msg: unknown = JSON.parse(String(event.data));
		if (!isRecord(msg) || typeof msg.id !== "number") return;
		const waiter = pending.get(msg.id);
		if (!waiter) return;
		pending.delete(msg.id);
		if (msg.error !== undefined) waiter.reject(new Error(JSON.stringify(msg.error).slice(0, 300)));
		else waiter.resolve(msg.result);
	};
	const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const id = ++seq;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			setTimeout(() => {
				if (pending.delete(id)) reject(new Error(`${method} got no answer in 20 s`));
			}, 20_000);
		});
	const targets = async (): Promise<Target[]> => {
		const r = await send("Target.getTargets");
		const list = isRecord(r) && Array.isArray(r.targetInfos) ? r.targetInfos : [];
		return list.flatMap((t) =>
			isRecord(t) && typeof t.targetId === "string" && typeof t.type === "string" && typeof t.url === "string"
				? [{ targetId: t.targetId, type: t.type, url: t.url }]
				: [],
		);
	};
	const evaluate = async (targetId: string, expression: string, userGesture = false): Promise<unknown> => {
		const attached = await send("Target.attachToTarget", { targetId, flatten: true });
		const sessionId = isRecord(attached) && typeof attached.sessionId === "string" ? attached.sessionId : "";
		const r = await send(
			"Runtime.evaluate",
			{ expression, awaitPromise: true, returnByValue: true, userGesture },
			sessionId,
		);
		await send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
		if (!isRecord(r)) throw new Error("Runtime.evaluate: no result");
		if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
		return isRecord(r.result) ? r.result.value : undefined;
	};
	const find = async (what: string, match: (t: Target) => boolean, timeoutMs: number): Promise<Target> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const hit = (await targets()).find(match);
			if (hit) return hit;
			if (Date.now() > deadline) throw new Error(`no ${what} target`);
			await sleep(150);
		}
	};
	try {
		const worker = await find(
			"service worker",
			(t) => t.type === "service_worker" && t.url.includes(extensionId),
			15_000,
		);
		// The worker target exists before its script has run.
		for (let i = 0; i < 40; i++) {
			if ((await evaluate(worker.targetId, "typeof chrome").catch(() => "")) === "object") break;
			await sleep(150);
		}
		const panel = (): Promise<Target> => find("side panel", (t) => t.url.includes("/sidepanel.html"), 10_000);
		return {
			product,
			extensionId,
			targets,
			inWorker: (expression) => evaluate(worker.targetId, expression),
			inPanel: async (expression) => evaluate((await panel()).targetId, expression),
			openSidePanel: async (windowId) => {
				const created = await send("Target.createTarget", { url: `chrome-extension://${extensionId}/debug.html` });
				const helper = isRecord(created) && typeof created.targetId === "string" ? created.targetId : "";
				await sleep(1200);
				const answer = await evaluate(
					helper,
					`chrome.sidePanel.open({ windowId: ${windowId} }).then(() => "opened", (e) => "failed: " + e.message)`,
					true,
				);
				await send("Target.closeTarget", { targetId: helper });
				if (answer !== "opened") throw new Error(`sidePanel.open ${String(answer)}`);
				await panel();
			},
			close: async () => {
				await send("Browser.close").catch(() => undefined);
				ws.close();
				await stop();
			},
		};
	} catch (err) {
		ws.close();
		await stop();
		throw err;
	}
}
