/**
 * Which page sitegeist works on (Tom, 2026-10-12: "sitegeist as a page in split view next to what I'm reading").
 *
 * The panel document runs either in the browser's side panel / sidebar or as a normal tab, usually in a split view
 * beside a page. Everything that acts on "the page" asks here instead of querying the active tab: in a split view
 * the active tab is the panel itself whenever Tom is typing in it.
 *  - Side panel / sidebar, or sidepanel.html opened as a plain tab (tests, debug page): the window's active tab
 *    (as before).
 *  - Panel tab: opened next to a page ("Open sitegeist next to this page", ?page=<tab id>) or sitting in a Chrome split
 *    view. It works on the page beside it, and stays on that page while Tom looks at other tabs:
 *    1. a tab the agent itself opened or switched to (navigate tools), until Tom's next prompt;
 *    2. Chrome's split view (Tab.splitViewId, Chrome 140+): the other half;
 *    3. the panel is on screen and Tom is on a web page: that page is beside it (Zen's split view gives extensions
 *       no split ids, but the selected tab follows the half Tom clicked);
 *    4. otherwise the page Tom clicked last next to the panel (at first: the page it was opened for) while it is still
 *       on screen, else another web page visible next to the panel (document.visibilityState), else that page anyway,
 *       else the most recently used web page in the window.
 * In a split of 3-4 pages (Zen) the default is therefore the pane Tom clicked last; pagesOnScreen() lists all of them.
 */

import { isFirefoxExtension } from "./browser-compat.js";

const SPLIT_VIEW_ID_NONE = -1;
/** Visibility probes per lookup, most recently used tabs first: keeps a lookup cheap in windows with many tabs. */
const MAX_VISIBILITY_PROBES = 6;
/** Zen splits hold up to 4 panes; probing a few more recent tabs covers them without asking every tab. */
const MAX_SCREEN_PROBES = 8;
const PROBE_TIMEOUT_MS = 400;
/** After a tab switch the panel's own visibility settles before we read it. */
const ACTIVATION_SETTLE_MS = 250;

let panelTabId: number | undefined;
let panelWindowId: number | undefined;
/** The panel document is a browser tab (also a plain sidepanel.html tab), not the side panel / sidebar. */
let hostIsTab = false;
let rememberedPageId: number | undefined;
let agentTabId: number | undefined;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pages the agent can read and drive (not browser or extension pages). */
export function isWebUrl(url: string | undefined): boolean {
	return url !== undefined && /^(https?|file):/i.test(url);
}

async function getTab(id: number | undefined): Promise<chrome.tabs.Tab | undefined> {
	if (id === undefined) return undefined;
	try {
		return await chrome.tabs.get(id);
	} catch {
		return undefined; // closed
	}
}

