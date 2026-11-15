/**
 * What a chat's turn is doing, for the status line above the prompt box (Tom, 2026-11-15: "both these sessions seem
 * stopped and I cant tell what it's waiting on"). Two sources:
 *  - the relay's turn supervisor (cors-proxy 2026-11-15.5): `turn` in the hydrate and `turn_status` pushes. A turn
 *    cut by a restart is resumed or reported; an unreachable agent and a compaction are reported too;
 *  - the events this panel already gets: the phase of a running turn (waiting for the model, thinking, writing,
 *    writing a command) and when the last event arrived, so a running turn always says what it waits on.
 * No DOM imports: tests/turn-status.test.ts runs it under plain node.
 */
import { z } from "zod";

export const TURN_CHANGED = "change";

const TurnView = z.object({
	state: z.enum(["running", "cut_resumed", "cut", "ended_unexpectedly", "unreachable", "compacting", "idle"]),
	at: z.number(),
	note: z.string(),
	resumedAt: z.number().optional(),
	cutAt: z.number().optional(),
});
export type TurnView = z.infer<typeof TurnView>;
export type Phase = "waiting" | "thinking" | "writing" | "command" | "tool" | "none";

/** Seconds of no events before the line says "no activity for …". */
export const SILENT_AFTER_MS = 20_000;

class TurnStatusStore extends EventTarget {
	private session = "";
	private view: TurnView | undefined;
	private phaseKind: Phase = "none";
	private phaseSince = 0;
	private lastEvent = 0;

	get sessionKey(): string {
		return this.session;
	}
	/** The relay's last word on this chat's turn (undefined: an older relay, or nothing yet). */
	get relay(): TurnView | undefined {
		return this.view;
	}
	get phase(): { kind: Phase; since: number } {
		return { kind: this.phaseKind, since: this.phaseSince };
	}
	/** When this panel last got an event of this chat (0: none since it opened). */
	get lastEventAt(): number {
		return this.lastEvent;
	}

	/** A chat opened (hydrate): its relay view, if any; the phase starts over. */
	seed(sessionKey: string, turn: unknown, streaming: boolean, now = Date.now()): void {
		this.session = sessionKey;
		const parsed = TurnView.safeParse(turn);
		this.view = parsed.success ? parsed.data : undefined;
		this.phaseKind = streaming ? "waiting" : "none";
		this.phaseSince = now;
		this.lastEvent = now;
		this.emit();
	}

	/** A `turn_status` push (or a GET .../turn answer). Junk is ignored. */
	push(sessionKey: string, payload: unknown): TurnView | undefined {
		if (sessionKey !== this.session) return undefined;
		const parsed = TurnView.safeParse(payload);
		if (!parsed.success) return undefined;
		this.view = parsed.data;
		this.emit();
		return parsed.data;
	}

	/** One agent event of this chat: moves the phase and the last-event time. */
	event(sessionKey: string, type: string, sub: string | undefined, role: string | undefined, now = Date.now()): void {
		if (sessionKey !== this.session) return;
		this.lastEvent = now;
		let next: Phase | undefined;
		if (type === "agent_start") {
			next = "waiting";
			// a new turn: a note about the last one ("cut … send a message") no longer applies
			if (
				this.view &&
				(this.view.state === "cut" || this.view.state === "ended_unexpectedly" || this.view.state === "idle")
			)
				this.view = { state: "running", at: now, note: "" };
		} else if (type === "turn_start" || type === "tool_execution_end") next = "waiting";
		else if (type === "message_end" && role === "toolResult") next = "waiting";
		else if (type === "message_start" && role === "assistant")
			next = this.phaseKind === "none" ? "waiting" : undefined;
		else if (type === "message_update" && sub) {
			if (sub.startsWith("thinking")) next = "thinking";
			else if (sub.startsWith("text")) next = "writing";
			else if (sub.startsWith("toolcall")) next = "command";
		} else if (type === "tool_execution_start") next = "tool";
		else if (type === "agent_end") next = "none";
		if (next !== undefined && next !== this.phaseKind) {
			this.phaseKind = next;
			this.phaseSince = now;
		}
		this.emit();
	}

	private emit(): void {
		this.dispatchEvent(new Event(TURN_CHANGED));
	}
}

export const turnStatus = new TurnStatusStore();

/** The words for a phase ("Waiting for the model"), or undefined when it has none to show. */
export function phaseText(kind: Phase): string | undefined {
	switch (kind) {
		case "waiting":
			return "Waiting for the model";
		case "thinking":
			return "Thinking";
		case "writing":
			return "Writing";
		case "command":
			return "Writing a command";
		default:
			return undefined;
	}
}

/** A user message the relay sent after a restart cut a turn: shown as one muted line, never as a bubble. */
export const AUTO_RESUME_MARK = "[sitegeist auto-resume";
export function autoResumeTime(text: string): string | undefined {
	return /cut at about (\d\d:\d\d) UTC/.exec(text)?.[1];
}
