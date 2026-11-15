import { html, LitElement, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { elapsed, quietAfterMs, RUNNING_CHANGED, runningTools } from "../prime/running-tools.js";

/**
 * One line above the prompt box while a command runs (Tom, 2026-11-15, yes to "a one-line status above the prompt box,
 * next to the queue shelf"): what runs, for how long, when it last printed; amber once it has been quiet for 2
 * minutes; "+1 more" when several run. Stays in view when Tom has scrolled up. A click scrolls the chat to the
 * command's card (components/RunningTool.ts). Sits above the queue shelf, which stays attached to the prompt box.
 * Rendered by the patched pi-web-ui AgentInterface (scripts/build.mjs).
 */
@customElement("sg-run-status")
export class RunStatus extends LitElement {
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

	override render() {
		const runs = runningTools.list();
		if (runs.length === 0) {
			if (this.tick) clearInterval(this.tick);
			this.tick = undefined;
			return nothing;
		}
		this.tick ??= setInterval(() => this.requestUpdate(), 1000);
		// the longest-running first
		const run = runs.reduce((a, b) => ((b.startedAt ?? Infinity) < (a.startedAt ?? Infinity) ? b : a));
		const now = Date.now();
		const since = run.lastOutputAt ?? run.startedAt;
		const quiet = since !== null && now - since >= quietAfterMs();
		const d = runningTools.description(run.toolCallId);
		const name =
			d?.title ?? (run.toolName === "ipython" ? "Python" : run.toolName === "bash" ? "Shell" : run.toolName);
		// as on the card: exact when the relay saw the start, else "~" from when the model wrote the call
		const start = run.startedAt ?? d?.messageTime ?? null;
		const parts = [
			start !== null ? `running ${run.startedAt === null ? "~" : ""}${elapsed(now - start)}` : "running",
			run.lastOutputAt !== null
				? quiet
					? `quiet for ${elapsed(now - run.lastOutputAt)}`
					: `last output ${elapsed(now - run.lastOutputAt)} ago`
				: (run.status ?? "no output yet"),
			...(run.lines > 0 ? [`${run.lines.toLocaleString()} line${run.lines === 1 ? "" : "s"}`] : []),
		];
		return html`<button
			type="button"
			class="sg-run-status mx-3 mb-1 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border ${quiet ? "border-amber-500/60" : "border-border"} bg-card/70 px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
			title="Show the running command"
			data-quiet=${quiet ? "true" : "false"}
			@click=${() => this.jump(run.toolCallId)}
		>
			<span class="inline-block h-2 w-2 shrink-0 rounded-full ${quiet ? "bg-amber-500" : "bg-yellow-500 animate-pulse"}"></span>
			<span class="min-w-0 max-w-[45%] shrink truncate font-medium text-foreground" title=${name}>${name}</span>
			<span class="min-w-0 flex-1 truncate ${quiet ? "text-amber-600 dark:text-amber-400" : ""}">${parts.join(" · ")}</span>
			${runs.length > 1 ? html`<span class="shrink-0">+${runs.length - 1} more</span>` : ""}
		</button>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"sg-run-status": RunStatus;
	}
}
