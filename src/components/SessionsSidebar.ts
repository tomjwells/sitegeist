import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { getAppStorage, type SessionMetadata } from "@mariozechner/pi-web-ui";
import Fuse from "fuse.js";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { FolderCog, Pin, PinOff, Plus, Trash2, X } from "lucide";
import { SitegeistSessionListDialog } from "../dialogs/SessionListDialog.js";
import { agentIdFromSessionId, isPrimeSessionId, MAIN_AGENT_ID } from "../prime/constants.js";
import * as port from "../utils/port.js";
import "../utils/i18n-extension.js";

export const SESSIONS_PINNED_SETTING = "sessions.pinned";
export const SESSIONS_SIDEBAR_OPEN_SETTING = "sessions.sidebarOpen";

/**
 * Slide-in session list living inside the side panel: pinned sessions on top (drag to reorder),
 * recent sessions below, search, new/delete, and a "Manage…" button that opens the full dialog
 * (import/export/bulk delete). Open state and pin order persist in settings.
 */
@customElement("sessions-sidebar")
export class SessionsSidebar extends LitElement {
	@property({ type: Boolean, reflect: true }) open = false;
	@property({ type: String }) currentSessionId: string | undefined;
	@property({ attribute: false }) onSelect: (sessionId: string) => void = () => {};
	@property({ attribute: false }) onNew: () => void = () => {};
	@property({ attribute: false }) onDeleted: (sessionId: string) => void = () => {};
	@property({ attribute: false }) onToggle: (open: boolean) => void = () => {};

	@state() private sessions: SessionMetadata[] = [];
	@state() private pinned: string[] = [];
	@state() private locks: Record<string, number> = {};
	@state() private windowId: number | undefined;
	@state() private query = "";
	/** "all", "browser", or a relay agent id (prime / worker). */
	@state() private agentFilter = "all";
	@state() private dragIndex: number | undefined;
	@state() private dropIndex: number | undefined;

	// Render into light DOM so the app's Tailwind classes apply.
	protected override createRenderRoot() {
		return this;
	}

	override updated(changed: Map<string, unknown>) {
		if (changed.has("open") && this.open) void this.refresh();
	}

	async refresh(): Promise<void> {
		const storage = getAppStorage();
		try {
			const [sessions, pinned, lockResponse, win] = await Promise.all([
				storage.sessions.getAllMetadata(),
				storage.settings.get<string[]>(SESSIONS_PINNED_SETTING),
				port.sendMessage({ type: "getLockedSessions" }),
				chrome.windows.getCurrent(),
			]);
			this.sessions = sessions;
			const ids = new Set(sessions.map((s) => s.id));
			this.pinned = (pinned ?? []).filter((id) => ids.has(id));
			this.locks = lockResponse.locks || {};
			this.windowId = win.id;
		} catch (err) {
			console.error("[SessionsSidebar] refresh failed:", err);
		}
	}

	private async savePinned(next: string[]) {
		this.pinned = next;
		await getAppStorage().settings.set(SESSIONS_PINNED_SETTING, next);
	}

	private togglePin(id: string, e: Event) {
		e.stopPropagation();
		void this.savePinned(this.pinned.includes(id) ? this.pinned.filter((p) => p !== id) : [...this.pinned, id]);
	}

	private move(from: number, to: number) {
		if (from === to) return;
		const next = [...this.pinned];
		const [item] = next.splice(from, 1);
		if (item === undefined) return;
		next.splice(to, 0, item);
		void this.savePinned(next);
	}

	private async deleteSession(id: string, e: Event) {
		e.stopPropagation();
		if (!confirm(i18n("Delete this session?"))) return;
		await getAppStorage().sessions.deleteSession(id);
		await this.refresh();
		this.onDeleted(id);
	}

	private isLocked(id: string): boolean {
		const w = this.locks[id];
		return w !== undefined && w !== this.windowId;
	}

	private formatDate(iso: string): string {
		const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
		if (days === 0) return i18n("Today");
		if (days === 1) return i18n("Yesterday");
		if (days < 7) return i18n("{days} days ago").replace("{days}", String(days));
		return new Date(iso).toLocaleDateString();
	}

	private agentOf(sessionId: string): string {
		return isPrimeSessionId(sessionId) ? agentIdFromSessionId(sessionId) : "browser";
	}

	/** All, Browser agent, then every relay agent that has at least one session. */
	private filterOptions(): string[] {
		const agents = Array.from(
			new Set(this.sessions.map((s) => this.agentOf(s.id)).filter((a) => a !== "browser")),
		).sort();
		return ["all", "browser", ...agents];
	}

	private filtered(): SessionMetadata[] {
		const q = this.query.trim();
		const pool =
			this.agentFilter === "all"
				? this.sessions
				: this.sessions.filter((s) => this.agentOf(s.id) === this.agentFilter);
		if (!q) return pool;
		return new Fuse(pool, {
			keys: ["title", "preview"],
			threshold: 0.4,
			ignoreLocation: true,
			minMatchCharLength: 2,
		})
			.search(q)
			.map((r) => r.item);
	}

