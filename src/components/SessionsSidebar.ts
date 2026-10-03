import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import type { SessionMetadata } from "@mariozechner/pi-web-ui";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { FolderCog, Link2Off, Pin, PinOff, Plus, Trash2, X } from "lucide";
import { type AnchorBinding, AnchorsStore, chromeLocalBackend } from "../anchors/anchors.js";
import { SitegeistSessionListDialog } from "../dialogs/SessionListDialog.js";
import { agentIdFromSessionId, isPrimeSessionId, MAIN_AGENT_ID } from "../prime/constants.js";
import { primeNativeIds } from "../prime/prime-client.js";
import {
	pastedSessionId,
	type SearchEntry,
	type SearchRecord,
	type SnippetSegment,
	searchSessions,
	sessionsMatchingId,
	sgIdForNative,
} from "../sessions/session-search.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
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
	/** Page key of the tab Tom is on (undefined = page cannot anchor); drives the "This page" section. */
	@property({ type: String }) activeKey: string | undefined;
	@property({ type: String }) activeTitle = "";
	@property({ attribute: false }) onDetached: (sessionId: string, key: string) => void = () => {};

	@state() private sessions: SessionMetadata[] = [];
	@state() private anchors: AnchorBinding[] = [];
	/** Full-text index records by session id (loaded on open; older sessions indexed lazily). */
	@state() private searchIndex = new Map<string, SearchRecord>();
	/** Sessions still being indexed for search (count shown next to the search box). */
	@state() private indexing = 0;
	private indexingRun: Promise<void> | undefined;
	/** main-pi sg-… session → its harness UUIDs on the R730 (relay /native-ids), so pasted UUIDs resolve. */
	@state() private nativeIds = new Map<string, string[]>();
	/** false = not fetched yet or relay unreachable (then a UUID miss is not proof it is a Telegram session). */
	private nativeIdsLoaded = false;
	private readonly anchorsStore = new AnchorsStore(chromeLocalBackend());
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
		else if (changed.has("activeKey") && this.open) void this.refreshAnchors();
	}

	private async refreshAnchors(): Promise<void> {
		this.anchors = await this.anchorsStore.all();
	}

	async refresh(): Promise<void> {
		const storage = getSitegeistStorage();
		try {
			const [sessions, pinned, lockResponse, win, anchors, index] = await Promise.all([
				storage.sessions.getAllMetadata(),
				storage.settings.get<string[]>(SESSIONS_PINNED_SETTING),
				port.sendMessage({ type: "getLockedSessions" }),
				chrome.windows.getCurrent(),
				this.anchorsStore.all(),
				storage.sessionSearch.all(),
			]);
			this.sessions = sessions;
			const ids = new Set(sessions.map((s) => s.id));
			this.pinned = (pinned ?? []).filter((id) => ids.has(id));
			this.anchors = anchors.filter((b) => ids.has(b.sessionId));
			this.searchIndex = new Map(index.map((r) => [r.id, r]));
			void this.ensureIndexed();
			void this.loadNativeIds();
			this.locks = lockResponse.locks || {};
			this.windowId = win.id;
		} catch (err) {
			console.error("[SessionsSidebar] refresh failed:", err);
		}
	}

	/**
	 * Index sessions the search store does not have yet (saved before the index existed) or has a stale
	 * copy of. One at a time, newest first, so the panel stays responsive; results appear as they land.
	 */
	private ensureIndexed(): Promise<void> {
		if (this.indexingRun) return this.indexingRun;
		const storage = getSitegeistStorage();
		const stale = this.sessions.filter((s) => {
			const r = this.searchIndex.get(s.id);
			return !r || r.lastModified !== s.lastModified || r.messageCount !== s.messageCount;
		});
		if (stale.length === 0) return Promise.resolve();
		this.indexing = stale.length;
		this.indexingRun = (async () => {
			for (const meta of stale) {
				try {
					const data = await storage.sessions.loadSession(meta.id);
					if (data) {
						const prev = this.searchIndex.get(meta.id);
						const record = await storage.sessionSearch.index(
							meta.id,
							meta.title,
							data.messages,
							meta.lastModified,
							prev?.aliases ?? [],
						);
						this.searchIndex = new Map(this.searchIndex).set(meta.id, record);
					}
				} catch (err) {
					console.warn("[SessionsSidebar] indexing failed for", meta.id, err);
				}
				this.indexing = Math.max(0, this.indexing - 1);
			}
		})().finally(() => {
			this.indexing = 0;
			this.indexingRun = undefined;
		});
		return this.indexingRun;
	}

	private async loadNativeIds(): Promise<void> {
		try {
			this.nativeIds = await primeNativeIds(MAIN_AGENT_ID);
			this.nativeIdsLoaded = true;
		} catch (err) {
			console.warn("[SessionsSidebar] native ids unavailable (relay unreachable?)", err);
		}
	}

	private aliasesOf(id: string): string[] {
		return [...(this.searchIndex.get(id)?.aliases ?? []), ...(this.nativeIds.get(id) ?? [])];
	}

	private async savePinned(next: string[]) {
		this.pinned = next;
		await getSitegeistStorage().settings.set(SESSIONS_PINNED_SETTING, next);
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
		const storage = getSitegeistStorage();
		await storage.sessions.deleteSession(id);
		await storage.sessionSearch.remove(id).catch(() => undefined);
		await this.refresh();
		this.onDeleted(id);
	}

	private async detach(sessionId: string, key: string, e: Event) {
		e.stopPropagation();
		await this.anchorsStore.detach(key, sessionId);
		await this.refreshAnchors();
		this.onDetached(sessionId, key);
	}

	/** Sessions bound to the page Tom is on, most recently used first. */
	private forThisPage(): AnchorBinding[] {
		const key = this.activeKey;
		if (!key) return [];
		return this.anchors.filter((b) => b.key === key).sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
	}

	private pageCount(sessionId: string): number {
		return this.anchors.filter((b) => b.sessionId === sessionId).length;
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

	/** Search results computed in render (plain field, not @state: setting state during render would loop). */
	private results: Map<string, { snippet: SnippetSegment[]; hits: number; byId: boolean }> | undefined;

	/**
	 * No query → the pool in recency order. A pasted id (sg-…, UUID, finder line, jsonl path) → sessions with
	 * that id or alias. Otherwise exact, case-insensitive full-text search over the whole transcript + bound
	 * pages (every term must occur), ranked by hits; sessions not yet indexed fall back to title + preview.
	 */
	private filtered(): SessionMetadata[] {
		const q = this.query.trim();
		const pool =
			this.agentFilter === "all"
				? this.sessions
				: this.sessions.filter((s) => this.agentOf(s.id) === this.agentFilter);
		if (!q) {
			this.results = undefined;
			return pool;
		}
		const byId = new Map(pool.map((s) => [s.id, s]));
		const pasted = pastedSessionId(q);
		if (pasted) {
			const ids = sessionsMatchingId(
				pasted,
				pool.map((s) => ({ id: s.id, aliases: this.aliasesOf(s.id) })),
			);
			this.results = new Map(
				ids.map((id) => [id, { snippet: [{ text: `id ${id}`, hit: false }], hits: 1, byId: true }]),
			);
			return ids.map((id) => byId.get(id)).filter((s): s is SessionMetadata => s !== undefined);
		}
		const pagesBySession = new Map<string, string[]>();
		for (const b of this.anchors) {
			const list = pagesBySession.get(b.sessionId) ?? [];
			list.push(`${b.pageTitle} ${b.url}`);
			pagesBySession.set(b.sessionId, list);
		}
		const entries: SearchEntry[] = pool.map((s) => {
			const record = this.searchIndex.get(s.id);
			return {
				id: s.id,
				title: s.title,
				text: record?.text ?? s.preview,
				extra: (pagesBySession.get(s.id) ?? []).join("\n"),
				lastModified: s.lastModified,
			};
		});
		const hits = searchSessions(q, entries);
		this.results = new Map(hits.map((h) => [h.id, { snippet: h.snippet, hits: h.hits, byId: false }]));
		return hits.map((h) => byId.get(h.id)).filter((s): s is SessionMetadata => s !== undefined);
	}

	private noMatchText(): string {
		const q = this.query.trim();
		if (!q) return i18n("No sessions yet");
		const pasted = pastedSessionId(q);
		if (pasted) {
			const sg = sgIdForNative(pasted, this.nativeIds);
			if (sg)
				return `${pasted} is sitegeist session ${sg}, but that session is not in this browser's list (it was started from another browser or profile).`;
			if (/^[0-9a-f]{8}-/.test(pasted) && this.nativeIdsLoaded)
				return `${pasted} is not a main-pi sitegeist session — it is a Telegram or CLI session (open it with /session_resume in Telegram). For a coach's sitegeist session, paste its sg-<coach>-… id.`;
			return `No session with id ${pasted} in this browser.`;
		}
		if (this.indexing > 0)
			return `No match yet — still indexing ${this.indexing} session${this.indexing === 1 ? "" : "s"}…`;
		return 'No session contains every word (exact, case-insensitive, whole transcript; use "quotes" for a phrase).';
	}

	private snippet(id: string): TemplateResult | "" {
		const r = this.results?.get(id);
		if (!r) return "";
		return html`<div class="text-[11px] text-muted-foreground/90 truncate" title=${r.snippet.map((s) => s.text).join("")}>
			${r.snippet.map((s) => (s.hit ? html`<mark class="bg-yellow-300/40 text-foreground rounded-sm px-0.5">${s.text}</mark>` : s.text))}
			${!r.byId && r.hits > 1 ? html` <span class="opacity-70">×${r.hits}</span>` : ""}
		</div>`;
	}

	private row(session: SessionMetadata, pinnedIndex: number | undefined, binding?: AnchorBinding): TemplateResult {
		const locked = this.isLocked(session.id);
		const current = session.id === this.currentSessionId;
		const isPinned = pinnedIndex !== undefined;
		const pages = this.pageCount(session.id);
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
						${pages > 0 ? html` · <span title=${`Bound to ${pages} page${pages === 1 ? "" : "s"}`}>${pages} ${pages === 1 ? "page" : "pages"}</span>` : ""}
						${current ? html` · <span class="text-primary">${i18n("Current")}</span>` : ""}
						${locked ? html` · <span class="text-destructive">${i18n("Locked")}</span>` : ""}
					</div>
					${this.snippet(session.id)}
				</div>
				<div class="flex gap-0.5 shrink-0 ${isPinned ? "" : "opacity-0 group-hover:opacity-100"}">
					${
						binding
							? html`<button
								class="p-1 rounded hover:bg-secondary text-muted-foreground"
								title=${binding.pinned ? "Detach this page from the session (attached by you)" : "Detach this page from the session"}
								@click=${(e: Event) => this.detach(session.id, binding.key, e)}
							>${icon(Link2Off, "xs")}</button>`
							: ""
					}
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
		const allById = new Map(this.sessions.map((s) => [s.id, s]));
		const thisPage = this.query.trim()
			? []
			: this.forThisPage()
					.map((b) => ({ b, s: allById.get(b.sessionId) }))
					.filter((x): x is { b: AnchorBinding; s: SessionMetadata } => x.s !== undefined);
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
							placeholder="Search transcripts, or paste a session id…"
							.value=${this.query}
							@input=${(e: InputEvent) => {
								this.query = (e.target as HTMLInputElement).value;
							}}
							class="w-full px-2 py-1 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
						/>
						${
							this.indexing > 0
								? html`<div class="pt-1 text-[10px] text-muted-foreground">Indexing ${this.indexing} session${this.indexing === 1 ? "" : "s"} for search…</div>`
								: ""
						}
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
							thisPage.length > 0
								? html`
									<div class="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground truncate" title=${this.activeTitle || this.activeKey || ""}>${i18n("This page")}${this.activeTitle ? ` · ${this.activeTitle}` : ""}</div>
									${thisPage.map(({ b, s }) => this.row(s, undefined, b))}
								`
								: ""
						}
						${
							pinnedRows.length > 0
								? html`
									<div class="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">${i18n("Pinned")}</div>
									${pinnedRows.map((s) => this.row(s, this.pinned.indexOf(s.id)))}
								`
								: ""
						}
						<div class="px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">${this.query.trim() ? `${filtered.length} result${filtered.length === 1 ? "" : "s"}` : i18n("Recent")}</div>
						${
							recent.length === 0 && pinnedRows.length === 0
								? html`<div class="px-2 py-4 text-center text-xs text-muted-foreground">${this.noMatchText()}</div>`
								: recent.map((s) => this.row(s, undefined))
						}
					</div>
				</div>
				<div class="flex-1 bg-black/30" @click=${() => this.onToggle(false)}></div>
			</div>
		`;
	}
}
