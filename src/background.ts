import { ANCHORS_STORAGE_KEY, AnchorsStore, chromeLocalBackend, pageKey } from "./anchors/anchors.js";
import type { LockedSessionsMessage, LockResultMessage, SidepanelToBackgroundMessage } from "./utils/port.js";

// Called when Sitegeist icon is clicked - opens the (window-global) side panel.
// Open by windowId, not tabId: the panel has no tab-specific options, and Edge treats a tabId-opened
// panel as bound to that tab - switching tabs closes/re-creates it, losing all in-panel state (open
// artifact, scroll position). Chrome behaves the same either way. Same call the keyboard toggle uses.
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	const windowId = tab?.windowId;
	if (windowId !== undefined && chrome.sidePanel.open) {
		chrome.sidePanel.open({ windowId });
	}
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

// Right-click on selected text inside the side panel → "Copy as Markdown" (handled in sidepanel.ts, which
// owns the selection). Menu items persist in the browser, so (re)create them once per install/update.
chrome.runtime.onInstalled.addListener(() => {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: "sg-copy-markdown",
			title: "Copy as Markdown",
			contexts: ["selection"],
			documentUrlPatterns: [chrome.runtime.getURL("sidepanel.html*")],
		});
	});
});

// Listen for messages from userScripts (overlay in page)
console.log("[Background] onUserScriptMessage available:", !!chrome.runtime.onUserScriptMessage);
if (chrome.runtime.onUserScriptMessage) {
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
} else {
	console.error("[Background] onUserScriptMessage NOT available!");
}

// Storage keys for tracking state (persists across service worker sleep)
const SIDEPANEL_OPEN_KEY = "sidepanel_open_windows";
const SESSION_LOCKS_KEY = "session_locks"; // sessionId -> windowId mapping

// Synchronously readable cache of which sidepanels are open
// Gets populated on startup and updated by port events
let openSidepanels = new Set<number>();

// Initialize cache from storage on startup
chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
	openSidepanels = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
	console.log("[Background] Initialized openSidepanels cache:", Array.from(openSidepanels));
});

// Handle port connections from sidepanels
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	// Port name format: "sidepanel:${windowId}"
	const match = /^sidepanel:(\d+)$/.exec(port.name);
	if (!match) return;

	const windowId = Number(match[1]);

	// Update cache synchronously
	openSidepanels.add(windowId);

	// Mark sidepanel as open in persistent storage (survives service worker sleep)
	chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
		const openWindows = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		openWindows.add(windowId);
		chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(openWindows) });
	});

	port.onMessage.addListener((msg: SidepanelToBackgroundMessage) => {
		if (msg.type === "acquireLock") {
			const { sessionId, windowId: reqWindowId } = msg;

			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const sessionLocks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
				const ownerWindowId = sessionLocks[sessionId];
				const ownerSidepanelOpen = ownerWindowId !== undefined && openSidepanels.has(ownerWindowId);

				// Grant lock if: no owner, owner sidepanel closed, or requesting window is owner
				const success = !ownerWindowId || !ownerSidepanelOpen || ownerWindowId === reqWindowId;

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
							ownerWindowId,
						};

				if (success) {
					// Update locks in storage
					sessionLocks[sessionId] = reqWindowId;
					chrome.storage.session.set({ [SESSION_LOCKS_KEY]: sessionLocks });
				}

				port.postMessage(response);
			});
		} else if (msg.type === "getLockedSessions") {
			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const locks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
				const response: LockedSessionsMessage = {
					type: "lockedSessions",
					locks,
				};
				port.postMessage(response);
			});
		}
	});

	port.onDisconnect.addListener(() => {
		closeSidepanel(windowId, false);
	});
});

// Clean up locks when entire window closes (belt-and-suspenders)
chrome.windows.onRemoved.addListener((windowId: number) => {
	closeSidepanel(windowId, false);
});

// Handle keyboard shortcut - toggle sidepanel open/close
chrome.commands.onCommand.addListener((command: string, sender?: chrome.tabs.Tab) => {
	if (command === "toggle-sidepanel") {
		if (!sender?.windowId) {
			console.log("[Background] Cannot toggle sidepanel: sender windowId not available");
			return;
		}

		const windowId = sender.windowId;

		// Check synchronous cache (populated from storage on startup and updated by port events)
		if (openSidepanels.has(windowId)) {
			// Sidepanel is open - close it using Chrome 141+ API
			closeSidepanel(windowId);
		} else {
			// Sidepanel is closed - open it
			chrome.sidePanel.open({ windowId });
		}
	}
});

function closeSidepanel(windowId: number, callCloseOnSidePanelAPI: boolean = true) {
	if (callCloseOnSidePanelAPI) {
		(chrome.sidePanel as any).close({ windowId });
	}

	// Update cache synchronously
	openSidepanels.delete(windowId);

	// Clean up storage state (same logic as onDisconnect)
	chrome.storage.session.get([SESSION_LOCKS_KEY, SIDEPANEL_OPEN_KEY], (data) => {
		// Release session locks for this window
		const sessionLocks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
		for (const sessionId in sessionLocks) {
			if (sessionLocks[sessionId] === windowId) {
				delete sessionLocks[sessionId];
			}
		}

		// Mark sidepanel as closed
		const openWindows = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		openWindows.delete(windowId);

		// Save both updates atomically
		chrome.storage.session.set({
			[SESSION_LOCKS_KEY]: sessionLocks,
			[SIDEPANEL_OPEN_KEY]: Array.from(openWindows),
		});
	});
}
