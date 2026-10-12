/**
 * "Open sitegeist next to this page" (Tom, 2026-10-12). Opens the panel as a normal tab beside a page:
 *  - Chrome 155+: in a real split view (tabs.create with splitWithTabId), sitegeist on the right;
 *  - Zen, Firefox, older Chrome: the tab right after the page, with both tabs selected, so the browser's own split view
 *    takes one action (Zen: right-click a tab → "Join 2 Tabs"). Extensions cannot create Zen's split view.
 * A panel tab already beside the page is brought forward instead of opening a second one.
 */

const PANEL_PAGE = "sidepanel.html";
const SPLIT_VIEW_ID_NONE = -1;

/** chrome.storage.session key prefix: an unsent prompt that moves with the chat into the new tab. */
export const DRAFT_HANDOFF_PREFIX = "sg.draftHandoff.";

/** Handoff key for a saved chat (session id) or a new one (the page it opens beside). */
export const draftHandoffKey = (sessionId: string | undefined, pageTabId: number | undefined): string =>
	`${DRAFT_HANDOFF_PREFIX}${sessionId ?? `new:${pageTabId ?? ""}`}`;

export interface OpenBesideOptions {
	/** Move this saved chat into the new tab. */
	sessionId?: string;
	/** Start a new chat of this agent kind ("browser", "prime", a worker id). */
	agentKind?: string;
	/** Unsent prompt text to carry over. */
	draft?: string;
}

/** Chrome's Split View API (Chrome 155+). Firefox and Zen report split ids at most, they cannot create splits. */
export function hasSplitViewApi(): boolean {
	const api: object = chrome.tabs;
	return "createSplit" in api && typeof api.createSplit === "function";
}

const panelUrlPrefix = (): string => chrome.runtime.getURL(PANEL_PAGE);

function pageParam(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).searchParams.get("page");
	} catch {
		return null;
	}
}

async function panelTabBeside(page: chrome.tabs.Tab): Promise<chrome.tabs.Tab | undefined> {
	const tabs = await chrome.tabs.query({ windowId: page.windowId });
	const split = page.splitViewId;
	return tabs.find(
		(t) =>
			(t.url ?? "").startsWith(panelUrlPrefix()) &&
			((split !== undefined && split !== SPLIT_VIEW_ID_NONE && t.splitViewId === split) ||
				pageParam(t.url) === String(page.id)),
	);
}

/** Opens (or brings forward) the sitegeist panel tab beside `page`. */
export async function openBeside(page: chrome.tabs.Tab, opts: OpenBesideOptions = {}): Promise<chrome.tabs.Tab> {
	const pageId = page.id;
	if (pageId === undefined) throw new Error("the page has no tab id");
	if (opts.sessionId === undefined && opts.agentKind === undefined) {
		const existing = await panelTabBeside(page);
		if (existing?.id !== undefined) return (await chrome.tabs.update(existing.id, { active: true })) ?? existing;
	}
	const params = new URLSearchParams({ page: String(pageId) });
	if (opts.sessionId !== undefined) params.set("session", opts.sessionId);
	else if (opts.agentKind !== undefined) {
		params.set("new", "true");
		if (opts.agentKind !== "browser") params.set("agent", opts.agentKind);
	}
	if (opts.draft) await chrome.storage.session.set({ [draftHandoffKey(opts.sessionId, pageId)]: opts.draft });
	const url = `${panelUrlPrefix()}?${params}`;
	if (hasSplitViewApi()) {
		// splitWithTabId is not in @types/chrome yet; a typed variable (not a literal) is not an excess property.
		const split: chrome.tabs.CreateProperties & { splitWithTabId: number } = { url, splitWithTabId: pageId };
		try {
			return await chrome.tabs.create(split);
		} catch (err) {
			console.warn("[open-beside] split view failed, opening a tab next to the page", err);
		}
	}
	const tab = await chrome.tabs.create({
		url,
		windowId: page.windowId,
		index: page.index + 1,
		openerTabId: pageId,
		active: true,
	});
	// Both tabs selected: the browser's own split view joins them in one action (the first index stays in front).
	await chrome.tabs.highlight({ windowId: page.windowId, tabs: [tab.index, page.index] }).catch(() => undefined);
	return tab;
}