const inSplitView = (tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab & { splitViewId: number } =>
	tab?.splitViewId !== undefined && tab.splitViewId !== SPLIT_VIEW_ID_NONE;

/** Call once when the panel starts. `seedPageId`: the page this panel tab was opened next to (?page=). */
export async function initPanelPlace(seedPageId?: number): Promise<void> {
	const [me, win] = await Promise.all([chrome.tabs.getCurrent(), chrome.windows.getCurrent()]);
	panelWindowId = me?.windowId ?? win.id;
	hostIsTab = me?.id !== undefined;
	// Side panel / sidebar: no tab. A plain tab keeps side-panel behaviour; only a panel opened next to a page (or
	// placed in a Chrome split view) works on the page beside it.
	if (me?.id === undefined || (seedPageId === undefined && !inSplitView(me))) return;
	panelTabId = me.id;
	rememberedPageId = seedPageId;
	chrome.tabs.onActivated.addListener((info) => void rememberActivated(info));
	chrome.tabs.onAttached.addListener((tabId, info) => {
		if (tabId === panelTabId) panelWindowId = info.newWindowId;
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		if (tabId === rememberedPageId) rememberedPageId = undefined;
		if (tabId === agentTabId) agentTabId = undefined;
	});
}

/** A web page Tom selects while the panel stays on screen is the page beside it. */
async function rememberActivated(info: chrome.tabs.OnActivatedInfo): Promise<void> {
	if (info.windowId !== panelWindowId || info.tabId === panelTabId) return;
	await sleep(ACTIVATION_SETTLE_MS);
	if (document.visibilityState !== "visible") return; // Tom went to another tab: the panel is off screen
	const tab = await getTab(info.tabId);
	if (tab?.active && isWebUrl(tab.url)) rememberedPageId = tab.id;
}

/** True when the panel document is any browser tab: tabs can go fullscreen, side panels and sidebars cannot. */
export const panelHostIsTab = (): boolean => hostIsTab;
/** True when this panel is a tab next to a page (see initPanelPlace), not the side panel / sidebar. */
export const isPanelTab = (): boolean => panelTabId !== undefined;
export const panelTab = (): number | undefined => panelTabId;
export const panelWindow = (): number | undefined => panelWindowId;
/** The page this panel tab sits beside (kept in the panel URL so a reload or session switch keeps it). */
export const rememberedPage = (): number | undefined => rememberedPageId;

/** The agent opened or switched to this tab: it is "the page" until Tom's next prompt. Panel tabs only. */
export function setAgentTab(tabId: number | undefined): void {
	if (panelTabId !== undefined) agentTabId = tabId;
}

/** Tom sent a new prompt: the page beside the panel is the target again. */
export function clearAgentTab(): void {
	agentTabId = undefined;
}

async function activeTabIn(windowId: number | undefined): Promise<chrome.tabs.Tab | undefined> {
	if (windowId !== undefined) {
		const [tab] = await chrome.tabs.query({ active: true, windowId });
		if (tab) return tab;
	}
	// Stale or unknown window id: the panel's own window.
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab;
}

function remember(tab: chrome.tabs.Tab): chrome.tabs.Tab {
	rememberedPageId = tab.id;
	return tab;
}

/** Whether a tab is on screen (a split view shows several), asked from inside the page. */
async function isVisible(tab: chrome.tabs.Tab): Promise<boolean> {
	if (tab.id === undefined) return false;
	const probe = chrome.scripting
		.executeScript({ target: { tabId: tab.id }, func: () => document.visibilityState })
		.then(
			(results) => results[0]?.result === "visible",
			() => false, // pages scripts cannot reach (browser pages, PDF viewers): unknown
		);
	return Promise.race([probe, sleep(PROBE_TIMEOUT_MS).then(() => false)]);
}

/** The page sitegeist works on (see the module comment). Undefined: there is no page. */
export async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
	if (panelTabId === undefined) return activeTabIn(panelWindowId);
	const chosen = await getTab(agentTabId);
	if (chosen) return chosen;
	const me = await getTab(panelTabId);
	const windowId = me?.windowId ?? panelWindowId;
	const tabs = windowId === undefined ? [] : await chrome.tabs.query({ windowId });
	if (inSplitView(me)) {
		const partner = tabs.find((t) => t.splitViewId === me.splitViewId && t.id !== panelTabId);
		if (partner) return remember(partner);
	}
	const onScreen = document.visibilityState === "visible";
	const active = tabs.find((t) => t.active);
	if (onScreen && active && active.id !== panelTabId && isWebUrl(active.url)) return remember(active);
	const remembered = tabs.find((t) => t.id === rememberedPageId);
	const recent = tabs
		.filter((t) => t.id !== panelTabId && t.id !== rememberedPageId && isWebUrl(t.url))
		.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
	if (onScreen && me?.active) {
		const candidates = [...(remembered ? [remembered] : []), ...recent.filter((t) => !t.discarded)];
		for (const tab of candidates.slice(0, MAX_VISIBILITY_PROBES)) if (await isVisible(tab)) return remember(tab);
	}
	if (remembered) return remembered;
	return recent[0] ? remember(recent[0]) : undefined;
}

const isHiddenTab = (tab: chrome.tabs.Tab): boolean => "hidden" in tab && tab.hidden === true; // Firefox: other Zen workspaces

