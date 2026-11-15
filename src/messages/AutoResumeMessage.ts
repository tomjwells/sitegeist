import type { MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html } from "lit";

/**
 * The relay's resume prompt after a restart cut a turn (cors-proxy turn supervisor, 2026-11-15): a user message in the
 * agent's history, but not from Tom. One muted line instead of a bubble; the full prompt is its tooltip.
 */
export interface AutoResumeMessage {
	role: "auto-resume";
	text: string;
	/** "15:37" (UTC), from the prompt */
	cutAt?: string;
	timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"auto-resume": AutoResumeMessage;
	}
}

const autoResumeRenderer: MessageRenderer<AutoResumeMessage> = {
	render: (m) =>
		html`<div class="sg-auto-resume mx-4 my-1 flex items-center gap-2 text-xs text-muted-foreground" title=${m.text}>
			<span class="inline-block h-1.5 w-1.5 rounded-full bg-amber-500"></span>
			<span>Turn cut by a restart${m.cutAt ? ` at ${m.cutAt} UTC` : ""} · resumed automatically</span>
		</div>`,
};

export function registerAutoResumeRenderer(): void {
	registerMessageRenderer("auto-resume", autoResumeRenderer);
}
