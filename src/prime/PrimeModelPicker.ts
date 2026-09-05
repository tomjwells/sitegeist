import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import type { Model } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";

/** Picks one of the models the prime bridge session reports as available (its own catalog, not the browser's). */
@customElement("prime-model-picker")
export class PrimeModelPicker extends DialogBase {
	@state() private query = "";
	private models: Model<any>[] = [];
	private current: Model<any> | undefined;
	private onSelect: ((model: Model<any>) => void) | undefined;
	protected modalWidth = "min(640px, 95vw)";
	protected modalHeight = "min(70vh, 640px)";

	static open(models: Model<any>[], current: Model<any> | undefined, onSelect: (model: Model<any>) => void): void {
		const dialog = new PrimeModelPicker();
		dialog.models = models;
		dialog.current = current;
		dialog.onSelect = onSelect;
		dialog.open();
	}

	private filtered(): Model<any>[] {
		const q = this.query.trim().toLowerCase();
		if (!q) return this.models;
		return this.models.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q));
	}

	protected renderContent(): TemplateResult {
		const groups = new Map<string, Model<any>[]>();
		for (const m of this.filtered()) {
			const list = groups.get(m.provider) ?? [];
			list.push(m);
			groups.set(m.provider, list);
		}
		return html`
			<div class="flex flex-col h-full">
				<div class="p-3 border-b border-border">
					<div class="text-sm font-medium mb-2">prime-agent model (R730 catalog)</div>
					${Input({
						type: "text",
						value: this.query,
						placeholder: "Filter…",
						className: "text-sm w-full",
						onInput: (e: Event) => {
							this.query = (e.target as HTMLInputElement).value;
						},
					})}
				</div>
				<div class="flex-1 overflow-y-auto p-2">
					${Array.from(groups.entries()).map(
						([provider, models]) => html`
							<div class="text-[11px] uppercase tracking-wide text-muted-foreground px-2 pt-2 pb-1">${provider}</div>
							${models.map((m) => {
								const isCurrent = this.current?.id === m.id && this.current?.provider === m.provider;
								return html`<button
									class="w-full text-left px-2 py-1.5 rounded text-sm hover:bg-secondary ${isCurrent ? "bg-secondary font-medium" : ""}"
									@click=${() => {
										this.onSelect?.(m);
										this.close();
									}}
								>
									<span>${m.name || m.id}</span>
									<span class="text-[11px] text-muted-foreground ml-2">${m.id}${m.reasoning ? " · thinking" : ""}</span>
								</button>`;
							})}
						`,
					)}
					${groups.size === 0 ? html`<div class="p-4 text-sm text-muted-foreground">No models match.</div>` : ""}
				</div>
				<div class="p-2 border-t border-border flex justify-end">${Button({ variant: "ghost", size: "sm", children: "Close", onClick: () => this.close() })}</div>
			</div>
		`;
	}
}
