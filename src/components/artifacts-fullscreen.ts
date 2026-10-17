/**
 * Fullscreen for the artifacts (Tom, 2026-10-17: "Can you add ability to fullscreen previews in the artifacts UI ...
 * This could be a little icon next to the download icon in top right"). One button, right of the artifact's own
 * buttons (download):
 *  - sitegeist in a tab (split view, or sidepanel.html opened as a tab): the artifacts panel element itself goes
 *    fullscreen (Fullscreen API). Esc or the button leaves.
 *  - side panel / sidebar: browsers do not let a side panel go fullscreen (Chrome 155: requestFullscreen() there never
 *    settles; Firefox only lets the selected tab go fullscreen). The artifacts open in a new browser window created in
 *    fullscreen state, showing sidepanel.html in viewer mode (src/components/artifacts-viewer.ts). Esc or the button
 *    closes it. A tab whose fullscreen request fails falls back to the same window.
 * The viewer window asks the panel for the artifacts over runtime messaging (storage.session would cap them at 10 MB).
 * Wired into pi-web-ui's compiled ArtifactsPanel by exact-string patches in scripts/build.mjs.
 */
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import type { ArtifactsPanel } from "@mariozechner/pi-web-ui";
import type { ReactiveController, ReactiveControllerHost, TemplateResult } from "lit";
import { Maximize, Minimize } from "lucide";
import { panelHostIsTab } from "../utils/target-tab.js";

/** sidepanel.html?view=artifacts&token=<id> shows only the artifacts, for the fullscreen window. */
export const ARTIFACTS_VIEW_PARAM = "artifacts";
const VIEW_REQUEST = "sg-artifacts-view";
/** A viewer window that never asks (closed at once, failed to load) does not keep the artifacts in memory forever. */
const HANDOFF_TTL_MS = 120_000;
/** A tab's fullscreen request settles quickly (including the macOS animation); a hung one falls back to the window. */
const ELEMENT_FULLSCREEN_TIMEOUT_MS = 5_000;

export interface ViewedArtifact {
	filename: string;
	content: string;
}

export interface ArtifactsViewPayload {
	artifacts: ViewedArtifact[];
	active: string | undefined;
}

let viewerMode = false;
const hosts = new Set<ReactiveControllerHost>();
const handoffs = new Map<string, ArtifactsViewPayload>();
let handoffListener = false;

/** This document is the fullscreen viewer window: the button and the close X close the window. */
export function setArtifactsViewerMode(): void {
	viewerMode = true;
	for (const host of hosts) host.requestUpdate();
}

export const isArtifactsViewer = (): boolean => viewerMode;

