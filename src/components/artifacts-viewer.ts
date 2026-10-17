/**
 * Viewer mode of sidepanel.html (?view=artifacts&token=<id>): the fullscreen window that src/components/
 * artifacts-fullscreen.ts opens from the side panel / sidebar (2026-10-17). It shows only pi-web-ui's ArtifactsPanel,
 * filled with the artifacts the panel handed over and starting on the one Tom was looking at, so artifacts render
 * exactly as in the panel (tabs, download, PDF viewer, HTML in the sandbox). Esc, the exit button or the close X close
 * the window. No session, agent, lock or relay connection: initApp never runs in this mode.
 */
import { ArtifactsPanel } from "@mariozechner/pi-web-ui";
import {
	ARTIFACTS_VIEW_PARAM,
	closeViewerWindow,
	requestViewedArtifacts,
	setArtifactsViewerMode,
} from "./artifacts-fullscreen.js";

/** The handoff token when this document is the fullscreen viewer, else undefined (the normal panel). */
export function artifactsViewerToken(): string | undefined {
	const params = new URLSearchParams(window.location.search);
	return params.get("view") === ARTIFACTS_VIEW_PARAM ? (params.get("token") ?? undefined) : undefined;
}

function showNotice(text: string): void {
	const box = document.createElement("div");
	box.className = "h-full w-full flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground";
	const line = document.createElement("p");
	line.textContent = text;
	const close = document.createElement("button");
	close.className = "px-3 py-1 rounded border border-border text-foreground hover:bg-secondary";
	close.textContent = "Close this window";
	close.addEventListener("click", () => void closeViewerWindow());
	box.append(line, close);
	document.body.replaceChildren(box);
}

export async function startArtifactsViewer(token: string): Promise<void> {
	setArtifactsViewerMode();
	document.title = "Artifacts - sitegeist";
	// Capture phase, ahead of the panel's own Escape handling: here Escape only closes the window.
	window.addEventListener(
		"keydown",
		(e) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopImmediatePropagation();
			void closeViewerWindow();
		},
		true,
	);
	const payload = await requestViewedArtifacts(token);
	if (!payload || payload.artifacts.length === 0) {
		showNotice(
			"These artifacts are no longer available: the sitegeist panel was closed or opened another chat. Esc closes this window.",
		);
		return;
	}
	const panel = new ArtifactsPanel();
	panel.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");
	panel.onClose = () => void closeViewerWindow();
	panel.style.display = "block";
	panel.style.height = "100%";
	document.body.replaceChildren(panel);
	const now = new Date().toISOString();
	const messages = payload.artifacts.map((a) => ({
		role: "artifact" as const,
		action: "create" as const,
		filename: a.filename,
		content: a.content,
		timestamp: now,
	}));
	await panel.reconstructFromMessages(messages);
	if (payload.active !== undefined && panel.artifacts.has(payload.active)) panel.openArtifact(payload.active);
	if (payload.active !== undefined) document.title = `${payload.active} - sitegeist`;
}
