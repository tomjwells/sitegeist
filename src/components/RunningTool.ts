import type { ToolCall } from "@mariozechner/pi-ai";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
	clockTime,
	elapsed,
	quietAfterMs,
	RUNNING_CHANGED,
	type RunInfo,
	runningTools,
} from "../prime/running-tools.js";
import { primeToolTitle } from "../prime/tool-summary.js";

/**
 * A command that is running, at its own place in the chat (Tom, 2026-11-15: "say it is a 30minute thing…. How long
 * has it already been running - has it returned anything yet? Any logs? What are those logs?"). Header: what runs and
 * for how long. Then: when it started, how many lines it printed, when it last printed ("quiet for 3m" in amber after
 * 2 minutes of silence), and its last 6 lines, following live. "Show all output" opens everything the relay kept;
 * "Show command" the input; "Copy" copies the output. When the command finishes, the chat's usual tool block takes
 * its place, with "took 31m 4s" under it (toolFrame below).
 *
 * Before 2026-11-15 a running call was drawn nowhere: pi-web-ui's message list hides a pending call while the turn
 * streams, and its live box drops the message once the model has finished writing it (scripts/build.mjs un-hides it).
 * Data: prime/running-tools.ts.
 */
const TAIL_LINES = 6;

/** The patched pi-web-ui ToolMessage (scripts/build.mjs): what this file needs from it. */
interface ToolMessageLike {
	toolCall: ToolCall;
	result?: unknown;
	aborted?: boolean;
	pending?: boolean;
	sgMessageTime?: number;
}

/**
 * The patched ToolMessage's render(): a call with no result that is not aborted goes through <sg-running-tool>, which
 * shows the card while the call runs and the normal block otherwise; a finished call gets "took …" under it.
 */
export function toolFrame(tm: ToolMessageLike, normal: () => TemplateResult): TemplateResult {
	if (!tm.result && !tm.aborted)
		return html`<sg-running-tool
			.call=${tm.toolCall}
			.pending=${tm.pending === true}
			.messageTime=${tm.sgMessageTime}
			.fallback=${normal()}
		></sg-running-tool>`;
	const ms = runningTools.duration(tm.toolCall.id);
	if (ms === undefined || ms < 10_000) return normal();
	return html`${normal()}<div class="sg-took mt-1 text-[11px] text-muted-foreground">took ${elapsed(ms)}</div>`;
}

