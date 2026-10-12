/**
 * Centralized port communication module for sidepanel <-> background messaging.
 *
 * Handles automatic reconnection when port disconnects (Chrome disconnects after ~5min inactivity).
 * Background script listeners (runtime.onConnect) stay alive forever and handle new connections.
 */

// ============================================================================
// PANEL OWNERS
// ============================================================================

/**
 * One open sitegeist panel: the side panel / sidebar of a window ("w:<windowId>") or a panel in a normal tab, e.g. a
 * split view beside a page ("t:<tabId>"). Session locks and the open-panel bookkeeping are per panel, so a panel tab
 * and the side panel of the same window never share a session (2026-10-12).
 */
export type PanelOwner = `w:${number}` | `t:${number}`;

export const sidePanelOwner = (windowId: number): PanelOwner => `w:${windowId}`;
export const tabPanelOwner = (tabId: number): PanelOwner => `t:${tabId}`;

export function parsePanelOwner(value: unknown): PanelOwner | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^([wt]):(\d+)$/.exec(value);
	if (!match) return undefined;
	const id = Number(match[2]);
	return match[1] === "w" ? sidePanelOwner(id) : tabPanelOwner(id);
}

/** The side panel's window id, for owners that are side panels. */
export function sidePanelWindow(owner: PanelOwner): number | undefined {
	return owner.startsWith("w:") ? Number(owner.slice(2)) : undefined;
}

// ============================================================================
// MESSAGE INTERFACES
// ============================================================================

/**
 * Request to acquire a session lock.
 * Sent from sidepanel to background.
 */
export interface AcquireLockMessage {
	type: "acquireLock";
	sessionId: string;
	owner: PanelOwner;
}

/**
 * Response to acquireLock request.
 * Sent from background to sidepanel.
 */
export interface LockResultMessage {
	type: "lockResult";
	sessionId: string;
	success: boolean;
	owner?: PanelOwner; // Set if lock failed (session open in another panel)
}

/**
 * Request to get all currently locked sessions.
 * Sent from sidepanel to background.
 */
export interface GetLockedSessionsMessage {
	type: "getLockedSessions";
}

/**
 * Response to getLockedSessions request.
 * Sent from background to sidepanel.
 */
export interface LockedSessionsMessage {
	type: "lockedSessions";
	locks: Record<string, PanelOwner>; // sessionId -> panel that has it open
}

// ============================================================================
// DERIVED TYPES
// ============================================================================

/**
 * Defines all request/response message pairs.
 * This is the single source of truth for all port communication.
 */
export type MessagePair =
	| { request: AcquireLockMessage; response: LockResultMessage }
	| { request: GetLockedSessionsMessage; response: LockedSessionsMessage };

/**
 * All messages that can be sent from sidepanel to background.
 */
export type SidepanelToBackgroundMessage = MessagePair["request"];

/**
 * All messages that can be sent from background to sidepanel.
 */
export type BackgroundToSidepanelMessage = MessagePair["response"];

/**
 * Maps request message type to corresponding response message type.
 */
export type ResponseForRequest<TRequest extends SidepanelToBackgroundMessage> = Extract<
	MessagePair,
	{ request: TRequest }
>["response"];

/**
 * Runtime mapping from request type to response type.
 * Used to determine which response message to wait for.
 */
export const REQUEST_TO_RESPONSE_TYPE: Record<
	SidepanelToBackgroundMessage["type"],
	BackgroundToSidepanelMessage["type"]
> = {
	acquireLock: "lockResult",
	getLockedSessions: "lockedSessions",
};

// ============================================================================
// PORT COMMUNICATION
// ============================================================================

let port: chrome.runtime.Port | null = null;
let currentOwnerId: PanelOwner | undefined;
const responseHandlers = new Map<string, (msg: BackgroundToSidepanelMessage) => void>();

/**
 * Initialize port system with this panel's owner id.
 * Must be called before sending any messages.
 */
