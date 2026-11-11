/**
 * Boot loader for sidepanel.html (a classic script; the app bundle sidepanel.js is ~13 MB).
 *
 * Tom 2026-11-11: after a reinstall the sitegeist sidebar in Zen stayed black. On his laptop every Zen window loads
 * the panel at once and the browser intermittently failed to parse the bundle (random SyntaxErrors) or the add-on
 * process crashed (the machine faults under bursts of load: see the omarchy hardware page). A failed module script
 * draws nothing, so the panel was black with no text.
 *
 * So: show "Loading" at once; let one panel document at a time load the bundle (a Web Lock shared by every window's
 * panel, so they do not all parse 13 MB together); retry a failed load that never started running; and if it still
 * fails, show the error with a Reload button instead of a blank panel.
 */
import { showBootError, showBootLoading } from "./boot/boot-error.js";

// globalThis.__sitegeistAppStarted is set by the bundle's first module (src/boot/app-started.ts): from then on a
// failure is the app's own and is not retried.
import "./boot/app-started-type.js";

const LOCK = "sitegeist-boot";
const LOCK_WAIT_MS = 20_000;
const TRIES = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function loadOnce(attempt: number): Promise<void> {
	// A URL built at run time, so the bundler leaves sidepanel.js out of boot.js; a fresh URL per retry, because a
	// module that failed to parse stays failed under its URL.
	const url = chrome.runtime.getURL(attempt === 1 ? "sidepanel.js" : `sidepanel.js?try=${attempt}`);
	await import(url);
}

/** Runs the load holding the boot lock; waits at most LOCK_WAIT_MS for it, then loads anyway. */
async function withBootLock(load: () => Promise<void>): Promise<void> {
	const locks = navigator.locks;
	if (!locks) return load();
	const gaveUp = new AbortController();
	const timer = setTimeout(() => gaveUp.abort(), LOCK_WAIT_MS);
	let ran = false;
	try {
		await locks.request(LOCK, { signal: gaveUp.signal }, async () => {
			clearTimeout(timer);
			ran = true;
			await load();
		});
	} catch (err) {
		if (ran) throw err; // the load itself failed
		console.warn("[boot] no boot lock after", LOCK_WAIT_MS, "ms; loading without it", err);
		await load();
	} finally {
		clearTimeout(timer);
	}
}

async function boot(): Promise<void> {
	showBootLoading("Loading sitegeist…");
	let lastError: unknown;
	for (let attempt = 1; attempt <= TRIES; attempt++) {
		try {
			await withBootLock(() => loadOnce(attempt));
			return;
		} catch (err) {
			lastError = err;
			console.error(`[boot] loading sidepanel.js failed (try ${attempt} of ${TRIES})`, err);
			if (globalThis.__sitegeistAppStarted) break; // it ran and then threw: a retry would start it twice
			if (attempt < TRIES) {
				showBootLoading(`Loading sitegeist… (try ${attempt + 1} of ${TRIES})`);
				await sleep(300 + Math.random() * 1200);
			}
		}
	}
	showBootError("sitegeist could not load", lastError);
}

void boot();
