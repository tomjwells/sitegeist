import type { Attachment, MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer, type UserMessageWithAttachments } from "@mariozechner/pi-web-ui";
import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { SEND_ACTION_EVENT, type SendActionDetail, sendStateOf } from "../prime/send-state.js";

/**
 * Custom user message component for Sitegeist with fancy pill styling.
 * Duplicates the web-ui UserMessage but with our custom styling.
 */
@customElement("sitegeist-user-message")
export class SitegeistUserMessage extends LitElement {
	@property({ type: Object }) message!: UserMessageWithAttachments;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	/** Retry / Discard on a message the R730 has not got: the side panel routes the event to the chat's agent. */
	private sendAction(detail: SendActionDetail): void {
		this.dispatchEvent(
			new CustomEvent<SendActionDetail>(SEND_ACTION_EVENT, { detail, bubbles: true, composed: true }),
		);
	}

	/** Under the bubble: nothing when the R730 has the message, "sending" while it is on its way, Retry/Discard when it failed. */
	private renderSendState() {
		const send = sendStateOf(this.message);
		if (!send) return nothing;
		if (send.state === "sending")
			return html`<div class="sg-send-state ml-4 mt-1 text-xs text-muted-foreground" data-send-state="sending">Sending…</div>`;
		return html`<div class="sg-send-state ml-4 mt-1 text-xs text-red-500 flex flex-wrap items-center gap-x-3 gap-y-1" data-send-state="failed">
			<span>Not sent${send.error ? ` (${send.error})` : ""}. It goes out when the connection is back.</span>
			<button type="button" class="underline hover:no-underline" @click=${() => this.sendAction({ id: send.id, action: "retry" })}>Retry now</button>
			<button type="button" class="underline hover:no-underline opacity-80" @click=${() => this.sendAction({ id: send.id, action: "discard" })}>Discard</button>
		</div>`;
	}

	override render() {
		const content =
			typeof this.message.content === "string"
				? this.message.content
				: (this.message.content.find((c) => c.type === "text") as { type: "text"; text: string } | undefined)
						?.text || "";
		const send = sendStateOf(this.message);

		return html`
			<div class="flex justify-start ml-4">
				<div class="user-message-container py-2 px-4 rounded-xl ${send?.state === "failed" ? "sg-unsent" : ""}">
					<markdown-block .content=${content}></markdown-block>
					${
						this.message.attachments && this.message.attachments.length > 0
							? html`
								<div class="mt-3 flex flex-wrap gap-2">
									${this.message.attachments.map(
										(attachment: Attachment) =>
											html` <attachment-tile .attachment=${attachment}></attachment-tile> `,
									)}
								</div>
							`
							: ""
					}
				</div>
			</div>
			${this.renderSendState()}
		`;
	}
}

export function createUserMessageRenderer(): MessageRenderer<UserMessageWithAttachments> {
	return {
		render: (message) => {
			return html`<sitegeist-user-message .message=${message}></sitegeist-user-message>`;
		},
	};
}

export function registerUserMessageRenderer() {
	registerMessageRenderer("user", createUserMessageRenderer());
}
