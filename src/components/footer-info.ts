/**
 * Bottom-left build + session line under the prompt box (Tom, 2026-10-10): "v1.0.0 · <build sha> · <session id>",
 * light grey. Lets Tom see which build he runs and puts both in every screenshot for diagnosis; click copies the
 * session id (pastable into the sessions sidebar search). Rendered by the patched pi-web-ui AgentInterface
 * footer (scripts/build.mjs); sidepanel.ts feeds the session id via setFooterSession().
 */
import { html, type TemplateResult } from "lit";

declare const __SITEGEIST_BUILD__: { sha: string; dirty: boolean; builtAt: string };

let sessionId: string | undefined;
let copiedUntil = 0;

export function setFooterSession(id: string | undefined): void {
	sessionId = id;
}

function manifestVersion(): string {
	try {
		return chrome.runtime.getManifest().version;
	} catch {
		return "?";
	}
}

/** Short form for long local UUIDs; sg-… ids are short already. */
function shortId(id: string): string {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? `${id.slice(0, 8)}…` : id;
}

export function footerInfo(requestUpdate: () => void): TemplateResult {
	const build = `${__SITEGEIST_BUILD__.sha}${__SITEGEIST_BUILD__.dirty ? "-dirty" : ""}`;
	const id = sessionId;
	const copy = async () => {
		if (!id) return;
		try {
			await navigator.clipboard.writeText(id);
			copiedUntil = Date.now() + 1500;
			requestUpdate();
			setTimeout(requestUpdate, 1600);
		} catch {
			/* clipboard blocked: the tooltip still shows the full id */
		}
	};
	const copied = Date.now() < copiedUntil;
	return html`<span
		class="sg-footer-info text-[10px] text-muted-foreground/70 whitespace-nowrap select-text"
		title=${`sitegeist-dev v${manifestVersion()} · build ${build} (${__SITEGEIST_BUILD__.builtAt})${id ? ` · session ${id} — click the id to copy` : ""}`}
		>v${manifestVersion()} · ${build}${
			id
				? html` · <span class="sg-footer-session cursor-pointer hover:text-foreground" @click=${copy}>${copied ? "copied" : shortId(id)}</span>`
				: html` · new session`
		}</span
	>`;
}
