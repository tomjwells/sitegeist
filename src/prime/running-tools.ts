import { z } from "zod";

/**
 * Commands running now in the open chat, for the live card in the chat (components/RunningTool.ts) and the status line
 * above the prompt box (components/RunStatus.ts). Tom, 2026-11-15: "say it is a 30minute thing…. How long has it
 * already been running - has it returned anything yet? Any logs? What are those logs?"
 *
 * Fed from three places: the relay's hydrate (`running`, `toolDurations`, `now`), its live `running_tools` pushes
 * (at most 4 a second, with the last 30 lines of output), and the agent's own tool_execution_start / _end events
 * (prime-agent.ts), so a call shows as running at once even with a relay that sends nothing. Times are the relay's
 * clock (events carry none), moved onto this browser's clock with the difference measured at each push. One chat at a
 * time: switching chat resets it. Never holds more than the relay's tail per call; the whole kept output is fetched
 * on demand ("Show all output").
 */

const RunView = z.object({
	toolCallId: z.string(),
	toolName: z.string(),
	startedAt: z.number().nullable(),
	seenFrom: z.number().optional(),
	lastOutputAt: z.number().nullable(),
	lines: z.number(),
	keptLines: z.number().optional(),
	tail: z.string(),
	truncated: z.boolean(),
	missedOutput: z.boolean(),
	status: z.string().optional(),
	fullOutputPath: z.string().optional(),
});
type RunView = z.infer<typeof RunView>;

const Push = z.object({
	now: z.number(),
	running: z.array(RunView),
	finished: z.record(z.string(), z.number()).optional(),
});
const HydrateFields = z.object({
	now: z.number(),
	running: z.array(RunView),
	toolDurations: z.record(z.string(), z.number()),
});

export interface RunInfo {
	toolCallId: string;
	toolName: string;
	/** This browser's clock (ms); null = the relay did not see it start. */
	startedAt: number | null;
	/** When the relay first knew of the call (this browser's clock); output before it was not seen. */
	seenFrom?: number;
	lastOutputAt: number | null;
	lines: number;
	/** The last lines of output (up to 30), oldest first, without a trailing newline. */
	tail: string;
	truncated: boolean;
	/** Some output was never seen by the relay (it restarted mid-command, or was too far behind). */
	missedOutput: boolean;
	/** e.g. "Starting kernel…" while the tool gets ready; not output. */
	status?: string;
	/** Known only from the relay: before its first push a call shows the timer and "no output yet". */
	fromRelay: boolean;
}

/** What the card knows and the store does not: the call's title, and when its message was written. */
interface CallDescription {
	title: string;
	messageTime?: number;
}

export const RUNNING_CHANGED = "change";

class RunningTools extends EventTarget {
	private session = "";
	private readonly runs = new Map<string, RunInfo>();
	private readonly durations = new Map<string, number>();
	/** Local start times of calls whose start event this panel saw (for "took" with a relay that sends nothing). */
	private readonly localStarts = new Map<string, number>();
	private readonly descriptions = new Map<string, CallDescription>();
	private emitTimer: ReturnType<typeof setTimeout> | undefined;
	private lastEmit = 0;

	/** The chat these runs belong to. */
	get sessionKey(): string {
		return this.session;
	}

	get(id: string): RunInfo | undefined {
		return this.runs.get(id);
	}

	list(): RunInfo[] {
		return Array.from(this.runs.values());
	}

	/** The card tells the store the call's title and message time, so the status line can say the same. */
	describe(id: string, d: CallDescription): void {
		const old = this.descriptions.get(id);
		if (old?.title === d.title && old.messageTime === d.messageTime) return;
		this.descriptions.set(id, d);
		// the card is drawn after the status line in the same update: tell it once more (only when it changed)
		queueMicrotask(() => this.emit(true));
	}

	description(id: string): CallDescription | undefined {
		return this.descriptions.get(id);
	}

	/** How long a finished call took (ms), when known. */
	duration(id: string): number | undefined {
		return this.durations.get(id);
	}

	/** A chat opened: forget the previous chat's runs, take the relay's (an old relay sends none). */
	seed(sessionKey: string, hydration: unknown): void {
		this.session = sessionKey;
		this.runs.clear();
		this.durations.clear();
		this.localStarts.clear();
		this.descriptions.clear();
		const parsed = HydrateFields.safeParse(hydration);
		if (parsed.success) {
			const skew = Date.now() - parsed.data.now;
			for (const r of parsed.data.running) this.runs.set(r.toolCallId, fromView(r, skew));
			for (const [id, ms] of Object.entries(parsed.data.toolDurations)) this.durations.set(id, ms);
		}
		this.emit(true);
	}

