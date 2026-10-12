import { ANCHORS_STORAGE_KEY, AnchorsStore, chromeLocalBackend, pageKey } from "./anchors/anchors.js";
import { hasSidePanelApi, sidebarActionApi } from "./utils/browser-compat.js";
import { openBeside } from "./utils/open-beside.js";
import {
	type LockedSessionsMessage,
	type LockResultMessage,
	type PanelOwner,
	parsePanelOwner,
	type SidepanelToBackgroundMessage,
	sidePanelOwner,
	sidePanelWindow,
	tabPanelOwner,
} from "./utils/port.js";

// Called when Sitegeist icon is clicked - opens the (window-global) side panel.
// Open by windowId, not tabId: the panel has no tab-specific options, and Edge treats a tabId-opened
// panel as bound to that tab - switching tabs closes/re-creates it, losing all in-panel state (open
// artifact, scroll position). Chrome behaves the same either way. Same call the keyboard toggle uses.
// Firefox / Zen have no side panel API: the panel is the extension sidebar (manifest sidebar_action), and
// sidebarAction.open/toggle only work synchronously inside this click handler (user gesture), so no await first.
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	const windowId = tab?.windowId;
	if (hasSidePanelApi()) {
		if (windowId !== undefined) chrome.sidePanel.open({ windowId });
		return;
	}
	const sidebar = sidebarActionApi();
	if (sidebar) void (sidebar.toggle ? sidebar.toggle() : sidebar.open());
});

// ============================================================================
// PAGE ANCHORS BADGE (Tom, 2026-09-29): a tab whose page has a session bound to it shows a badge on
// the toolbar icon (count of sessions) and a "Resume …" tooltip, so after a browser restart / crash
// the session is one click away even though a closed side panel cannot open itself (sidePanel.open
// needs a user gesture). Clicking the icon opens the panel, whose initApp loads the page's session.
// ============================================================================
const anchors = new AnchorsStore(chromeLocalBackend());
const DEFAULT_ACTION_TITLE = "Click to open side panel";
void chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
void chrome.action.setBadgeTextColor?.({ color: "#ffffff" });

async function updateAnchorBadge(tabId: number, url: string | undefined): Promise<void> {
	const key = url ? pageKey(url) : undefined;
	const bound = key ? await anchors.forKey(key) : [];
	const first = bound[0];
	try {
		await chrome.action.setBadgeText({ tabId, text: first ? String(bound.length) : "" });
		await chrome.action.setTitle({
			tabId,
			title: first
				? `Resume in sitegeist: ${first.pageTitle || first.key}${bound.length > 1 ? ` (+${bound.length - 1} more)` : ""}`
				: DEFAULT_ACTION_TITLE,
		});
	} catch {
		/* tab closed mid-update */
	}
}

async function refreshAllAnchorBadges(): Promise<void> {
	const tabs = await chrome.tabs.query({ active: true });
	await Promise.all(tabs.map((t) => (t.id !== undefined ? updateAnchorBadge(t.id, t.url) : Promise.resolve())));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.url || changeInfo.status === "loading") void updateAnchorBadge(tabId, changeInfo.url ?? tab.url);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
	chrome.tabs.get(tabId, (tab) => {
		if (!chrome.runtime.lastError) void updateAnchorBadge(tabId, tab.url);
	});
});
chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && changes[ANCHORS_STORAGE_KEY]) void refreshAllAnchorBadges();
});
void refreshAllAnchorBadges();

// Context menus, (re)created on install/update and on browser start (Firefox does not keep them across restarts):
//  - right-click on selected text inside the panel → "Copy as Markdown" (handled in sidepanel.ts, which owns the
//    selection);
//  - right-click on the toolbar icon → "Open sitegeist next to this page" (split view beside the page, 2026-10-12).
const OPEN_BESIDE_MENU_ID = "sg-open-beside";
function createMenus(): void {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: "sg-copy-markdown",
			title: "Copy as Markdown",
			contexts: ["selection"],
			documentUrlPatterns: [chrome.runtime.getURL("sidepanel.html*")],
		});
		chrome.contextMenus.create({
			id: OPEN_BESIDE_MENU_ID,
			title: "Open sitegeist next to this page",
			contexts: ["action"],
		});
	});
}
chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

// ============================================================================
// SITEGEIST NEXT TO THE PAGE (Tom, 2026-10-12): the panel as a normal tab in a split view beside the page.
// Entry points: the toolbar icon's menu, the "open-beside" shortcut, and the panel's own "move" button.
// ============================================================================
async function openBesideTab(tab: chrome.tabs.Tab | undefined): Promise<void> {
	const page = tab?.id !== undefined ? tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
	if (!page || (page.url ?? "").startsWith(chrome.runtime.getURL(""))) return; // not beside sitegeist itself
	try {
		await openBeside(page);
	} catch (err) {
		console.error("[Background] open beside failed:", err);
	}
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === OPEN_BESIDE_MENU_ID) void openBesideTab(tab);
});

