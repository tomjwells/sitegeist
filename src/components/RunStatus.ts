import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { elapsed, quietAfterMs, RUNNING_CHANGED, type RunInfo, runningTools } from "../prime/running-tools.js";

/**
 * One line above the prompt box while a command runs (Tom, 2026-11-15, yes to "a one-line status above the prompt box,
 * next to the queue shelf"): what runs, for how long, when it last printed; amber once it has been quiet for 2
 * minutes; "+1 more" when several run, a click lists them (Tom, 2026-11-15: "Now it says +2 more etc"), each with its
 * own line and jump. Stays in view when Tom has scrolled up. A click scrolls the chat to the
 * command's card (components/RunningTool.ts). Sits above the queue shelf, which stays attached to the prompt box.
 * Rendered by the patched pi-web-ui AgentInterface (scripts/build.mjs).
 */
@customElement("sg-run-status")
export class RunStatus extends LitElement {
	/** "+N more" opened: the other running commands are listed above the line. */
	@state() private open = false;
	private tick: ReturnType<typeof setInterval> | undefined;
	private readonly onChange = () => this.requestUpdate();

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		runningTools.addEventListener(RUNNING_CHANGED, this.onChange);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		runningTools.removeEventListener(RUNNING_CHANGED, this.onChange);
		if (this.tick) clearInterval(this.tick);
		this.tick = undefined;
	}

	private jump(id: string): void {
		document
			.querySelector(`sg-running-tool .sg-running-tool[data-call-id="${CSS.escape(id)}"]`)
			?.scrollIntoView({ behavior: "smooth", block: "center" });
	}

	/** One line for a run: name, how long, last output, lines. */
	private describeRun(run: RunInfo, now: number): { name: string; parts: string[]; quiet: boolean } {
		const d = runningTools.description(run.toolCallId);
		const name =
			run.title ??
			d?.title ??
			(run.toolName === "ipython" ? "Python" : run.toolName === "bash" ? "Shell" : run.toolName);
		// as on the card: exact when the relay saw the start, else "~" from when the model wrote the call
		const start = run.startedAt ?? d?.messageTime ?? null;
		const since = run.lastOutputAt ?? start;
		const quiet = since !== null && now - since >= quietAfterMs();
		const parts = [
			start !== null ? `running ${run.startedAt === null ? "~" : ""}${elapsed(now - start)}` : "running",
			run.lastOutputAt !== null
				? quiet
					? `quiet for ${elapsed(now - run.lastOutputAt)}`
					: `last output ${elapsed(now - run.lastOutputAt)} ago`
				: (run.status ?? "no output yet"),
			...(run.lines > 0 ? [`${run.lines.toLocaleString()} line${run.lines === 1 ? "" : "s"}`] : []),
		];
		return { name, parts, quiet };
	}

	override render() {
		const runs = runningTools.list();
		if (runs.length === 0) {
			if (this.tick) clearInterval(this.tick);
			this.tick = undefined;
			this.open = false;
			return nothing;
		}
		this.tick ??= setInterval(() => this.requestUpdate(), 1000);
		const now = Date.now();
		// the longest-running first
		const sorted = [...runs].sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
		const run = sorted[0];
		if (!run) return nothing;
		const main = this.describeRun(run, now);
		const others = sorted.slice(1);
		const dot = (quiet: boolean) =>
			html`<span class="inline-block h-2 w-2 shrink-0 rounded-full ${quiet ? "bg-amber-500" : "bg-yellow-500 animate-pulse"}"></span>`;
		return html`<div class="mx-3 mb-1">
			${
				this.open && others.length > 0
					? html`<ul class="sg-run-list mb-1 list-none overflow-hidden rounded-lg border border-border bg-card/90 p-0 text-xs" aria-label="Running commands">
							${others.map((r) => {
								const o = this.describeRun(r, now);
								return html`<li>
									<button
										type="button"
										class="sg-run-list-item flex w-full items-center gap-2 px-3 py-1 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
										title="Show this command"
										@click=${() => this.jump(r.toolCallId)}
									>
										${dot(o.quiet)}
										<span class="min-w-0 max-w-[45%] shrink truncate font-medium text-foreground" title=${o.name}>${o.name}</span>
										<span class="min-w-0 flex-1 truncate ${o.quiet ? "text-amber-600 dark:text-amber-400" : ""}">${o.parts.join(" · ")}</span>
									</button>
								</li>`;
							})}
						</ul>`
					: ""
			}
			<div
				class="sg-run-status flex w-full items-center gap-2 rounded-lg border ${main.quiet ? "border-amber-500/60" : "border-border"} bg-card/70 px-3 py-1 text-xs text-muted-foreground"
				data-quiet=${main.quiet ? "true" : "false"}
			>
				<button
					type="button"
					class="sg-run-status-main flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
					title="Show the running command"
					@click=${() => this.jump(run.toolCallId)}
				>
					${dot(main.quiet)}
					<span class="min-w-0 max-w-[45%] shrink truncate font-medium text-foreground" title=${main.name}>${main.name}</span>
					<span class="min-w-0 flex-1 truncate ${main.quiet ? "text-amber-600 dark:text-amber-400" : ""}">${main.parts.join(" · ")}</span>
				</button>
				${
					others.length > 0
						? html`<button
								type="button"
								class="sg-run-more shrink-0 rounded px-1 hover:bg-accent hover:text-foreground"
								aria-expanded=${this.open ? "true" : "false"}
								title=${this.open ? "Hide the other running commands" : "Show the other running commands"}
								@click=${() => {
									this.open = !this.open;
								}}
							>
								${this.open ? "hide" : `+${others.length} more`}
							</button>`
						: ""
				}
			</div>
		</div>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"sg-run-status": RunStatus;
	}
}
