/**
 * Maximize toggle for the artifacts panel (Tom, 2026-10-12: "expand it to full screen so it takes the whole
 * sidebar", for every artifact type). One flag per side-panel document, wired into pi-web-ui's compiled
 * ChatPanel and ArtifactsPanel by exact-string patches in scripts/build.mjs:
 *  - Layout (ChatPanel): at >= 800 px chat and artifacts sit side by side, 50/50. Maximized, the artifacts panel
 *    takes the full width and the chat is hidden (see CHAT_HIDDEN). Below 800 px the panel is already a
 *    full-screen overlay, so the toggle is hidden and the flag has no effect there.
 *  - Toggle (ArtifactsPanel tab bar, left of the close X; icon: hide / show the chat, so it is not mistaken for the
 *    fullscreen button next to it, src/components/artifacts-fullscreen.ts). Closing the panel also restores 50/50, so
 *    a later artifact never reopens on top of the chat. Not shown in the fullscreen window or while fullscreen.
 *  - Escape (sidepanel.ts) restores the chat. While maximized it never aborts the agent.
 * The flag is not persisted (a reload starts at 50/50); it survives switching artifact tabs.
 */
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import type { ArtifactsPanel } from "@mariozechner/pi-web-ui";
import type { ReactiveController, ReactiveControllerHost, TemplateResult } from "lit";
import { PanelLeftClose, PanelLeftOpen } from "lucide";
import { isArtifactsViewer, isPanelFullscreen } from "./artifacts-fullscreen.js";

let maximized = false;
const hosts = new Set<ReactiveControllerHost>();

export function setArtifactsMaximized(value: boolean): void {
	if (value === maximized) return;
	maximized = value;
	for (const host of hosts) host.requestUpdate();
}

class MaximizeController implements ReactiveController {
	private readonly host: ReactiveControllerHost;

	constructor(host: ReactiveControllerHost) {
		this.host = host;
	}

	hostConnected(): void {
		hosts.add(this.host);
	}

	hostDisconnected(): void {
		hosts.delete(this.host);
	}
}

/** Re-render this element (ChatPanel layout, ArtifactsPanel toggle icon) whenever the flag flips. */
export function watchArtifactsMaximized(host: ReactiveControllerHost): void {
	host.addController(new MaximizeController(host));
}

export interface ArtifactsLayout {
	/** inline style of ChatPanel's chat column */
	chat: string;
	/** inline style of ChatPanel's artifacts column */
	artifacts: string;
}

/**
 * Chat column while maximized: taken out of the flow and made invisible (no pointer, focus or accessibility), but
 * kept laid out at its usual width, so the transcript does not reflow and keeps its scroll position (display: none
 * would reset it) and the composer keeps its draft.
 */
const CHAT_HIDDEN = "position: absolute; top: 0; bottom: 0; left: 0; width: 50%; visibility: hidden;";

/** ChatPanel's column styles. Identical to upstream (50/50, or chat only) unless maximized. */
export function artifactsLayout(isMobile: boolean, panelShown: boolean): ArtifactsLayout {
	if (isMobile) return { chat: "width: 100%;", artifacts: "" };
	if (!panelShown) return { chat: "width: 100%;", artifacts: "display: none;" };
	if (maximized) return { chat: CHAT_HIDDEN, artifacts: "width: 100%;" };
	return { chat: "width: 50%;", artifacts: "width: 50%;" };
}

/** The toggle in the artifacts tab bar. Not shown in overlay mode (< 800 px): the panel is full-screen there. */
export function maximizeButton(panel: ArtifactsPanel): TemplateResult | string {
	if (panel.overlay || isArtifactsViewer() || isPanelFullscreen(panel)) return "";
	return Button({
		variant: "ghost",
		size: "sm",
		className: "sg-artifacts-maximize",
		onClick: () => setArtifactsMaximized(!maximized),
		title: maximized ? "Restore the chat (Esc)" : "Maximize: artifacts take the whole panel (Esc restores)",
		children: icon(maximized ? PanelLeftOpen : PanelLeftClose, "sm"),
	});
}

/** Maximize is on screen: flag set, panel open with artifacts, side-by-side layout (not the < 800 px overlay). */
export function artifactsMaximizeActive(panel: ArtifactsPanel): boolean {
	return maximized && !panel.collapsed && !panel.overlay && panel.artifacts.size > 0;
}

/**
 * Whether an Escape keydown (seen in the capture phase) is meant for the maximized artifacts view. It is not
 * when Tom is typing in a visible text field, or when a dialog, menu or the sessions sidebar covers the panel:
 * those keep their own Escape. (Keys pressed inside an artifact's iframe, e.g. Chrome's PDF viewer, never reach
 * the side panel document at all.)
 */
export function escapeRestoresChat(e: KeyboardEvent, panel: HTMLElement): boolean {
	const target = e.target;
	const editable =
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		(target instanceof HTMLElement && target.isContentEditable);
	if (editable && target.checkVisibility({ visibilityProperty: true })) return false;
	const box = panel.getBoundingClientRect();
	const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
	return top !== null && panel.contains(top);
}
