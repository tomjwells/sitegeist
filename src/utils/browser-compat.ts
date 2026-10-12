/**
 * Browser differences in one place (Firefox / Zen build, 2026-10-12). sitegeist is built from one source for Chrome
 * (side panel, debugger API) and Firefox / Zen (extension sidebar, no debugger API). Code checks here instead of
 * sniffing the user agent.
 */

/** Firefox's sidebarAction namespace (not in @types/chrome). */
export interface SidebarActionApi {
	open: () => Promise<void>;
	close: () => Promise<void>;
	toggle?: () => Promise<void>;
}

function isSidebarActionApi(v: unknown): v is SidebarActionApi {
	return (
		typeof v === "object" &&
		v !== null &&
		"open" in v &&
		typeof v.open === "function" &&
		"close" in v &&
		typeof v.close === "function" &&
		(!("toggle" in v) || typeof v.toggle === "function")
	);
}

/** The extension sidebar API (Firefox / Zen), or undefined in Chrome. */
export function sidebarActionApi(): SidebarActionApi | undefined {
	const ns: object = chrome;
	return "sidebarAction" in ns && isSidebarActionApi(ns.sidebarAction) ? ns.sidebarAction : undefined;
}

/** Chrome's side panel API (absent in Firefox / Zen). */
export function hasSidePanelApi(): boolean {
	const ns: object = chrome;
	return "sidePanel" in ns && typeof chrome.sidePanel?.open === "function";
}

/** Chrome's debugger API (real mouse/keyboard input, CDP). Absent in Firefox / Zen. */
export function hasDebuggerApi(): boolean {
	const ns: object = chrome;
	return "debugger" in ns && typeof chrome.debugger?.attach === "function";
}

/** True in the Firefox / Zen build. */
export function isFirefoxExtension(): boolean {
	return chrome.runtime.getURL("").startsWith("moz-extension://");
}
