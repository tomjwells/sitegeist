import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { CUSTOM_INSTRUCTIONS_SETTING, DEFAULT_MODEL_CATALOG_URL, MODEL_CATALOG_URL_SETTING } from "../sidepanel.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import {
	CUSTOM_INSTRUCTIONS_UPDATED_SETTING,
	DEFAULT_SYNC_URL,
	pushInstructions,
	SYNC_AUTH_SETTING,
	SYNC_TOKEN_SETTING,
	SYNC_URL_SETTING,
	type SyncResult,
	syncWithServer,
} from "../sync.js";
import "../utils/i18n-extension.js";

/**
 * Settings → Instructions: free-text standing instructions appended to the system prompt
 * (e.g. "I live in the UK, use ebay.co.uk / amazon.co.uk and GBP"). Applied to new sessions and
 * to sessions restored from history.
 */
@customElement("instructions-tab")
export class InstructionsTab extends SettingsTab {
	@state() private value = "";
	@state() private catalogUrl = "";
	@state() private syncUrl = "";
	@state() private syncAuth = true;
	@state() private syncToken = "";
	@state() private saved = false;
	@state() private syncStatus = "";
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	getTabName(): string {
		return i18n("Instructions");
	}

	override async connectedCallback() {
		super.connectedCallback();
		const settings = getSitegeistStorage().settings;
		this.value = (await settings.get<string>(CUSTOM_INSTRUCTIONS_SETTING)) ?? "";
		this.catalogUrl = (await settings.get<string>(MODEL_CATALOG_URL_SETTING)) ?? DEFAULT_MODEL_CATALOG_URL;
		this.syncUrl = (await settings.get<string>(SYNC_URL_SETTING)) ?? DEFAULT_SYNC_URL;
		this.syncAuth = (await settings.get<boolean>(SYNC_AUTH_SETTING)) !== false;
		this.syncToken = (await settings.get<string>(SYNC_TOKEN_SETTING)) ?? "";
	}

	private onSyncTokenInput(e: Event) {
		this.syncToken = (e.target as HTMLInputElement).value;
		this.saved = false;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.save(), 400);
	}

	private async onSyncAuthChange(e: Event) {
		this.syncAuth = (e.target as HTMLInputElement).checked;
		await getSitegeistStorage().settings.set(SYNC_AUTH_SETTING, this.syncAuth);
	}

	private onSyncUrlInput(e: Event) {
		this.syncUrl = (e.target as HTMLInputElement).value;
		this.saved = false;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.save(), 400);
	}

	private async syncNow() {
		this.syncStatus = i18n("Syncing…");
		const r: SyncResult = await syncWithServer();
		this.syncStatus = r.ok
			? `${i18n("Synced")}: ↓${r.pulledSkills} ↑${r.pushedSkills} ✕${r.deletedSkills} ${i18n("skills")}, ${i18n("instructions")} ${r.instructions}, ↓${r.pulledLogins} ↑${r.pushedLogins} ${i18n("logins")}`
			: `${i18n("Sync failed")}: ${r.error ?? "?"}`;
	}

	private onCatalogInput(e: Event) {
		this.catalogUrl = (e.target as HTMLInputElement).value;
		this.saved = false;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.save(), 400);
	}

	private onInput(e: Event) {
		this.value = (e.target as HTMLTextAreaElement).value;
		this.saved = false;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.save(), 400);
	}

	private async save() {
		const settings = getSitegeistStorage().settings;
		const text = this.value.trim();
		const previous = ((await settings.get<string>(CUSTOM_INSTRUCTIONS_SETTING)) ?? "").trim();
		await settings.set(CUSTOM_INSTRUCTIONS_SETTING, text);
		await settings.set(MODEL_CATALOG_URL_SETTING, this.catalogUrl.trim());
		await settings.set(SYNC_URL_SETTING, this.syncUrl.trim());
		await settings.set(SYNC_TOKEN_SETTING, this.syncToken.trim());
		if (text !== previous) {
			const updatedAt = new Date().toISOString();
			await settings.set(CUSTOM_INSTRUCTIONS_UPDATED_SETTING, updatedAt);
			void pushInstructions(text, updatedAt);
		}
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
				<div class="pt-2 text-sm font-medium text-foreground">${i18n("Model catalog URL")}</div>
				<p class="text-xs text-muted-foreground">
					${i18n("Fetched when the panel opens and merged into the model list, so new models appear without an extension update. Leave empty to use only the bundled list.")}
				</p>
				<input
					type="url"
					class="w-full px-3 py-2 text-sm text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
					placeholder=${DEFAULT_MODEL_CATALOG_URL}
					.value=${this.catalogUrl}
					@input=${(e: Event) => this.onCatalogInput(e)}
				/>
				<div class="pt-2 text-sm font-medium text-foreground">${i18n("Sync URL")}</div>
				<p class="text-xs text-muted-foreground">
					${i18n("Skills and these instructions are backed up to this server on every change and reconciled when the panel opens, so they survive a reinstall. Leave empty to disable.")}
				</p>
				<div class="flex gap-2">
					<input
						type="url"
						class="flex-1 px-3 py-2 text-sm text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
						placeholder=${DEFAULT_SYNC_URL}
						.value=${this.syncUrl}
						@input=${(e: Event) => this.onSyncUrlInput(e)}
					/>
					<button
						class="px-3 py-2 text-sm rounded-md border border-input bg-background hover:bg-accent"
						@click=${() => this.syncNow()}
					>${i18n("Sync now")}</button>
				</div>
				<div class="pt-1 text-sm font-medium text-foreground">${i18n("Proxy token")}</div>
				<p class="text-xs text-muted-foreground">
					${i18n("Shared secret the proxy requires. It unlocks the sync store and lets the Browser agent call every model in the catalog through the proxy's credentials - no per-provider login needed. Models take effect after reopening the panel.")}
				</p>
				<input
					type="password"
					autocomplete="off"
					class="w-full px-3 py-2 text-sm text-foreground bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
					.value=${this.syncToken}
					@input=${(e: Event) => this.onSyncTokenInput(e)}
				/>
				<label class="flex items-start gap-2 text-xs text-muted-foreground">
					<input type="checkbox" class="mt-0.5" .checked=${this.syncAuth} @change=${(e: Event) => this.onSyncAuthChange(e)} />
					<span>${i18n("Also back up provider logins (API keys and OAuth tokens) to the sync server, so they survive removing the extension. Only use with a private server you control.")}</span>
				</label>
				<div class="text-xs text-muted-foreground">${this.syncStatus}</div>
				<div class="text-xs text-muted-foreground">${this.saved ? i18n("Saved") : ""}</div>
			</div>
		`;
	}
}