class FullscreenController implements ReactiveController {
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

document.addEventListener("fullscreenchange", () => {
	for (const host of hosts) host.requestUpdate();
});

/** Re-render this element (the button icon) when the page enters or leaves fullscreen. */
export function watchArtifactsFullscreen(host: ReactiveControllerHost): void {
	host.addController(new FullscreenController(host));
}

/** The artifacts panel is the page's fullscreen element right now (tab route). */
export const isPanelFullscreen = (panel: Element): boolean => document.fullscreenElement === panel;

/** The button, right of the active artifact's own buttons (download). */
export function fullscreenButton(panel: ArtifactsPanel, activeFilename: string | null | undefined): TemplateResult {
	const leave = viewerMode || isPanelFullscreen(panel);
	return Button({
		variant: "ghost",
		size: "sm",
		className: "sg-artifacts-fullscreen",
		onClick: () => {
			if (viewerMode) void closeViewerWindow();
			else if (isPanelFullscreen(panel)) void document.exitFullscreen();
			else enterFullscreen(panel, activeFilename ?? undefined);
		},
		title: leave ? "Exit fullscreen (Esc)" : "Fullscreen (Esc to leave)",
		children: icon(leave ? Minimize : Maximize, "sm"),
	});
}

/**
 * Called straight from the click (the Fullscreen API needs the click's user activation, so nothing is awaited first).
 * Tab: the panel element goes fullscreen; side panel / sidebar, or a refused request: the fullscreen window.
 */
function enterFullscreen(panel: ArtifactsPanel, active: string | undefined): void {
	if (!panelHostIsTab() || !document.fullscreenEnabled) {
		void openViewerWindow(panel, active);
		return;
	}
	let settled = false;
	const fallback = (why: unknown): void => {
		if (settled) return;
		settled = true;
		console.warn("[artifacts] fullscreen refused, opening a fullscreen window instead:", why);
		void openViewerWindow(panel, active);
	};
	const timer = setTimeout(() => {
		fallback("no answer from requestFullscreen");
		// A request that still succeeds later is undone: the window has the artifacts by then.
		document.addEventListener(
			"fullscreenchange",
			() => {
				if (document.fullscreenElement) void document.exitFullscreen();
			},
			{ once: true },
		);
	}, ELEMENT_FULLSCREEN_TIMEOUT_MS);
	panel.requestFullscreen().then(
		() => {
			clearTimeout(timer);
			settled = true;
		},
		(err: unknown) => {
			clearTimeout(timer);
			fallback(err);
		},
	);
}

/** The viewer window's question: { type: "sg-artifacts-view", token }. Validated: messages are an interface boundary. */
function viewRequestToken(msg: unknown): string | undefined {
	if (typeof msg !== "object" || msg === null) return undefined;
	if (!("type" in msg) || msg.type !== VIEW_REQUEST) return undefined;
	return "token" in msg && typeof msg.token === "string" ? msg.token : undefined;
}

function listenForViewers(): void {
	if (handoffListener) return;
	handoffListener = true;
	chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
		const token = viewRequestToken(msg);
		const payload = token === undefined ? undefined : handoffs.get(token);
		if (token === undefined || payload === undefined) return false; // not ours: another panel may answer
		handoffs.delete(token);
		sendResponse(payload);
		return false;
	});
}

/** Opens the artifacts (all of them, starting on the active one) in a new window in fullscreen state. */
async function openViewerWindow(panel: ArtifactsPanel, active: string | undefined): Promise<void> {
	const artifacts = Array.from(panel.artifacts.values(), (a) => ({ filename: a.filename, content: a.content }));
	if (artifacts.length === 0) return;
	listenForViewers();
	const token = crypto.randomUUID();
	handoffs.set(token, { artifacts, active });
	setTimeout(() => handoffs.delete(token), HANDOFF_TTL_MS);
	const url = chrome.runtime.getURL(`sidepanel.html?view=${ARTIFACTS_VIEW_PARAM}&token=${token}`);
	try {
		await chrome.windows.create({ url, type: "popup", state: "fullscreen" });
	} catch (err) {
		// A platform that refuses a fullscreen window still gets the artifacts in a window as large as the screen.
		console.warn("[artifacts] fullscreen window refused, opening a maximized one:", err);
		await chrome.windows.create({ url, type: "popup", state: "maximized" });
	}
}

/** Viewer window: the artifacts the panel handed over (undefined: the panel is gone or the link is stale). */
export async function requestViewedArtifacts(token: string): Promise<ArtifactsViewPayload | undefined> {
	let answer: unknown;
	try {
		answer = await chrome.runtime.sendMessage({ type: VIEW_REQUEST, token });
	} catch {
		return undefined; // nobody answered: the panel closed or loaded another chat
	}
	return parsePayload(answer);
}

function parsePayload(value: unknown): ArtifactsViewPayload | undefined {
	if (typeof value !== "object" || value === null || !("artifacts" in value) || !Array.isArray(value.artifacts))
		return undefined;
	const artifacts: ViewedArtifact[] = [];
	for (const item of value.artifacts) {
		if (typeof item !== "object" || item === null) continue;
		const filename = "filename" in item && typeof item.filename === "string" ? item.filename : undefined;
		const content = "content" in item && typeof item.content === "string" ? item.content : undefined;
		if (filename !== undefined && content !== undefined) artifacts.push({ filename, content });
	}
	const active = "active" in value && typeof value.active === "string" ? value.active : undefined;
	return { artifacts, active };
}

/** Closes the viewer window (the whole window: it only ever shows the artifacts). */
export async function closeViewerWindow(): Promise<void> {
	try {
		const win = await chrome.windows.getCurrent();
		if (win.id !== undefined) {
			await chrome.windows.remove(win.id);
			return;
		}
	} catch {
		/* fall through */
	}
	window.close();
}
