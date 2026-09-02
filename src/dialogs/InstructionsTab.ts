import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { CUSTOM_INSTRUCTIONS_SETTING } from "../sidepanel.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import "../utils/i18n-extension.js";

/**
 * Settings → Instructions: free-text standing instructions appended to the system prompt
 * (e.g. "I live in the UK, use ebay.co.uk / amazon.co.uk and GBP"). Applied to new sessions and
 * to sessions restored from history.
 */
@customElement("instructions-tab")
export class InstructionsTab extends SettingsTab {
	@state() private value = "";
	@state() private saved = false;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	getTabName(): string {
		return i18n("Instructions");
	}

	override async connectedCallback() {
		super.connectedCallback();
		this.value = (await getSitegeistStorage().settings.get<string>(CUSTOM_INSTRUCTIONS_SETTING)) ?? "";
	}

	private onInput(e: Event) {
		this.value = (e.target as HTMLTextAreaElement).value;
		this.saved = false;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.save(), 400);
	}

	private async save() {
		await getSitegeistStorage().settings.set(CUSTOM_INSTRUCTIONS_SETTING, this.value.trim());
		this.saved = true;
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">
					${i18n("Standing instructions for the assistant, added to every conversation. Saved automatically; takes effect on the next new or reopened session.")}
				</p>
				<textarea
					class="w-full min-h-[180px] px-3 py-2 text-sm text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
					placeholder=${i18n("e.g. I live in London, UK. Prefer UK sites (ebay.co.uk, amazon.co.uk), prices in GBP, UK spelling.")}
					.value=${this.value}
					@input=${(e: Event) => this.onInput(e)}
				></textarea>
				<div class="text-xs text-muted-foreground">${this.saved ? i18n("Saved") : ""}</div>
			</div>
		`;
	}
}
