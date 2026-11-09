import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LoaderCircle, Square, Volume2 } from "lucide";
import { messageKey } from "../speak/message-key.js";
import { speakPlayer } from "../speak/speak.js";
import { speakSettings } from "../speak/speak-settings.js";

const ATTRIBUTION = "Built with Fish Audio"; // Fish Audio Community License: show it where the audio is offered

/**
 * 🔊 on each assistant message, next to the copy button (scripts/build.mjs puts it in pi-web-ui's message footer).
 * Click to play, click again to stop; a spinner while the audio renders; a short note when speak fails.
 * Pause, position and speed are in the player bar under the header (SpeakBar.ts).
 * Light DOM, so the panel's Tailwind classes apply.
 */
@customElement("sg-speak-button")
export class SpeakButton extends LitElement {
	/** The message's Markdown (its text parts), as written by the model. */
	@property({ attribute: false }) text = "";

	private key = "";
	private readonly onChange = () => this.requestUpdate();

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		speakPlayer.addEventListener("change", this.onChange);
		this.track();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		speakPlayer.removeEventListener("change", this.onChange);
		if (this.key) speakPlayer.detach(this.key);
		this.key = "";
	}

	protected override willUpdate(): void {
		this.track();
	}

	/** Keep the player's mounted-buttons count right when the text changes under the same element. */
	private track(): void {
		const key = this.text.trim() ? messageKey(this.text) : "";
		if (key === this.key || !this.isConnected) return;
		if (this.key) speakPlayer.detach(this.key);
		if (key) speakPlayer.attach(key);
		this.key = key;
	}

	override render(): TemplateResult | typeof nothing {
		if (!speakSettings().enabled || !this.text.trim()) return nothing;
		const { phase, note } = speakPlayer.view(this.key);
		const title =
			phase === "playing" || phase === "paused"
				? `Stop reading · ${ATTRIBUTION}`
				: phase === "loading"
					? `Rendering audio… click to cancel · ${ATTRIBUTION}`
					: `Read aloud · ${ATTRIBUTION}`;
		const glyph =
			phase === "playing" || phase === "paused"
				? icon(Square, "xs")
				: phase === "loading"
					? icon(LoaderCircle, "sm", "animate-spin")
					: icon(Volume2, "sm");
		return html`<button
				type="button"
				class="sg-speak inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground ${phase !== "idle" ? "text-foreground" : ""}"
				data-phase=${phase}
				title=${title}
				aria-label=${title}
				aria-pressed=${phase !== "idle" ? "true" : "false"}
				@click=${(e: Event) => {
					e.stopPropagation();
					speakPlayer.toggle(this.text);
				}}
			>${glyph}</button
			>${note ? html`<span class="sg-speak-note ml-1 text-xs text-destructive" role="status">${note}</span>` : nothing}`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"sg-speak-button": SpeakButton;
	}
}