export function initialize(owner: PanelOwner): void {
	currentOwnerId = owner;
	connect();
}

/** This panel's owner id (undefined before initialize). */
export function currentOwner(): PanelOwner | undefined {
	return currentOwnerId;
}

/**
 * Create new port connection and set up listeners.
 * Background script will receive this connection via runtime.onConnect.
 */
function connect(): chrome.runtime.Port {
	if (!currentOwnerId) {
		throw new Error("[Port] Cannot connect: panel owner not initialized");
	}

	console.log(`[Port] Connecting... (${new Date().toISOString()})`);
	const tmpPort = chrome.runtime.connect({ name: `sidepanel:${currentOwnerId}` });

	// Set up message listener to dispatch responses
	tmpPort.onMessage.addListener((msg: BackgroundToSidepanelMessage) => {
		// Dispatch to registered response handlers
		const handler = responseHandlers.get(msg.type);
		if (handler) {
			handler(msg);
		}
	});

	// Set up disconnect listener
	tmpPort.onDisconnect.addListener(() => {
		console.log(`[Port] Disconnected (likely due to inactivity timeout) (${new Date().toISOString()})`);
		port = null;
	});

	console.log(`[Port] Connected (${new Date().toISOString()})`);
	return tmpPort;
}

/**
 * Mark port as disconnected.
 * Next send attempt will create a new connection.
 */
function disconnect(): void {
	port = null;
}

/**
 * Send a message through the port and wait for a response.
 * The response type is automatically inferred from the request message type.
 *
 * @param message - Request message to send to background script
 * @param timeoutMs - Response timeout in milliseconds (default: 5000)
 * @returns Promise resolving to the corresponding response message
 */
export async function sendMessage<TRequest extends SidepanelToBackgroundMessage>(
	message: TRequest,
	timeoutMs = 5000,
): Promise<ResponseForRequest<TRequest>> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		// Ensure we have a port connection
		if (!port) {
			port = connect();
		}

		try {
			// Determine expected response type from request type
			const responseType = REQUEST_TO_RESPONSE_TYPE[message.type];
			if (!responseType) {
				throw new Error(`[Port] No response type mapping for message type: ${message.type}`);
			}

			// Set up response handler (all messages expect a response)
			const responsePromise = new Promise<BackgroundToSidepanelMessage>((resolve, reject) => {
				const timeoutId = setTimeout(() => {
					responseHandlers.delete(responseType);
					reject(new Error(`[Port] Timeout waiting for response: ${responseType}`));
				}, timeoutMs);

				responseHandlers.set(responseType, (msg: BackgroundToSidepanelMessage) => {
					clearTimeout(timeoutId);
					responseHandlers.delete(responseType);
					resolve(msg);
				});
			});

			// Try to send the message
			// This can throw if port disconnected between our check and this call
			port.postMessage(message);

			// Wait for response
			return (await responsePromise) as ResponseForRequest<TRequest>;
		} catch (err) {
			// Determine expected response type from request type for cleanup
			const responseType = REQUEST_TO_RESPONSE_TYPE[message.type];

			// Clean up response handler if we set one up
			if (responseType) {
				responseHandlers.delete(responseType);
			}

			// If this was our last attempt, give up
			if (attempt === 2) {
				throw new Error(`[Port] Failed to send message after ${attempt} attempts: ${err}`);
			}

			// Retry: disconnect and loop will reconnect
			console.warn(`[Port] Send attempt ${attempt} failed, will retry...`, err);
			disconnect();
		}
	}

	// TypeScript: This should never be reached (we throw on attempt 2 in catch block)
	throw new Error("[Port] Failed to send message: max attempts exceeded");
}

/**
 * Check if port is currently connected.
 * Note: This is best-effort - port can disconnect immediately after this check.
 */
export function isConnected(): boolean {
	return port !== null;
}
