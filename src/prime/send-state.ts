/**
 * The panel's own record of a send on a user message. A message Tom sends is shown at once; this says whether the
 * R730 has it yet. "sending": the POST is in flight. "failed": it did not get through (no connection, timeout,
 * relay error) and waits for a retry, automatic when the live connection comes back or by hand. A message with no
 * record was accepted by the R730. The record is a plain field on the message (`sgSend`), so a failed message
 * survives a panel reload with its state (2026-10-18, Tom on a train: a copy of his message that never left the
 * browser looked exactly like a sent one, and nothing offered a retry).
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface SendState {
	/** The panel's id for this send; a retry repeats it and the relay answers duplicate:true instead of a second prompt. */
	id: string;
	/**
	 * "queued": the R730 has it in its follow-up queue (sent with Queue / Alt+Enter while a turn ran); it runs when
	 * the current turn ends, and the bubble stays at the bottom of the chat until then (Tom, 2026-10-25).
	 */
	state: "sending" | "failed" | "queued";
	/** "followUp": sent with Queue / Alt+Enter - waits for the turn to end instead of steering it. */
	mode?: "followUp";
	/** Why the last attempt failed, short, for the bubble. */
	error?: string;
	/** When the last attempt started (ms since epoch). */
	at: number;
}

const SEND_FIELD = "sgSend";

export function sendStateOf(message: unknown): SendState | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const raw: unknown = (message as Record<string, unknown>)[SEND_FIELD];
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || (r.state !== "sending" && r.state !== "failed" && r.state !== "queued"))
		return undefined;
	return {
		id: r.id,
		state: r.state,
		at: typeof r.at === "number" ? r.at : 0,
		...(typeof r.error === "string" && r.error ? { error: r.error } : {}),
		...(r.mode === "followUp" ? { mode: "followUp" as const } : {}),
	};
}

/** A copy of the message with the send record set, or (undefined) removed. Always a new object, so Lit re-renders it. */
export function withSendState(message: AgentMessage, state: SendState | undefined): AgentMessage {
	const copy: Record<string, unknown> = Object.fromEntries(Object.entries(message));
	if (state) copy[SEND_FIELD] = state;
	else delete copy[SEND_FIELD];
	return copy as AgentMessage; // the same shape as `message`: only the panel's own field changed
}

/** In flight or failed: the R730 does not have it yet. */
export const isUnsent = (message: AgentMessage): boolean => {
	const s = sendStateOf(message)?.state;
	return s === "sending" || s === "failed";
};

/** In the R730's follow-up queue: runs when the current turn ends. */
export const isQueued = (message: AgentMessage): boolean => sendStateOf(message)?.state === "queued";

/**
 * Queue (Alt+Enter or the Queue button) instead of steer: the editor marks the send it is about to make, and
 * PrimeRemoteAgent.prompt() takes the mark. The mark only counts for a moment, so a send that never happened (empty
 * text) cannot turn a later Enter into a queued message.
 */
let nextSendQueued = 0;
export function markNextSendQueued(): void {
	nextSendQueued = Date.now();
}
export function takeNextSendMode(): "followUp" | undefined {
	const marked = nextSendQueued;
	nextSendQueued = 0;
	return marked > 0 && Date.now() - marked < 2000 ? "followUp" : undefined;
}

/** DOM event the user bubble dispatches for its Retry / Discard buttons; the side panel routes it to the agent. */
export const SEND_ACTION_EVENT = "sg-send-action";
export interface SendActionDetail {
	id: string;
	action: "retry" | "discard";
}
export function sendActionOf(event: Event): SendActionDetail | undefined {
	const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
	if (typeof detail !== "object" || detail === null) return undefined;
	const d = detail as Record<string, unknown>;
	return typeof d.id === "string" && (d.action === "retry" || d.action === "discard")
		? { id: d.id, action: d.action }
		: undefined;
}

/** A short reason for the bubble, from whatever fetch threw. */
export function describeSendError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	const name = err instanceof Error ? err.name : "";
	if (name === "TimeoutError" || /timed out/i.test(message)) return "no answer from the R730";
	if (name === "TypeError" && /fetch|network/i.test(message)) return "no connection";
	return message.replace(/^prime relay POST \S+: /, "").slice(0, 120) || "send failed";
}
