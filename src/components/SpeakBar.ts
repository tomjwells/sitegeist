import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { LoaderCircle, Pause, Play, RotateCcw, RotateCw, X } from "lucide";
import { speakPlayer } from "../speak/speak.js";
import { saveSpeakSettings } from "../speak/speak-settings.js";
import { clock, SPEAK_RATES } from "../speak/timeline.js";

const SKIP_SECONDS = 10;
const KEY_SECONDS = 5;
const BUTTON =
	"inline-flex shrink-0 items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground";

/**
 * The read-aloud player bar (Tom, 2026-11-09: "improve the control over the audio playback ... as fully featured as
 * in the youtube extension: scrollable position, ability to adjust playback speed and so on"). It sits under the
 * panel's header while an answer is being read, so the controls stay reachable however far the chat is scrolled:
 * play/pause, back/forward 10 s, a draggable position over the whole answer, time, speed menu (remembered), close.
 * Renders nothing while the player is idle. Light DOM, so the panel's Tailwind classes apply.
 */
@customElement("sg-speak-bar")
export class SpeakBar extends LitElement {
	/** Slider value while Tom is dragging it; the audio only jumps when he lets go. */
	@state() private drag: number | null = null;
	@state() private menuOpen = false;

	private readonly onPlayer = () => this.requestUpdate();

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		speakPlayer.addEventListener("change", this.onPlayer);
		speakPlayer.addEventListener("time", this.onPlayer);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		speakPlayer.removeEventListener("change", this.onPlayer);
		speakPlayer.removeEventListener("time", this.onPlayer);
	}

	private onSeekInput(e: Event): void {
		// the listener sits on the range input, so its target is that input
		this.drag = (e.target as HTMLInputElement).valueAsNumber;
	}

	private onSeekChange(e: Event): void {
		// the listener sits on the range input, so its target is that input
		const value = (e.target as HTMLInputElement).valueAsNumber;
		this.drag = null;
		speakPlayer.seekTo(value);
	}

	/** Arrow keys on the slider jump 5 s (the native step is half a second). */
	private onSeekKey(e: KeyboardEvent): void {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		e.preventDefault();
		speakPlayer.skip(e.key === "ArrowLeft" ? -KEY_SECONDS : KEY_SECONDS);
	}

	private pickRate(rate: number): void {
		this.menuOpen = false;
		speakPlayer.setRate(rate);
		void saveSpeakSettings({ rate });
		this.querySelector<HTMLButtonElement>(".sg-speak-rate")?.focus();
	}

	private onMenuFocusOut(e: FocusEvent): void {
		const wrap = e.currentTarget;
		if (wrap instanceof Node && e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget)) return;
		this.menuOpen = false;
	}

	override render(): TemplateResult | typeof nothing {
		const p = speakPlayer.progress();
		if (!p) {
			if (this.drag !== null || this.menuOpen) {
				this.drag = null;
				this.menuOpen = false;
			}
			return nothing;
		}
		const total = Math.max(p.total, 0.5);
		const position = Math.min(this.drag ?? p.position, total);
		const playLabel =
			p.phase === "paused" ? "Play" : p.phase === "loading" ? "Rendering audio… click to pause" : "Pause";
		const playGlyph =
			p.phase === "paused"
				? icon(Play, "sm")
				: p.phase === "loading"
					? icon(LoaderCircle, "sm", "animate-spin")
					: icon(Pause, "sm");
		return html`<div
			class="sg-speak-bar flex items-center gap-1 px-2 py-1 border-b border-border bg-background text-xs text-foreground"
			role="group"
			aria-label="Read aloud player"
			data-phase=${p.phase}
			@keydown=${(e: KeyboardEvent) => {
				if (e.key === "Escape" && this.menuOpen) {
					e.stopPropagation();
					this.menuOpen = false;
				}
			}}
		>
			<button type="button" class="sg-speak-play ${BUTTON}" title=${playLabel} aria-label=${playLabel} @click=${() => speakPlayer.togglePause()}>
				${playGlyph}
			</button>
			<button
				type="button"
				class="sg-speak-back ${BUTTON}"
				title="Back ${SKIP_SECONDS} seconds"
				aria-label="Back ${SKIP_SECONDS} seconds"
				@click=${() => speakPlayer.skip(-SKIP_SECONDS)}
			>
				${icon(RotateCcw, "sm")}
			</button>
			<button
				type="button"
				class="sg-speak-forward ${BUTTON}"
				title="Forward ${SKIP_SECONDS} seconds"
				aria-label="Forward ${SKIP_SECONDS} seconds"
				@click=${() => speakPlayer.skip(SKIP_SECONDS)}
			>
				${icon(RotateCw, "sm")}
			</button>
			<input
				type="range"
				class="sg-speak-seek flex-1 min-w-10 m-0 cursor-pointer accent-primary"
				min="0"
				max=${total}
				step="0.5"
				.value=${String(position)}
				aria-label="Read aloud position"
				aria-valuetext="${clock(position)} of ${clock(total)}"
				@input=${(e: Event) => this.onSeekInput(e)}
				@change=${(e: Event) => this.onSeekChange(e)}
				@keydown=${(e: KeyboardEvent) => this.onSeekKey(e)}
			/>
			<span class="sg-speak-time shrink-0 whitespace-nowrap tabular-nums text-muted-foreground max-[359px]:hidden"
				>${clock(position)} / ${clock(total)}</span
			>
			<div class="relative shrink-0" @focusout=${(e: FocusEvent) => this.onMenuFocusOut(e)}>
				<button
					type="button"
					class="sg-speak-rate inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 tabular-nums hover:bg-accent ${this.menuOpen ? "bg-accent" : ""}"
					title="Speed"
					aria-label="Playback speed"
					aria-haspopup="menu"
					aria-expanded=${this.menuOpen ? "true" : "false"}
					@click=${() => {
						this.menuOpen = !this.menuOpen;
					}}
				>
					${p.rate}× ▾
				</button>
				${
					this.menuOpen
						? html`<ul
								class="sg-speak-rate-menu absolute right-0 top-full z-50 mt-1 min-w-20 list-none rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
								role="menu"
							>
								${SPEAK_RATES.map(
									(rate) =>
										html`<li>
											<button
												type="button"
												class="sg-speak-rate-option flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left tabular-nums hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
												role="menuitemradio"
												aria-checked=${rate === p.rate ? "true" : "false"}
												data-rate=${rate}
												@click=${() => this.pickRate(rate)}
											>
												<span>${rate}×</span><span>${rate === p.rate ? "✓" : ""}</span>
											</button>
										</li>`,
								)}
							</ul>`
						: nothing
				}
			</div>
			<button type="button" class="sg-speak-close ${BUTTON}" title="Stop reading" aria-label="Stop reading" @click=${() => speakPlayer.stop()}>
				${icon(X, "sm")}
			</button>
		</div>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"sg-speak-bar": SpeakBar;
	}
}
