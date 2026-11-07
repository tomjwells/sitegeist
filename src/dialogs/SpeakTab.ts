import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { DEFAULT_SPEAK_URL, fetchHealth, fetchVoices } from "../speak/speak-client.js";
import { saveSpeakSettings, speakSettings } from "../speak/speak-settings.js";

/** Settings → Read aloud: the speak URL and an on/off switch for the 🔊 buttons. */
@customElement("speak-tab")
export class SpeakTab extends SettingsTab {
	@state() private url = speakSettings().url;
	@state() private enabled = speakSettings().enabled;
	@state() private status = "";
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	getTabName(): string {
		return "Read aloud";
	}

	private onUrlInput(e: Event) {
		// the listener sits on this <input>, so its target is that input
		this.url = (e.target as HTMLInputElement).value;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => void saveSpeakSettings({ url: this.url }), 400);
	}

	private async onEnabledChange(e: Event) {
		// the listener sits on this checkbox, so its target is that input
		this.enabled = (e.target as HTMLInputElement).checked;
		await saveSpeakSettings({ enabled: this.enabled });
	}

	private async test() {
		const url = this.url.trim() || DEFAULT_SPEAK_URL;
		this.status = "Checking…";
		try {
			const ok = await fetchHealth(url);
			const voices = ok ? await fetchVoices(url) : [];
			this.status = ok
				? `speak is up · voices: ${voices.join(", ")}`
				: "speak answered, but its engine is down (M4 asleep?)";
		} catch {
			this.status = "speak is offline (M4 asleep?)";
		}
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-3">
				<label class="flex items-center gap-2 text-sm text-foreground">
					<input type="checkbox" .checked=${this.enabled} @change=${(e: Event) => this.onEnabledChange(e)} />
					<span>Show a 🔊 read-aloud button on answers</span>
				</label>
				<div class="pt-2 text-sm font-medium text-foreground">speak URL</div>
				<p class="text-xs text-muted-foreground">
					main-pi's text-to-speech service. The voice is the agent's own when speak has one by that name, otherwise main-pi.
					Built with Fish Audio.
				</p>
				<div class="flex gap-2">
					<input
						type="url"
						class="flex-1 px-3 py-2 text-sm text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
						placeholder=${DEFAULT_SPEAK_URL}
						.value=${this.url}
						@input=${(e: Event) => this.onUrlInput(e)}
					/>
					<button class="px-3 py-2 text-sm rounded-md border border-input bg-background hover:bg-accent" @click=${() => this.test()}>
						Test
					</button>
				</div>
				<div class="text-xs text-muted-foreground sg-speak-status">${this.status}</div>
			</div>
		`;
	}
}
