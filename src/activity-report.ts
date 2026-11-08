/**
 * Browser-mode activity reports (2026-11-08, Tom: the Agents widget did not show an in-browser chat).
 *
 * Worker-backed chats are reported by the cors-proxy relay itself. A browser-mode chat runs its loop in this
 * panel and only calls models through /upstream, so the relay cannot see turns: the panel reports them here.
 * POST <sync base>/activity { sessionId, event, prompt?, where?, outcome?, error? } with the proxy token; the
 * relay forwards to the Telegram router's activity table. Best effort: never throws, never blocks a turn.
 */
import { DEFAULT_SYNC_URL, proxyToken, SYNC_URL_SETTING } from "./sync.js";
import { getSitegeistStorage } from "./storage/app-storage.js";

const HEARTBEAT_MS = 60_000;
const TIMEOUT_MS = 5000;
const CONTEXT_RE = /^\[sitegeist browser context\][\s\S]*?(?:\[\/sitegeist browser context\]|\n\n)\s*/;
const ATTACHMENTS_RE = /\[sitegeist attachments\][\s\S]*?\[\/sitegeist attachments\]\s*/g;

export type ActivityEvent = "started" | "heartbeat" | "ended";
export interface ActivityPayload {
	sessionId: string;
	event: ActivityEvent;
	prompt?: string;
	where?: string;
	outcome?: "done" | "failed" | "stopped";
	error?: string;
}

/** The text Tom typed, without the panel's context preamble / attachments block, on one line. */
export function promptForActivity(text: string): string {
	const t = text.replace(CONTEXT_RE, "").replace(ATTACHMENTS_RE, "").replace(/\s+/g, " ").trim();
	return t ? t.slice(0, 400) : "(attachment)";
}

async function post(payload: ActivityPayload): Promise<void> {
	try {
		const token = await proxyToken();
		if (!token) return;
		const sync = ((await getSitegeistStorage().settings.get<string>(SYNC_URL_SETTING)) ?? DEFAULT_SYNC_URL).trim();
		if (!sync) return;
		await fetch(`${sync.replace(/\/$/, "")}/activity`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		console.debug("[activity] report failed", payload.event, err);
	}
}

/** One per panel: tracks the running browser-mode turn and reports start / heartbeat / end. */
export class BrowserActivityReporter {
	private running: { sessionId: string; timer: ReturnType<typeof setInterval> } | undefined;

	started(sessionId: string, prompt: string, where: string): void {
		this.stopTimer();
		const timer = setInterval(() => void post({ sessionId, event: "heartbeat" }), HEARTBEAT_MS);
		this.running = { sessionId, timer };
		void post({ sessionId, event: "started", prompt: promptForActivity(prompt), where });
	}

	ended(outcome: "done" | "failed" | "stopped", where: string, error?: string): void {
		const run = this.running;
		if (!run) return;
		this.stopTimer();
		void post({ sessionId: run.sessionId, event: "ended", outcome, where, ...(error ? { error: error.slice(0, 400) } : {}) });
	}

	private stopTimer(): void {
		if (this.running) clearInterval(this.running.timer);
		this.running = undefined;
	}
}
