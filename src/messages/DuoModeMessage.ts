import type { MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html } from "lit";

/**
 * Duo's mode, one muted line in an R730 chat (Tom, 2026-11-15: new sitegeist chats run duo / duo-start). The duo
 * extension adds a run note ("[duo] mode=planning …", custom message `duo-role`) at the start of each run; the panel
 * shows it as "Planning mode" / "Implementation mode", and only when the mode changes (prime-agent.ts duoModeOf).
 */
export interface DuoModeMessage {
	role: "duo-mode";
	mode: "planning" | "implementation";
	timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"duo-mode": DuoModeMessage;
	}
}

const duoModeRenderer: MessageRenderer<DuoModeMessage> = {
	render: (m) =>
		html`<div class="sg-duo-mode mx-4 my-1 flex items-center gap-2 text-xs text-muted-foreground" data-mode=${m.mode}>
			<span class="inline-block h-1.5 w-1.5 rounded-full ${m.mode === "planning" ? "bg-violet-500" : "bg-sky-500"}"></span>
			<span>${m.mode === "planning" ? "Planning mode" : "Implementation mode"}</span>
		</div>`,
};

export function registerDuoModeRenderer(): void {
	registerMessageRenderer("duo-mode", duoModeRenderer);
}
