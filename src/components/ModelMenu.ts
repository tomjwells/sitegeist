/**
 * The composer's model menu (Tom, 2026-11-07: "the thinking menu is so quick to use ... two clicks and bam, it's done.
 * With the model selection menu, is much much worse ... can we make it a dropdown menu? ... maybe a combo box if I
 * want to filter down"). A dropdown anchored to the model button, opened at once from the cached list
 * (src/prime/model-cache.ts): click the button, click a model. Typing filters (all words must match name, id or
 * provider); Up/Down + Enter pick from the keyboard; Esc or a click outside closes. Recently picked models come first.
 * Replaces the full-screen PrimeModelPicker / ModelSelector dialogs for both R730 chats and the Browser agent.
 */
import type { Model } from "@mariozechner/pi-ai";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { type ModelRow, orderModels } from "./model-menu-order.js";

export interface ModelMenuOptions {
	/** The model button; the menu opens above it, right edges aligned. */
	anchor: HTMLElement | null;
	models: Model<any>[];
	current: Model<any> | undefined;
	/** True while the first list is still on its way (nothing cached yet). */
	loading?: boolean;
	onPick: (model: Model<any>) => void;
	/** Optional last row, e.g. the Browser agent's full provider dialog. */
	extra?: { label: string; onClick: () => void };
	/** Where recently picked models are remembered (per brain: "prime:quantcoach", "browser"). */
	recentKey: string;
}

const RECENT_MAX = 5;
const recentStorageKey = (k: string): string => `sg_recent_models_${k}`;
const modelKey = (m: Pick<Model<any>, "provider" | "id">): string => `${m.provider}/${m.id}`;

function readRecent(k: string): string[] {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(recentStorageKey(k)) ?? "[]");
		return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
	} catch {
		return [];
	}
}

function rememberRecent(k: string, m: Model<any>): void {
	const next = [modelKey(m), ...readRecent(k).filter((x) => x !== modelKey(m))].slice(0, RECENT_MAX);
	try {
		localStorage.setItem(recentStorageKey(k), JSON.stringify(next));
	} catch {
		/* storage full or blocked: recents are a nicety */
	}
}

@customElement("sg-model-menu")
export class ModelMenu extends LitElement {
	@state() private query = "";
	@state() private active = 0;
	@state() private models: Model<any>[] = [];
	@state() private loading = false;
	@state() private error = "";
	private opts: ModelMenuOptions | undefined;
	private static openMenu: ModelMenu | undefined;
	private readonly onDocPointer = (e: PointerEvent): void => {
		const path = e.composedPath();
		if (path.includes(this)) return;
		if (this.opts?.anchor && path.includes(this.opts.anchor)) return; // the button toggles (its own click closes)
		this.close();
	};
	private readonly onResize = (): void => this.close();

	protected createRenderRoot(): HTMLElement {
		return this;
	}

	/** Open the menu (a second click on the button while it is open closes it, like a native dropdown). */
	static open(opts: ModelMenuOptions): ModelMenu | undefined {
		const prev = ModelMenu.openMenu;
		if (prev) {
			const sameAnchor = prev.opts?.anchor === opts.anchor;
			prev.close();
			if (sameAnchor) return undefined;
		}
		const menu = new ModelMenu();
		menu.opts = opts;
		menu.models = opts.models;
		menu.loading = opts.loading === true && opts.models.length === 0;
		document.body.appendChild(menu);
		ModelMenu.openMenu = menu;
		return menu;
	}

	static isOpen(): boolean {
		return ModelMenu.openMenu !== undefined;
	}

	/** A fresher list arrived (background refresh): keep the query, keep the highlighted model if it is still there. */
	setModels(models: Model<any>[]): void {
		const rows = this.rows();
		const keep = rows[this.active]?.model;
		this.models = models;
		this.loading = false;
		this.error = "";
		if (keep) {
			const at = this.rows().findIndex((r) => modelKey(r.model) === modelKey(keep));
			if (at >= 0) this.active = at;
		}
	}

	setError(message: string): void {
		this.loading = false;
		if (this.models.length === 0) this.error = message;
	}

	connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("pointerdown", this.onDocPointer, true);
		window.addEventListener("resize", this.onResize);
		window.addEventListener("blur", this.onResize);
		const cur = this.opts?.current;
		const at = cur ? this.rows().findIndex((r) => modelKey(r.model) === modelKey(cur)) : -1;
		this.active = Math.max(0, at);
	}

	disconnectedCallback(): void {
		document.removeEventListener("pointerdown", this.onDocPointer, true);
		window.removeEventListener("resize", this.onResize);
		window.removeEventListener("blur", this.onResize);
		super.disconnectedCallback();
	}

	protected firstUpdated(): void {
		this.querySelector<HTMLInputElement>("input")?.focus();
		this.scrollActiveIntoView();
	}

	protected updated(): void {
		this.scrollActiveIntoView();
	}

	close(): void {
		if (ModelMenu.openMenu === this) ModelMenu.openMenu = undefined;
		this.remove();
	}

	private rows(): ModelRow[] {
		return orderModels(this.models, this.query, readRecent(this.opts?.recentKey ?? ""));
	}

	private pick(m: Model<any>): void {
		if (this.opts) rememberRecent(this.opts.recentKey, m);
		const cb = this.opts?.onPick;
		this.close();
		cb?.(m);
	}

	private scrollActiveIntoView(): void {
		this.querySelector<HTMLElement>(`[data-row="${this.active}"]`)?.scrollIntoView({ block: "nearest" });
	}

	private onKey(e: KeyboardEvent, rows: ModelRow[]): void {
		if (e.key === "Escape") {
			e.preventDefault();
			this.close();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			this.active = rows.length === 0 ? 0 : (this.active + 1) % rows.length;
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			this.active = rows.length === 0 ? 0 : (this.active - 1 + rows.length) % rows.length;
		} else if (e.key === "Enter") {
			e.preventDefault();
			const row = rows[this.active];
			if (row) this.pick(row.model);
		}
	}

	private position(): string {
		const r = this.opts?.anchor?.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const width = Math.min(380, vw - 16);
		if (!r) return `position:fixed;right:8px;bottom:72px;width:${width}px;max-height:${Math.round(vh * 0.6)}px;`;
		const right = Math.max(8, Math.min(vw - r.right, vw - width - 8));
		const spaceAbove = r.top - 8;
		const spaceBelow = vh - r.bottom - 8;
		if (spaceAbove >= 240 || spaceAbove >= spaceBelow) {
			return `position:fixed;right:${right}px;bottom:${Math.round(vh - r.top + 6)}px;width:${width}px;max-height:${Math.round(Math.min(spaceAbove, vh * 0.7))}px;`;
		}
		return `position:fixed;right:${right}px;top:${Math.round(r.bottom + 6)}px;width:${width}px;max-height:${Math.round(Math.min(spaceBelow, vh * 0.7))}px;`;
	}

	protected render(): TemplateResult {
		const rows = this.rows();
		if (this.active >= rows.length) this.active = Math.max(0, rows.length - 1);
		const cur = this.opts?.current;
		let lastGroup = "";
		return html`
			<div
				class="sg-model-menu z-50 flex flex-col border border-border bg-popover text-popover-foreground shadow-md rounded-md overflow-hidden"
				style=${this.position()}
				role="listbox"
				@keydown=${(e: KeyboardEvent) => this.onKey(e, rows)}
			>
				<div class="flex-1 overflow-y-auto py-1" style="min-height:0">
					${rows.map((row, i) => {
						const header = row.group !== lastGroup ? row.group : "";
						lastGroup = row.group;
						const isCurrent = cur !== undefined && modelKey(cur) === modelKey(row.model);
						const label = row.model.name || row.model.id;
						return html`
							${header ? html`<div class="text-[10px] uppercase tracking-wide text-muted-foreground px-3 pt-2 pb-0.5">${header}</div>` : nothing}
							<button
								data-row=${i}
								role="option"
								aria-selected=${isCurrent ? "true" : "false"}
								class="w-full flex items-baseline gap-2 text-left px-3 py-1.5 text-sm ${i === this.active ? "bg-accent text-accent-foreground" : "text-foreground"}"
								style="transition:none"
								@mousemove=${() => {
									if (this.active !== i) this.active = i;
								}}
								@click=${() => this.pick(row.model)}
							>
								<span class="w-3 shrink-0 text-primary">${isCurrent ? "✓" : ""}</span>
								<span class="truncate">${label}</span>
								${label !== row.model.id ? html`<span class="ml-auto pl-2 text-[11px] text-muted-foreground font-mono truncate">${row.model.id}</span>` : nothing}
							</button>
						`;
					})}
					${this.loading ? html`<div class="px-3 py-2 text-sm text-muted-foreground">Loading models…</div>` : nothing}
					${this.error ? html`<div class="px-3 py-2 text-sm text-destructive">${this.error}</div>` : nothing}
					${!this.loading && !this.error && rows.length === 0 ? html`<div class="px-3 py-2 text-sm text-muted-foreground">No models match.</div>` : nothing}
				</div>
				${
					this.opts?.extra
						? html`<button class="text-left px-3 py-1.5 text-xs text-muted-foreground border-t border-border hover:bg-accent" @click=${() => {
								const extra = this.opts?.extra;
								this.close();
								extra?.onClick();
							}}>${this.opts.extra.label}</button>`
						: nothing
				}
				<div class="border-t border-border p-1.5">
					<input
						type="text"
						class="w-full bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
						placeholder="Filter models…"
						.value=${this.query}
						@input=${(e: Event) => {
							// the listener sits on this <input>, so its target is that input
							this.query = (e.target as HTMLInputElement).value;
							this.active = 0;
						}}
					/>
				</div>
			</div>
		`;
	}
}