	private row(session: SessionMetadata, pinnedIndex: number | undefined): TemplateResult {
		const locked = this.isLocked(session.id);
		const current = session.id === this.currentSessionId;
		const isPinned = pinnedIndex !== undefined;
		const dropHere = isPinned && this.dropIndex === pinnedIndex && this.dragIndex !== pinnedIndex;
		return html`
			<div
				class="group flex items-start gap-2 px-2 py-1.5 rounded-md border ${dropHere ? "border-primary" : "border-transparent"} ${
					current ? "bg-secondary/60" : locked ? "opacity-50" : "hover:bg-secondary/40"
				} ${locked ? "cursor-not-allowed" : "cursor-pointer"}"
				draggable=${isPinned ? "true" : "false"}
				@click=${() => !locked && this.onSelect(session.id)}
				@dragstart=${(e: DragEvent) => {
					if (!isPinned) return;
					this.dragIndex = pinnedIndex;
					e.dataTransfer?.setData("text/plain", session.id);
				}}
				@dragover=${(e: DragEvent) => {
					if (!isPinned || this.dragIndex === undefined) return;
					e.preventDefault();
					this.dropIndex = pinnedIndex;
				}}
				@drop=${(e: DragEvent) => {
					if (!isPinned || this.dragIndex === undefined) return;
					e.preventDefault();
					this.move(this.dragIndex, pinnedIndex);
					this.dragIndex = undefined;
					this.dropIndex = undefined;
				}}
				@dragend=${() => {
					this.dragIndex = undefined;
					this.dropIndex = undefined;
				}}
			>
				<div class="flex-1 min-w-0">
					<div class="text-sm text-foreground truncate" title=${session.title}>${session.title}</div>
					<div class="text-[11px] text-muted-foreground truncate">
						${this.formatDate(session.lastModified)} · ${session.messageCount} ${i18n("messages")} · $${session.usage.cost.total.toFixed(2)}
						${isPrimeSessionId(session.id) ? html` · <span class="text-primary/80">${this.agentOf(session.id)}</span>` : ""}
						${current ? html` · <span class="text-primary">${i18n("Current")}</span>` : ""}
						${locked ? html` · <span class="text-destructive">${i18n("Locked")}</span>` : ""}
					</div>
				</div>
				<div class="flex gap-0.5 shrink-0 ${isPinned ? "" : "opacity-0 group-hover:opacity-100"}">
					<button
						class="p-1 rounded hover:bg-secondary text-muted-foreground"
						title=${isPinned ? i18n("Unpin") : i18n("Pin")}
						@click=${(e: Event) => this.togglePin(session.id, e)}
					>${icon(isPinned ? PinOff : Pin, "xs")}</button>
					<button
						class="p-1 rounded hover:bg-destructive/10 text-destructive opacity-0 group-hover:opacity-100"
						title=${i18n("Delete")}
						@click=${(e: Event) => this.deleteSession(session.id, e)}
					>${icon(Trash2, "xs")}</button>
				</div>
			</div>
		`;
	}

	override render(): TemplateResult {
		if (!this.open) return html``;
		const filtered = this.filtered();
		const byId = new Map(filtered.map((s) => [s.id, s]));
		const pinnedRows = this.pinned.map((id) => byId.get(id)).filter((s): s is SessionMetadata => s !== undefined);
		const pinnedSet = new Set(this.pinned);
		const recent = filtered.filter((s) => !pinnedSet.has(s.id));
		return html`
			<div class="absolute inset-0 z-40 flex" @keydown=${(e: KeyboardEvent) => e.key === "Escape" && this.onToggle(false)}>
				<div class="w-[min(320px,85%)] h-full flex flex-col bg-background border-r border-border shadow-xl">
					<div class="flex items-center justify-between px-2 py-1.5 border-b border-border">
						<span class="text-sm font-medium px-1">${i18n("Sessions")}</span>
						<div class="flex items-center gap-0.5">
							${Button({ variant: "ghost", size: "sm", children: icon(Plus, "sm"), title: i18n("New Session"), onClick: () => this.onNew() })}
							${Button({
								variant: "ghost",
								size: "sm",
								children: icon(FolderCog, "sm"),
								title: i18n("Manage sessions (import, export, bulk delete)"),
								onClick: () =>
									SitegeistSessionListDialog.open(
										(id) => this.onSelect(id),
										(id) => this.onDeleted(id),
									),
							})}
							${Button({ variant: "ghost", size: "sm", children: icon(X, "sm"), title: i18n("Close"), onClick: () => this.onToggle(false) })}
						</div>
					</div>
					<div class="px-2 py-1.5">
						<input
							type="text"
							placeholder=${i18n("Search sessions...")}
							.value=${this.query}
							@input=${(e: InputEvent) => {
								this.query = (e.target as HTMLInputElement).value;
							}}
							class="w-full px-2 py-1 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
						/>
						<div class="flex gap-1 pt-1.5">
							${this.filterOptions().map(
								(f) => html`<button
									class="px-2 py-0.5 rounded text-[11px] ${this.agentFilter === f ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50"}"
									@click=${() => {
										this.agentFilter = f;
									}}
								>${f === "all" ? "All" : f === "browser" ? "Browser agent" : f === MAIN_AGENT_ID ? "prime-agent" : f}</button>`,
							)}
						</div>
					</div>
					<div class="flex-1 overflow-y-auto px-1 pb-2">
						${
							pinnedRows.length > 0
								? html`
									<div class="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">${i18n("Pinned")}</div>
									${pinnedRows.map((s) => this.row(s, this.pinned.indexOf(s.id)))}
								`
								: ""
						}
						<div class="px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">${i18n("Recent")}</div>
						${
							recent.length === 0 && pinnedRows.length === 0
								? html`<div class="px-2 py-4 text-center text-xs text-muted-foreground">${this.query ? i18n("No matching sessions") : i18n("No sessions yet")}</div>`
								: recent.map((s) => this.row(s, undefined))
						}
					</div>
				</div>
				<div class="flex-1 bg-black/30" @click=${() => this.onToggle(false)}></div>
			</div>
		`;
	}
}