/** A panel asks to move its chat into a tab beside the page (validated: messages are an interface boundary). */
interface OpenBesideRequest {
	pageTabId: number;
	sessionId?: string;
	agentKind?: string;
	draft?: string;
	from?: PanelOwner;
}

function parseOpenBesideRequest(msg: unknown): OpenBesideRequest | undefined {
	if (typeof msg !== "object" || msg === null) return undefined;
	if (!("type" in msg) || msg.type !== "sg-open-beside") return undefined;
	if (!("pageTabId" in msg) || typeof msg.pageTabId !== "number") return undefined;
	const request: OpenBesideRequest = { pageTabId: msg.pageTabId };
	if ("sessionId" in msg && typeof msg.sessionId === "string" && /^[\w.:-]{1,200}$/.test(msg.sessionId))
		request.sessionId = msg.sessionId;
	if ("agentKind" in msg && typeof msg.agentKind === "string" && /^[a-z0-9]{1,40}$/.test(msg.agentKind))
		request.agentKind = msg.agentKind;
	if ("draft" in msg && typeof msg.draft === "string") request.draft = msg.draft.slice(0, 200_000);
	if ("from" in msg) request.from = parsePanelOwner(msg.from);
	return request;
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
	const request = parseOpenBesideRequest(msg);
	if (!request) return false;
	void (async () => {
		try {
			const page = await chrome.tabs.get(request.pageTabId);
			// The moving panel lets go of the chat first, so the new tab can open it.
			if (request.sessionId !== undefined && request.from !== undefined)
				await releaseLock(request.sessionId, request.from);
			// No session and no agent kind: like the toolbar menu (an existing panel tab beside the page comes forward).
			const tab = await openBeside(page, {
				sessionId: request.sessionId,
				agentKind: request.sessionId === undefined ? request.agentKind : undefined,
				draft: request.draft,
			});
			sendResponse({ ok: true, tabId: tab.id });
		} catch (err) {
			sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	})();
	return true; // async response
});

// Listen for messages from userScripts (overlay in page). Firefox / Zen: userScripts is an optional permission the
// user grants from the panel after this script started, and the namespace only appears then: register on grant too.
let userScriptRelayRegistered = false;
chrome.permissions.onAdded.addListener(() => registerUserScriptRelay());
registerUserScriptRelay();
function registerUserScriptRelay(): void {
	if (userScriptRelayRegistered) return;
	console.log("[Background] onUserScriptMessage available:", !!chrome.runtime.onUserScriptMessage);
	if (!chrome.runtime.onUserScriptMessage) return;
	userScriptRelayRegistered = true;
	chrome.runtime.onUserScriptMessage.addListener((message, sender, sendResponse) => {
		console.log("[Background] Received userScript message:", message, "from:", sender);
		if (message.type === "abort-repl") {
			// Forward to all open sidepanels (they'll check if they're streaming)
			console.log("[Background] Relaying abort-repl to sidepanels");
			chrome.runtime.sendMessage(message);
			sendResponse({ success: true });
			return true;
		}
	});
	console.log("[Background] onUserScriptMessage listener registered");
}

// Storage keys for tracking state (persists across service worker sleep)
const SIDEPANEL_OPEN_KEY = "sidepanel_open_windows"; // open panels (PanelOwner[]): side panels and panel tabs
const SESSION_LOCKS_KEY = "session_locks"; // sessionId -> PanelOwner that has it open

// chrome.storage.session values are validated on read (they outlive this code across updates of the extension).
function readOwners(value: unknown): PanelOwner[] {
	if (!Array.isArray(value)) return [];
	return value.map(parsePanelOwner).filter((o): o is PanelOwner => o !== undefined);
}

function readLocks(value: unknown): Record<string, PanelOwner> {
	const locks: Record<string, PanelOwner> = {};
	if (typeof value !== "object" || value === null) return locks;
	for (const [sessionId, owner] of Object.entries(value)) {
		const parsed = parsePanelOwner(owner);
		if (parsed) locks[sessionId] = parsed;
	}
	return locks;
}

async function releaseLock(sessionId: string, owner: PanelOwner): Promise<void> {
	const data = await chrome.storage.session.get(SESSION_LOCKS_KEY);
	const locks = readLocks(data[SESSION_LOCKS_KEY]);
	if (locks[sessionId] !== owner) return;
	delete locks[sessionId];
	await chrome.storage.session.set({ [SESSION_LOCKS_KEY]: locks });
}

// Synchronously readable cache of which panels are open
// Gets populated on startup and updated by port events
let openSidepanels = new Set<PanelOwner>();