/**
 * Web pages Tom can see now in the window sitegeist works in: the tab in front of it plus the other panes of its split
 * view (Tom, 2026-10-13: a Zen split of 3-4 pages with sitegeist as one pane). Chrome reports its split view
 * (Tab.splitViewId). Zen's split view is invisible to extensions, so there the recently used tabs are asked whether their
 * page is visible. Tab-strip order; the panel itself is not included.
 */
export async function pagesOnScreen(): Promise<chrome.tabs.Tab[]> {
	const me = await getTab(panelTabId);
	const windowId = me?.windowId ?? panelWindowId;
	if (windowId === undefined) return [];
	const tabs = await chrome.tabs.query({ windowId });
	const front = tabs.find((t) => t.active);
	const seen = new Set<number>();
	if (front?.id !== undefined) seen.add(front.id);
	if (inSplitView(front))
		for (const t of tabs) if (t.id !== undefined && t.splitViewId === front.splitViewId) seen.add(t.id);
	if (isFirefoxExtension()) {
		const candidates = tabs
			.filter(
				(t) =>
					t.id !== undefined &&
					!seen.has(t.id) &&
					t.id !== panelTabId &&
					isWebUrl(t.url) &&
					!t.discarded &&
					!isHiddenTab(t),
			)
			.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
			.slice(0, MAX_SCREEN_PROBES);
		const visible = await Promise.all(candidates.map((t) => isVisible(t)));
		candidates.forEach((t, i) => {
			if (visible[i] && t.id !== undefined) seen.add(t.id);
		});
	}
	return tabs.filter((t) => t.id !== undefined && t.id !== panelTabId && seen.has(t.id) && isWebUrl(t.url));
}

/** True when `tab` is on screen next to this panel tab (split view): tools then work on it where it is. */
export async function isBesidePanel(tab: chrome.tabs.Tab): Promise<boolean> {
	if (panelTabId === undefined || tab.id === undefined || tab.id === panelTabId) return false;
	if (document.visibilityState !== "visible") return false;
	const me = await getTab(panelTabId);
	if (inSplitView(me)) return tab.splitViewId === me.splitViewId;
	if (me === undefined || tab.windowId !== me.windowId) return false;
	return tab.active || (await isVisible(tab));
}

type CaptureTab = (tabId: number, options: { format: "png" }) => Promise<string>;
const isCaptureTab = (v: unknown): v is CaptureTab => typeof v === "function";

/** Firefox / Zen capture any tab, also one that is not in front (tabs.captureTab; Chrome has no such call). */
function firefoxCaptureTab(): CaptureTab | undefined {
	const api: object = chrome.tabs;
	if (!("captureTab" in api) || !isCaptureTab(api.captureTab)) return undefined;
	const capture = api.captureTab;
	return (tabId, options) => capture.call(chrome.tabs, tabId, options);
}

/**
 * PNG data URL of what `tab` shows. Firefox / Zen capture any tab where it is. Chrome captures only the tab in front
 * of its window, so the tab comes forward for the capture; from a panel tab the previous front tab (the panel, or the
 * page Tom was on) comes back right after, so a split view stays as Tom left it and his typing stays in the chat.
 */
export async function captureTabPng(tab: chrome.tabs.Tab): Promise<string> {
	const id = tab.id;
	if (id === undefined) throw new Error("tab has no id");
	const captureTab = firefoxCaptureTab();
	if (captureTab) return captureTab(id, { format: "png" });
	const current = (await getTab(id)) ?? tab;
	if (current.active) return chrome.tabs.captureVisibleTab(current.windowId, { format: "png" });
	const [front] = await chrome.tabs.query({ active: true, windowId: current.windowId });
	const beside = await isBesidePanel(current);
	await chrome.tabs.update(id, { active: true });
	try {
		await sleep(beside ? 150 : 350); // a tab that was off screen needs a frame first
		return await chrome.tabs.captureVisibleTab(current.windowId, { format: "png" });
	} finally {
		if (panelTabId !== undefined && front?.id !== undefined && front.id !== id)
			await chrome.tabs.update(front.id, { active: true }).catch(() => undefined);
	}
}