@customElement("sg-running-tool")
export class RunningTool extends LitElement {
	@property({ attribute: false }) call!: ToolCall;
	@property({ attribute: false }) pending = false;
	@property({ attribute: false }) messageTime: number | undefined;
	@property({ attribute: false }) fallback: TemplateResult | undefined;
	@state() private showAll = false;
	@state() private showCommand = false;
	@state() private fullOutput: string | undefined;
	@state() private copied = false;
	private tick: ReturnType<typeof setInterval> | undefined;
	private readonly onChange = () => this.requestUpdate();

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		runningTools.addEventListener(RUNNING_CHANGED, this.onChange);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		runningTools.removeEventListener(RUNNING_CHANGED, this.onChange);
		this.stopTick();
	}

	private stopTick(): void {
		if (this.tick) clearInterval(this.tick);
		this.tick = undefined;
	}

	private run(): RunInfo | undefined {
		const known = runningTools.get(this.call.id);
		if (known) return known;
		if (!this.pending) return undefined;
		// running, but the store has nothing yet (an old relay, or before the first push)
		return {
			toolCallId: this.call.id,
			toolName: this.call.name,
			startedAt: null,
			lastOutputAt: null,
			lines: 0,
			tail: "",
			truncated: false,
			missedOutput: false,
			fromRelay: false,
		};
	}

	private async toggleAll(): Promise<void> {
		this.showAll = !this.showAll;
		if (!this.showAll) return;
		const [agentId, sessionId] = splitKey(runningTools.sessionKey);
		try {
			this.fullOutput = await primeRunningOutput(agentId, sessionId, this.call.id);
		} catch {
			this.fullOutput = undefined;
		}
	}

	private async copy(run: RunInfo): Promise<void> {
		const [agentId, sessionId] = splitKey(runningTools.sessionKey);
		let text = run.tail;
		try {
			text = (await primeRunningOutput(agentId, sessionId, this.call.id)) ?? run.tail;
		} catch {
			/* the tail it is */
		}
		await navigator.clipboard.writeText(text);
		this.copied = true;
		setTimeout(() => {
			this.copied = false;
		}, 1500);
	}

	override updated(): void {
		// keep "Show all output" pinned to the bottom unless Tom scrolled up in it
		const box = this.querySelector<HTMLElement>(".sg-run-all");
		if (box && box.dataset.pinned !== "false") box.scrollTop = box.scrollHeight;
	}

	override render() {
		const run = this.run();
		if (!run) {
			this.stopTick();
			return this.fallback ?? nothing;
		}
		this.tick ??= setInterval(() => this.requestUpdate(), 1000);
		const now = Date.now();
		const started = run.startedAt ?? this.messageTime ?? null;
		const exactStart = run.startedAt !== null;
		const since = run.lastOutputAt ?? started;
		const quiet = since !== null && now - since >= quietAfterMs();
		const title = primeToolTitle(this.call.name, this.call.arguments);
		runningTools.describe(this.call.id, {
			title,
			...(this.messageTime !== undefined ? { messageTime: this.messageTime } : {}),
		});
		const lines = run.tail === "" ? [] : run.tail.split("\n");
		const shown = lines.slice(Math.max(0, lines.length - TAIL_LINES));
		const facts: TemplateResult[] = [];
		if (started !== null)
			facts.push(html`<span>${exactStart ? "started" : "running since about"} ${clockTime(started)}</span>`);
		if (run.lines > 0) facts.push(html`<span>${run.lines.toLocaleString()} line${run.lines === 1 ? "" : "s"}</span>`);
		if (run.lastOutputAt !== null)
			facts.push(
				html`<span class=${quiet ? "text-amber-600 dark:text-amber-400 font-medium" : ""}
					>${quiet ? `quiet for ${elapsed(now - run.lastOutputAt)}` : `last output ${elapsed(now - run.lastOutputAt)} ago`}</span
				>`,
			);
		else
			facts.push(
				html`<span class=${quiet ? "text-amber-600 dark:text-amber-400 font-medium" : ""}
					>${run.status ?? "no output yet"}${quiet && started !== null ? ` · quiet for ${elapsed(now - started)}` : ""}</span
				>`,
			);
		const notes: string[] = [];
		if (run.missedOutput && run.seenFrom !== undefined)
			notes.push(`output before ${clockTime(run.seenFrom)} not shown`);
		else if (run.missedOutput) notes.push("some output not shown");
		if (run.truncated && run.lines > lines.length)
			notes.push(`last ${lines.length.toLocaleString()} of ${run.lines.toLocaleString()} lines kept`);
		const all = this.fullOutput ?? run.tail;
		return html`<div
			class="sg-running-tool rounded-md border ${quiet ? "border-amber-500/60" : "border-border"} bg-card p-2.5 text-xs"
			data-call-id=${this.call.id}
			data-quiet=${quiet ? "true" : "false"}
		>
			<div class="flex items-center gap-2">
				<span class="inline-block h-2 w-2 shrink-0 rounded-full ${quiet ? "bg-amber-500" : "bg-yellow-500 animate-pulse"}"></span>
				<span class="sg-run-title min-w-0 flex-1 truncate font-medium text-foreground" title=${title}>${title}</span>
				<span class="sg-run-elapsed shrink-0 tabular-nums text-muted-foreground"
					>${started !== null ? `running ${exactStart ? "" : "~"}${elapsed(now - started)}` : "running"}</span
				>
			</div>
			<div class="sg-run-facts mt-1 flex flex-wrap gap-x-2 text-muted-foreground">
				${facts.map((f, i) => html`${i > 0 ? html`<span aria-hidden="true">·</span>` : ""}${f}`)}
			</div>
			${notes.length > 0 ? html`<div class="sg-run-note mt-0.5 text-[11px] text-muted-foreground/80">${notes.join(" · ")}</div>` : ""}
			${
				this.showAll
					? html`<pre
							class="sg-run-all mt-2 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-snug text-foreground/90 whitespace-pre-wrap break-all"
							style="max-height:40vh"
							@scroll=${(e: Event) => {
								const el = e.currentTarget;
								if (el instanceof HTMLElement)
									el.dataset.pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - 8 ? "true" : "false";
							}}
						>${all}</pre>`
					: shown.length > 0
						? html`<pre
								class="sg-run-tail mt-2 overflow-hidden rounded bg-muted/60 p-2 font-mono text-[11px] leading-snug text-foreground/90 whitespace-pre-wrap break-all"
							>${shown.join("\n")}</pre>`
						: ""
			}
			${this.showCommand ? html`<pre class="sg-run-command mt-2 max-h-60 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">${commandText(this.call)}</pre>` : ""}
			<div class="mt-1.5 flex gap-3 text-muted-foreground">
				${
					run.lines > 0
						? html`<button type="button" class="sg-run-show-all hover:text-foreground hover:underline" @click=${() => void this.toggleAll()}>
								${this.showAll ? "Show less" : "Show all output"}
							</button>`
						: ""
				}
				<button type="button" class="sg-run-show-command hover:text-foreground hover:underline" @click=${() => {
					this.showCommand = !this.showCommand;
				}}>
					${this.showCommand ? "Hide command" : "Show command"}
				</button>
				${
					run.lines > 0
						? html`<button type="button" class="sg-run-copy hover:text-foreground hover:underline" @click=${() => void this.copy(run)}>
								${this.copied ? "Copied" : "Copy output"}
							</button>`
						: ""
				}
			</div>
		</div>`;
	}
}

/**
 * The whole kept output from the relay. Loaded on first use: this file is imported by pi-web-ui's Messages.js
 * (scripts/build.mjs), and prime-client pulls in the panel's storage, which extends pi-web-ui classes that are not
 * defined yet at that point ("Class extends value undefined", 2026-11-15).
 */
async function primeRunningOutput(agentId: string, sessionId: string, toolCallId: string): Promise<string | undefined> {
	const client = await import("../prime/prime-client.js");
	return client.primeRunningOutput(agentId, sessionId, toolCallId);
}

function splitKey(key: string): [string, string] {
	const i = key.indexOf("/");
	return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}

/** The command as text: the code of a code-carrying tool, else its arguments as JSON. */
function commandText(call: ToolCall): string {
	const a: unknown = call.arguments;
	if (typeof a === "object" && a !== null) {
		for (const k of ["code", "command"]) {
			const v: unknown = Reflect.get(a, k);
			if (typeof v === "string") return v;
		}
	}
	return JSON.stringify(a, null, 2);
}

declare global {
	interface HTMLElementTagNameMap {
		"sg-running-tool": RunningTool;
	}
}