	/** A live push from the relay for this chat. */
	push(sessionKey: string, payload: unknown): void {
		if (sessionKey !== this.session) return;
		const parsed = Push.safeParse(payload);
		if (!parsed.success) return;
		const skew = Date.now() - parsed.data.now;
		const seen = new Set<string>();
		for (const r of parsed.data.running) {
			seen.add(r.toolCallId);
			const info = fromView(r, skew);
			// a start the relay did not see, but this panel did
			if (info.startedAt === null) info.startedAt = this.localStarts.get(r.toolCallId) ?? null;
			this.runs.set(r.toolCallId, info);
		}
		// The push lists every call the relay knows to be running: the others ended (unless only started here, and the
		// relay has not pushed them yet).
		for (const [id, info] of this.runs) if (!seen.has(id) && info.fromRelay) this.runs.delete(id);
		for (const [id, ms] of Object.entries(parsed.data.finished ?? {})) {
			this.durations.set(id, ms);
			this.runs.delete(id);
		}
		this.emit();
	}

	/** tool_execution_start seen by this panel. */
	started(sessionKey: string, id: string, toolName: string): void {
		if (sessionKey !== this.session) return;
		const now = Date.now();
		this.localStarts.set(id, now);
		if (!this.runs.has(id))
			this.runs.set(id, {
				toolCallId: id,
				toolName,
				startedAt: now,
				lastOutputAt: null,
				lines: 0,
				tail: "",
				truncated: false,
				missedOutput: false,
				fromRelay: false,
			});
		this.emit(true);
	}

	/** tool_execution_end seen by this panel (or the turn ended). */
	ended(sessionKey: string, id: string): void {
		if (sessionKey !== this.session) return;
		const run = this.runs.get(id);
		const start = run?.startedAt ?? this.localStarts.get(id);
		if (start !== undefined && start !== null && !this.durations.has(id)) this.durations.set(id, Date.now() - start);
		this.runs.delete(id);
		this.localStarts.delete(id);
		this.emit(true);
	}

	/** agent_end: nothing runs any more. */
	clear(sessionKey: string): void {
		if (sessionKey !== this.session || this.runs.size === 0) return;
		for (const id of Array.from(this.runs.keys())) this.ended(sessionKey, id);
	}

	/** At most 4 change events a second, however fast output arrives; `now` for starts and ends. */
	private emit(now = false): void {
		if (now || Date.now() - this.lastEmit >= 250) {
			if (this.emitTimer) clearTimeout(this.emitTimer);
			this.emitTimer = undefined;
			this.lastEmit = Date.now();
			this.dispatchEvent(new Event(RUNNING_CHANGED));
			return;
		}
		this.emitTimer ??= setTimeout(
			() => {
				this.emitTimer = undefined;
				this.lastEmit = Date.now();
				this.dispatchEvent(new Event(RUNNING_CHANGED));
			},
			250 - (Date.now() - this.lastEmit),
		);
	}
}

function fromView(r: RunView, skew: number): RunInfo {
	return {
		toolCallId: r.toolCallId,
		toolName: r.toolName,
		startedAt: r.startedAt === null ? null : r.startedAt + skew,
		...(r.seenFrom !== undefined ? { seenFrom: r.seenFrom + skew } : {}),
		lastOutputAt: r.lastOutputAt === null ? null : r.lastOutputAt + skew,
		lines: r.lines,
		tail: r.tail,
		truncated: r.truncated,
		missedOutput: r.missedOutput,
		...(r.status ? { status: r.status } : {}),
		fromRelay: true,
	};
}

export const runningTools = new RunningTools();

/** "7m 12s", "45s", "1h 03m". */
export function elapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "14:13" in this browser's time zone. */
export function clockTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** No output for this long (or none since the start) = "quiet", drawn amber. Tests shorten it. */
export function quietAfterMs(): number {
	// globalThis is an object; reading an unknown property and checking its type below is safe
	const v: unknown = (globalThis as Record<string, unknown>).__sgRunQuietMs;
	return typeof v === "number" && v > 0 ? v : 120_000;
}
