import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { SEND_ACTION_EVENT, type SendActionDetail, sendStateOf } from "../prime/send-state.js";

/**
 * Queued messages shelved on top of the prompt box (Tom, 2026-11-15: "can we have queued messages stack above the
 * prompt box? ... I don't want them to enter the chat quite in the way that they did ... edit and cancel ... same grey
 * colour as the prompt box, but ... shelved on top of it"). A message sent with Queue / Alt+Enter waits here, one row
 * each, oldest first, until its turn starts; then it enters the chat like any message. The rows are the same messages
 * the agent keeps (send state "queued", or "sending" in follow-up mode while the queue request is in flight); the chat
 * itself no longer draws them (UserMessageRenderer). Edit / Cancel dispatch the same send actions the bubble did.
 * Rendered by the patched pi-web-ui AgentInterface just above <message-editor> (scripts/build.mjs).
 */
export function isShelved(message: unknown): boolean {
	const send = sendStateOf(message);
	return send?.state === "queued" || (send?.state === "sending" && send.mode === "followUp");
}

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const c: unknown = message.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.map((part: unknown) =>
			typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
				? String(part.text)
				: "",
		)
		.join(" ");
}

function attachmentCount(message: AgentMessage): number {
	const a: unknown = "attachments" in message ? message.attachments : undefined;
	return Array.isArray(a) ? a.length : 0;
}

@customElement("sg-queue-shelf")
export class QueueShelf extends LitElement {
	@property({ attribute: false }) messages: AgentMessage[] = [];

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private act(detail: SendActionDetail): void {
		this.dispatchEvent(
			new CustomEvent<SendActionDetail>(SEND_ACTION_EVENT, { detail, bubbles: true, composed: true }),
		);
	}

	override render() {
		const queued = this.messages.filter(isShelved);
		if (queued.length === 0) return nothing;
		return html`<div class="sg-queue-shelf mx-3 -mb-px flex flex-col gap-px overflow-hidden rounded-t-xl border border-b-0 border-border bg-card/70 text-xs" role="list" aria-label="Queued messages">
			${queued.map((m, i) => {
				const send = sendStateOf(m);
				const id = send?.id ?? "";
				const pending = send?.state === "sending";
				const files = attachmentCount(m);
				const text = textOf(m).replace(/\s+/g, " ").trim() || (files > 0 ? "(attachment)" : "");
				return html`<div class="sg-queued-item flex items-start gap-2 px-3 py-1.5 ${i > 0 ? "border-t border-border/60" : ""}" role="listitem" data-send-id=${id}>
					<span class="shrink-0 pt-px text-muted-foreground tabular-nums" title=${pending ? "Queueing…" : "Queued: runs when the agent is free"}>${pending ? "…" : `${i + 1}.`}</span>
					<span class="sg-queued-text min-w-0 flex-1 text-foreground/90 line-clamp-2 break-words" title=${text}>${text}${files > 0 && textOf(m).trim() ? html` <span class="text-muted-foreground">· ${files} file${files === 1 ? "" : "s"}</span>` : ""}</span>
					${
						pending
							? html`<span class="shrink-0 text-muted-foreground">Queueing…</span>`
							: html`<button type="button" class="sg-queued-edit shrink-0 text-muted-foreground hover:text-foreground underline-offset-2 hover:underline" title="Take it out of the queue and put it back in the prompt box" @click=${() => this.act({ id, action: "edit" })}>Edit</button>
							<button type="button" class="sg-queued-cancel shrink-0 text-muted-foreground hover:text-destructive underline-offset-2 hover:underline" title="Remove it from the queue" @click=${() => this.act({ id, action: "cancel" })}>Cancel</button>`
					}
				</div>`;
			})}
		</div>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"sg-queue-shelf": QueueShelf;
	}
}