// Initialize cache from storage on startup
chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
	openSidepanels = new Set(readOwners(data[SIDEPANEL_OPEN_KEY]));
	console.log("[Background] Initialized openSidepanels cache:", Array.from(openSidepanels));
});

// Handle port connections from panels (side panel / sidebar, or a panel tab)
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	// Port name format: "sidepanel:<owner>", owner "w:<windowId>" or "t:<tabId>"
	const owner = port.name.startsWith("sidepanel:") ? parsePanelOwner(port.name.slice("sidepanel:".length)) : undefined;
	if (!owner) return;

	// Update cache synchronously
	openSidepanels.add(owner);

	// Mark the panel as open in persistent storage (survives service worker sleep)
	chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
		const open = new Set(readOwners(data[SIDEPANEL_OPEN_KEY]));
		open.add(owner);
		chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(open) });
	});

	port.onMessage.addListener((msg: SidepanelToBackgroundMessage) => {
		if (msg.type === "acquireLock") {
			const { sessionId, owner: requester } = msg;

			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const sessionLocks = readLocks(data[SESSION_LOCKS_KEY]);
				const current = sessionLocks[sessionId];
				const currentOpen = current !== undefined && openSidepanels.has(current);

				// Grant lock if: no owner, owner panel closed, or the requesting panel is the owner
				const success = !current || !currentOpen || current === requester;

				const response: LockResultMessage = success
					? {
							type: "lockResult",
							sessionId,
							success: true,
						}
					: {
							type: "lockResult",
							sessionId,
							success: false,
							owner: current,
						};

				if (success) {
					// Update locks in storage
					sessionLocks[sessionId] = requester;
					chrome.storage.session.set({ [SESSION_LOCKS_KEY]: sessionLocks });
				}

				port.postMessage(response);
			});
		} else if (msg.type === "getLockedSessions") {
			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const response: LockedSessionsMessage = {
					type: "lockedSessions",
					locks: readLocks(data[SESSION_LOCKS_KEY]),
				};
				port.postMessage(response);
			});
		}
	});

	port.onDisconnect.addListener(() => {
		closeSidepanel(owner, false);
	});
});

// Clean up locks when a window or a panel tab closes (belt-and-suspenders; the port disconnect does it too)
chrome.windows.onRemoved.addListener((windowId: number) => {
	closeSidepanel(sidePanelOwner(windowId), false);
});
chrome.tabs.onRemoved.addListener((tabId: number) => {
	const owner = tabPanelOwner(tabId);
	if (openSidepanels.has(owner)) closeSidepanel(owner, false);
});

// Keyboard shortcuts: toggle the side panel, or open sitegeist next to the page
chrome.commands.onCommand.addListener((command: string, sender?: chrome.tabs.Tab) => {
	if (command === "open-beside") {
		void openBesideTab(sender);
		return;
	}
	// Firefox / Zen toggle the sidebar natively (manifest command _execute_sidebar_action), so this is Chrome only.
	if (command === "toggle-sidepanel" && hasSidePanelApi()) {
		if (!sender?.windowId) {
			console.log("[Background] Cannot toggle sidepanel: sender windowId not available");
			return;
		}

		const windowId = sender.windowId;

		// Check synchronous cache (populated from storage on startup and updated by port events)
		if (openSidepanels.has(sidePanelOwner(windowId))) {
			// Sidepanel is open - close it using Chrome 141+ API
			closeSidepanel(sidePanelOwner(windowId));
		} else {
			// Sidepanel is closed - open it
			chrome.sidePanel.open({ windowId });
		}
	}
});

function closeSidepanel(owner: PanelOwner, callCloseOnSidePanelAPI: boolean = true) {
	const windowId = sidePanelWindow(owner);
	if (callCloseOnSidePanelAPI && windowId !== undefined && hasSidePanelApi()) {
		void chrome.sidePanel.close({ windowId });
	}

	// Update cache synchronously
	openSidepanels.delete(owner);

	// Clean up storage state (same logic as onDisconnect)
	chrome.storage.session.get([SESSION_LOCKS_KEY, SIDEPANEL_OPEN_KEY], (data) => {
		// Release the session locks of this panel
		const sessionLocks = readLocks(data[SESSION_LOCKS_KEY]);
		for (const sessionId in sessionLocks) {
			if (sessionLocks[sessionId] === owner) {
				delete sessionLocks[sessionId];
			}
		}

		// Mark the panel as closed
		const open = new Set(readOwners(data[SIDEPANEL_OPEN_KEY]));
		open.delete(owner);

		// Save both updates atomically
		chrome.storage.session.set({
			[SESSION_LOCKS_KEY]: sessionLocks,
			[SIDEPANEL_OPEN_KEY]: Array.from(open),
		});
	});
}
