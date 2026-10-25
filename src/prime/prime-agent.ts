/**
 * A pi-agent-core `Agent` whose brain lives on the R730: prompts go to a prime-agent (main-pi body)
 * bridge session through the relay, the bridge's event log is streamed back and replayed into the
 * same state machine the local agent uses, so pi-web-ui renders it unchanged. Browser tool calls
 * from prime arrive over the same socket and are executed here with the extension's powers.
 */
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import type { Attachment, UserMessageWithAttachments } from "@mariozechner/pi-web-ui";
import { catalogProviders, getModels as registryModels } from "../models-registry.js";
import { fitImageForModel, type ImageFit } from "../utils/model-image.js";
import { buildAttachmentsSection, compactAttachmentsText, hasAttachmentsBlock } from "./attachments-text.js";
import { bridgeNoticeToast, isBridgeNotice } from "./bridge-notice.js";
import { cancelBrowserCall, handleBrowserCall } from "./browser-tools.js";
import { MAIN_AGENT_ID, PRIME_PROVIDER } from "./constants.js";
import {
	isJson,
	type Json,
	type PrimeAttachment,
	PrimeSocket,
	primeCreateSession,
	primeHydrate,
	primePrompt,
	primeRpc,
	primeUploadFile,
} from "./prime-client.js";
import { describeSendError, isUnsent, type SendState, sendStateOf, withSendState } from "./send-state.js";

export {
	agentIdFromSessionId,
	isPrimeSessionId,
	MAIN_AGENT_ID,
	PRIME_PROVIDER,
	PRIME_SESSION_PREFIX,
} from "./constants.js";

export type PrimeStatus = "idle" | "creating" | "connecting" | "open" | "closed" | "error";

const LLM_ROLES = new Set(["user", "assistant", "toolResult"]);
/** Kept alongside the bridge history: artifact messages let pi-web-ui rebuild the artifacts panel on reload. */
const isArtifactMessage = (m: AgentMessage): boolean => m.role === "artifact";
const AGENT_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

function isModel(v: unknown): v is Model<any> {
	return isJson(v) && typeof v.id === "string" && typeof v.provider === "string" && isJson(v.cost);
}

/** Header/selector view of the remote model: real id, provider replaced so no browser key is required. */
export function primeModelView(model: Model<any>): Model<any> {
	return { ...model, provider: PRIME_PROVIDER, name: model.name || model.id } as Model<any>;
}

const isAgentMessage = (v: unknown): v is AgentMessage => isJson(v) && typeof v.role === "string";
const toAgentMessages = (list: unknown[]): AgentMessage[] =>
	stripBrowserContext(list.filter(isAgentMessage).filter((m) => LLM_ROLES.has(m.role)));

// The side panel prepends "[sitegeist browser context] … [/sitegeist browser context]" to what Tom typed so
// prime knows the tab/tools; that is for the model, not for the transcript or the session title.
const CONTEXT_RE = /^\[sitegeist browser context\][\s\S]*?(?:\[\/sitegeist browser context\]|\n\n)\s*/;
// Files attached in the panel are shipped to the agent's host and listed for the model as
// "[sitegeist attachments] … [/sitegeist attachments]" (paths + handling notes, attachments-text.ts). The
// transcript shows the attachment tiles instead (or a one-line "Attached: …" once the tiles are gone, e.g.
// after a reload).
const attachmentsOf = (m: AgentMessage): Attachment[] | undefined => {
	const list = (m as { attachments?: unknown }).attachments;
	return Array.isArray(list) && list.length > 0 ? (list as Attachment[]) : undefined;
};
function displayText(text: string, hasTiles: boolean): string {
	return compactAttachmentsText(text.replace(CONTEXT_RE, ""), hasTiles).trim();
}
const needsDisplayFix = (text: string): boolean => CONTEXT_RE.test(text) || hasAttachmentsBlock(text);
/** Returns the messages with the browser-context preamble and attachments block removed from user text (no-op for other roles). */
export function stripBrowserContext(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((m) => {
		if (m.role !== "user") return m;
		const hasTiles = attachmentsOf(m) !== undefined;
		const content = m.content;
		if (typeof content === "string")
			return needsDisplayFix(content) ? { ...m, content: displayText(content, hasTiles) } : m;
		let changed = false;
		const next = content.map((c) => {
			if (c.type !== "text" || !needsDisplayFix(c.text)) return c;
			changed = true;
			return { ...c, text: displayText(c.text, hasTiles) };
		});
		return changed ? { ...m, content: next } : m;
	});
}

function sameMessage(a: AgentMessage, b: AgentMessage): boolean {
	if (a.role !== b.role) return false;
	const ta = (a as { timestamp?: unknown }).timestamp;
	const tb = (b as { timestamp?: unknown }).timestamp;
	if (ta !== undefined && tb !== undefined && ta !== tb) return false;
	const ca = (a as { content?: unknown }).content;
	const cb = (b as { content?: unknown }).content;
	return JSON.stringify(ca) === JSON.stringify(cb);
}

/** The typed text of a user message (string content, or its text blocks joined). */
function userText(m: AgentMessage): string {
	const content: unknown = (m as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c: unknown) => (isJson(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
		.filter((t) => t.length > 0)
		.join("\n\n");
}

/**
 * What a send needs to go out (again): the parts Tom typed, and, once built, the exact prompt. Kept in memory per
 * send id; after a panel reload it is rebuilt from the message itself (attachments are then shipped again, which
 * only costs a second copy of the file on the host - never a second prompt, the relay dedupes by id).
 */
interface SendPayload {
	text: string;
	imageBlocks: ImageContent[];
	attachments: Attachment[];
	context?: string;
	outbound?: string;
	modelImages?: Json[];
}

function payloadFromMessage(m: AgentMessage): SendPayload {
	const content: unknown = (m as { content?: unknown }).content;
	const imageBlocks: ImageContent[] = Array.isArray(content)
		? content.filter(
				(c: unknown): c is ImageContent =>
					isJson(c) && c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string",
			)
		: [];
	return { text: userText(m), imageBlocks, attachments: attachmentsOf(m) ?? [] };
}

export class PrimeRemoteAgent extends Agent {
	readonly agentId: string;
	readonly agentLabel: string;
	primeSessionId: string | undefined;
	status: PrimeStatus = "idle";
	statusDetail = "";
	/** The real remote model (provider intact) — `state.model` is the display view. */
	remoteModel: Model<any> | undefined;
	/** Shown to Tom when a model/thinking choice could not be applied (sidepanel wires this to a toast). */
	onNotice: ((message: string) => void) | undefined;
	/**
	 * Model / thinking level chosen before the bridge session existed. The session is created on the first
	 * send with the bridge's default (claude-sonnet-5-5 / high since 2026-10-03), so these are applied right
	 * after it is created and before the first prompt (Tom, 2026-10-10: picked opus-5-5 + XHigh, ran on
	 * sonnet-5-5 / high, the label silently flipped).
	 */
	private chosenModel: Model<any> | undefined;
	private chosenThinking: ThinkingLevel | undefined;
	/** The harness's own session id (UUID) and jsonl path on the R730, as session-finder / Telegram show them. */
	nativeSessionId: string | undefined;
	nativeSessionFile: string | undefined;
	onStatusChange: ((status: PrimeStatus) => void) | undefined;
	/** Files the agent queued with telegram_attach; the side panel turns them into artifacts. */
	onAttachments: ((items: PrimeAttachment[]) => Promise<void>) | undefined;
	/** After attach(): the side panel compares the R730's stored artifacts with the panel and restores what is missing. */
	onArtifactsReconcile: (() => Promise<void>) | undefined;
	/** The R730 session for a new chat exists now (its first message is already in `messages`). */
	onSessionCreated: ((sessionId: string) => void) | undefined;

	private readonly remote: AgentState;
	private readonly remoteListeners = new Set<(e: AgentEvent) => void>();
	private socket: PrimeSocket | undefined;
	/** Sent messages whose bridge echo has not arrived yet, in send order; the echo replaces the panel's bubble. */
	private pendingEchoes: AgentMessage[] = [];
	/** Per send id: what goes out, kept until the R730 has accepted it (2026-10-18: retries, no duplicates). */
	private readonly sendPayloads = new Map<string, SendPayload>();
	private readonly delivering = new Set<string>();
	/** When the chat's history was last loaded from the bridge; a send accepted before that is already in it. */
	private hydratedAt = 0;
	private attachRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private attachAttempt = 0;
	/** A brand-new chat has no socket to announce "back online": its failed first send retries on a timer. */
	private newChatRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private newChatAttempt = 0;
	private readonly onBrowserOnline = (): void => {
		if (!this.socket) void this.retryUnsent();
	};
	private readonly windowId: number;
	private readonly tabContext: () => Promise<string>;
	private createInFlight: Promise<string> | undefined;

	constructor(opts: {
		/** Relay agent id: "prime" (main-pi) or a worker id such as "quantcoach". */
		agentId?: string;
		agentLabel?: string;
		sessionId?: string;
		model: Model<any>;
		thinkingLevel: ThinkingLevel;
		messages?: AgentMessage[];
		windowId: number;
		/** Short description of the active tab, prefixed to each prompt so prime knows where Tom is. */
		tabContext: () => Promise<string>;
		/** Apply `model` to the new bridge session even if Tom does not pick one (the interactive default, for any agent). */
		applyInitialModel?: boolean;
	}) {
		super({
			initialState: {
				systemPrompt: "",
				model: opts.model,
				thinkingLevel: opts.thinkingLevel,
				messages: [],
				tools: [],
			},
			streamFn: () => {
				throw new Error("PrimeRemoteAgent never streams locally");
			},
		});
		this.agentId = opts.agentId ?? MAIN_AGENT_ID;
		this.agentLabel = opts.agentLabel ?? (this.agentId === MAIN_AGENT_ID ? "prime-agent" : this.agentId);
		this.primeSessionId = opts.sessionId;
		this.windowId = opts.windowId;
		this.tabContext = opts.tabContext;
		this.remoteModel = opts.model;
		if (opts.applyInitialModel && !opts.sessionId) this.chosenModel = opts.model;
		this.remote = {
			systemPrompt: "",
			model: primeModelView(opts.model),
			thinkingLevel: opts.thinkingLevel,
			tools: [],
			messages: (opts.messages ?? []).filter((m) => LLM_ROLES.has(m.role) || isArtifactMessage(m)),
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Set(),
		};
		// AgentInterface only wires its own streamFn/getApiKey when these are missing.
		this.getApiKey = async () => "remote";
		window.addEventListener("online", this.onBrowserOnline);
	}

	override get state(): AgentState {
		return this.remote;
	}

	override subscribe(fn: (e: AgentEvent) => void): () => void {
		this.remoteListeners.add(fn);
		return () => this.remoteListeners.delete(fn);
	}

	private emitRemote(e: AgentEvent): void {
		for (const listener of this.remoteListeners) {
			try {
				listener(e);
			} catch (err) {
				console.error("[prime] listener failed", err);
			}
		}
	}

	private setStatus(status: PrimeStatus, detail = ""): void {
		this.status = status;
		this.statusDetail = detail;
		this.onStatusChange?.(status);
	}

	// ---- lifecycle ------------------------------------------------------------------------------

	/**
	 * Resume an existing bridge session: fresh history from the bridge, then live events. Offline, it keeps trying
	 * (5 s, 10 s, 20 s, 40 s...) instead of leaving a dead chat behind (2026-10-18).
	 */
	async attach(): Promise<void> {
		if (!this.primeSessionId) return;
		this.setStatus("connecting", this.attachAttempt > 0 ? `attempt ${this.attachAttempt + 1}` : "");
		try {
			const h = await primeHydrate(this.agentId, this.primeSessionId);
			this.hydratedAt = Date.now();
			this.attachAttempt = 0;
			this.applyRemoteState(h.state);
			const artifacts = this.remote.messages.filter(isArtifactMessage);
			// Messages the R730 never confirmed (saved as failed, or in flight when the panel closed) stay at the end
			// as failed; retrying is safe because the relay ignores a repeat of a send that did land.
			const unsent = this.remote.messages.filter(isUnsent).map((m) => {
				const s = sendStateOf(m);
				return s ? withSendState(m, { ...s, state: "failed" }) : m;
			});
			this.pendingEchoes = [];
			this.remote.messages = [...toAgentMessages(h.messages), ...artifacts, ...unsent];
			this.openSocket(h.offset);
			this.emitRemote({ type: "agent_end", messages: [] });
			void this.onArtifactsReconcile?.().catch((err) => console.warn("[prime] artifact reconcile failed", err));
		} catch (err) {
			const delay = Math.min(40_000, 5_000 * 2 ** Math.min(this.attachAttempt++, 3));
			this.setStatus("error", `${describeSendError(err)}; retrying in ${Math.round(delay / 1000)} s`);
			if (!this.attachRetryTimer)
				this.attachRetryTimer = setTimeout(() => {
					this.attachRetryTimer = undefined;
					void this.attach().catch(() => undefined);
				}, delay);
			throw err;
		}
	}

	private async ensureSession(name: string): Promise<string> {
		if (this.primeSessionId) return this.primeSessionId;
		if (!this.createInFlight) {
			this.setStatus("creating");
			this.createInFlight = primeCreateSession(this.agentId, name).then(async ({ sessionId, state }) => {
				this.primeSessionId = sessionId;
				this.onSessionCreated?.(sessionId);
				this.applyRemoteState(state);
				await this.applyChosenSettings(sessionId);
				this.openSocket(0);
				return sessionId;
			});
		}
		try {
			return await this.createInFlight;
		} catch (err) {
			this.createInFlight = undefined;
			this.setStatus("error", err instanceof Error ? err.message : String(err));
			throw err;
		}
	}

	/**
	 * Push the model / thinking level chosen before the session existed, then read back what the session really
	 * runs (a model switch can clamp the thinking level), so the labels never claim something that is not running.
	 */
	private async applyChosenSettings(sessionId: string): Promise<void> {
		const model = this.chosenModel;
		const level = this.chosenThinking;
		this.chosenModel = undefined;
		this.chosenThinking = undefined;
		if (!model && !level) return;
		const failures: string[] = [];
		if (model) {
			try {
				await primeRpc(this.agentId, sessionId, { type: "set_model", provider: model.provider, modelId: model.id });
			} catch (err) {
				failures.push(`model ${model.id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (level) {
			try {
				await primeRpc(this.agentId, sessionId, { type: "set_thinking_level", level });
			} catch (err) {
				failures.push(`thinking ${level}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		try {
			this.applyRemoteState(await primeRpc(this.agentId, sessionId, { type: "get_state" }));
		} catch (err) {
			console.warn("[prime] get_state after applying choices failed", err);
		}
		const runningModel = this.remoteModel?.id ?? "?";
		const runningLevel = this.remote.thinkingLevel;
		if (model && runningModel !== model.id) failures.push(`running ${runningModel} instead of ${model.id}`);
		else if (level && runningLevel !== level)
			failures.push(`thinking is ${runningLevel}, not ${level} (not supported by ${runningModel}?)`);
		if (failures.length > 0) {
			console.warn("[prime] chosen settings not fully applied", failures);
			this.onNotice?.(`Could not apply your choice: ${failures.join("; ")}`);
		}
	}

	private applyRemoteState(state: Json): void {
		if (isModel(state.model)) {
			this.remoteModel = state.model;
			this.remote.model = primeModelView(state.model);
		}
		if (typeof state.thinkingLevel === "string") this.remote.thinkingLevel = state.thinkingLevel as ThinkingLevel;
		if (typeof state.isStreaming === "boolean") this.remote.isStreaming = state.isStreaming;
		if (typeof state.sessionId === "string" && state.sessionId) this.nativeSessionId = state.sessionId;
		if (typeof state.sessionFile === "string" && state.sessionFile) this.nativeSessionFile = state.sessionFile;
	}

	private openSocket(offset: number): void {
		if (!this.primeSessionId) return;
		this.socket?.close();
		this.socket = new PrimeSocket(this.agentId, this.primeSessionId, offset, {
			onEvents: (events) => this.applyEvents(events),
			onBrowserCall: (id, tool, args) => void this.runBrowserCall(id, tool, args),
			onBrowserCancel: (id) => void cancelBrowserCall(id),
			onAttachments: (items) => void this.receiveAttachments(items),
			onStatus: (status, detail) => {
				this.setStatus(status, detail ?? "");
				// The live connection is back: send what could not go out while it was down, oldest first.
				if (status === "open") void this.retryUnsent();
			},
		});
		void this.socket.connect();
	}

	private async runBrowserCall(id: string, tool: string, args: Json): Promise<void> {
		try {
			const result = await handleBrowserCall(tool, args, this.windowId, id);
			this.socket?.replyBrowserCall(id, true, result);
		} catch (err) {
			this.socket?.replyBrowserCall(id, false, undefined, err instanceof Error ? err.message : String(err));
		}
	}

	private readonly deliveredAttachmentIds = new Set<string>();

	private async receiveAttachments(all: PrimeAttachment[]): Promise<void> {
		if (!this.onAttachments) return;
		// The relay pushes on connect and after each turn; the same queue entry can arrive twice before the ack lands.
		const items = all.filter((i) => !this.deliveredAttachmentIds.has(i.id));
		if (items.length === 0) return;
		for (const i of items) this.deliveredAttachmentIds.add(i.id);
		try {
			await this.onAttachments(items);
			this.socket?.ackAttachments(items.map((i) => i.id));
		} catch (err) {
			for (const i of items) this.deliveredAttachmentIds.delete(i.id);
			console.error("[prime] attachment delivery failed", err);
		}
	}

	detach(): void {
		if (this.attachRetryTimer) clearTimeout(this.attachRetryTimer);
		this.attachRetryTimer = undefined;
		if (this.newChatRetryTimer) clearTimeout(this.newChatRetryTimer);
		this.newChatRetryTimer = undefined;
		window.removeEventListener("online", this.onBrowserOnline);
		this.socket?.close();
		this.socket = undefined;
	}

	// ---- event replay -----------------------------------------------------------------------------

	/** Bridge notices already toasted (a reconnect can deliver the same journal events again). */
	private readonly shownNotices = new Set<string>();

	private applyEvents(events: Json[]): void {
		for (const raw of events) {
			if (isBridgeNotice(raw)) {
				// Not an agent event: the bridge's own notices (e.g. its dead-call watchdog) become a toast.
				const toast = bridgeNoticeToast(raw, Date.now());
				const key = `${String(raw.timestamp)}|${toast}`;
				if (toast !== undefined && !this.shownNotices.has(key)) {
					this.shownNotices.add(key);
					this.onNotice?.(toast);
				}
				continue;
			}
			if (typeof raw.type !== "string" || !AGENT_EVENT_TYPES.has(raw.type)) continue;
			// The bridge log carries pi-agent-core AgentEvents verbatim; shape checked per case below.
			const event = raw as unknown as AgentEvent;
			switch (event.type) {
				case "agent_start":
					this.remote.isStreaming = true;
					this.remote.error = undefined;
					break;
				case "message_start":
				case "message_update":
					if (!isAgentMessage(event.message)) continue;
					this.remote.streamMessage = event.message.role === "user" ? null : event.message;
					break;
				case "message_end": {
					if (!isAgentMessage(event.message)) continue;
					this.remote.streamMessage = null;
					this.appendRemoteMessage(event.message);
					break;
				}
				case "tool_execution_start": {
					const pending = new Set(this.remote.pendingToolCalls);
					pending.add(event.toolCallId);
					this.remote.pendingToolCalls = pending;
					break;
				}
				case "tool_execution_end": {
					const pending = new Set(this.remote.pendingToolCalls);
					pending.delete(event.toolCallId);
					this.remote.pendingToolCalls = pending;
					break;
				}
				case "turn_end":
					if (
						isAgentMessage(event.message) &&
						event.message.role === "assistant" &&
						(event.message as { errorMessage?: string }).errorMessage
					) {
						this.remote.error = (event.message as { errorMessage?: string }).errorMessage;
					}
					break;
				case "agent_end":
					this.remote.isStreaming = false;
					this.remote.streamMessage = null;
					this.remote.pendingToolCalls = new Set();
					break;
				default:
					break;
			}
			this.emitRemote(event);
		}
	}

	private appendRemoteMessage(incoming: AgentMessage): void {
		if (!LLM_ROLES.has(incoming.role)) return;
		const messages = this.remote.messages;
		if (incoming.role === "user") {
			// The bridge's echo of a message this panel sent replaces the panel's own bubble: the oldest sent one
			// still waiting for its echo, or, when a send's answer was lost but the prompt landed (the echo then
			// arrives before the retry says duplicate), the oldest unsent bubble with the same text.
			const echoed = stripBrowserContext([incoming])[0] ?? incoming;
			let optimistic = this.pendingEchoes.shift();
			if (!optimistic) {
				const echoText = userText(echoed).trim();
				optimistic = messages.find(
					(m) => isUnsent(m) && echoText.startsWith(userText(m).trim()) && userText(m).trim() !== "",
				);
				const id = optimistic ? sendStateOf(optimistic)?.id : undefined;
				if (id) this.sendPayloads.delete(id);
			}
			const idx = optimistic ? messages.lastIndexOf(optimistic) : -1;
			if (optimistic && idx >= 0) {
				// The bridge echoes text only; keep the attachment tiles from the optimistic bubble so the
				// transcript still shows what Tom attached.
				const tiles = attachmentsOf(optimistic);
				const withTiles = tiles ? ({ ...incoming, attachments: tiles } as AgentMessage) : incoming;
				const message = stripBrowserContext([withTiles])[0] ?? withTiles;
				// Take the bridge's position: a steer sent mid-tool belongs after that tool's result, not before it.
				this.remote.messages = [...messages.slice(0, idx), ...messages.slice(idx + 1), message];
				this.onStatusChange?.(this.status);
				return;
			}
		}
		const message = incoming.role === "user" ? (stripBrowserContext([incoming])[0] ?? incoming) : incoming;
		const last = messages[messages.length - 1];
		if (last && sameMessage(last, message)) return; // hydrate/stream overlap
		this.remote.messages = [...messages, message];
	}

	// ---- Agent API used by the UI ---------------------------------------------------------------

	override appendMessage(m: AgentMessage): void {
		this.remote.messages = [...this.remote.messages, m];
	}

	override replaceMessages(ms: AgentMessage[]): void {
		this.remote.messages = ms.slice();
	}

	override clearMessages(): void {
		this.remote.messages = [];
	}

	override async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		const { text, imageBlocks, attachments, optimistic } = this.composePrompt(input, images);
		if (!text.trim() && imageBlocks.length === 0 && attachments.length === 0) return;
		// The bubble shows at once, marked "sending" until the R730 has it. The id travels with the prompt; a retry
		// repeats it and the relay answers duplicate:true instead of prompting twice (2026-10-18, Tom on a train:
		// a copy that never left the browser looked sent, and a blind resend could have run the task again).
		const id = crypto.randomUUID();
		// The tab context is read BEFORE the bubble goes in: the first message of a chat gets the long form (tools,
		// draw guidance), chosen by "no messages yet".
		const context = await this.tabContext().catch(() => "");
		this.sendPayloads.set(id, { text, imageBlocks, attachments, context });
		this.remote.messages = [
			...this.remote.messages,
			withSendState(optimistic, { id, state: "sending", at: Date.now() }),
		];
		await this.deliver(id);
	}

	/** Messages shown in the chat that the R730 has not confirmed (in flight or failed). */
	get unsentCount(): number {
		return this.remote.messages.filter(isUnsent).length;
	}

	/** Send a failed message again, by hand (the bubble's Retry) - same id, so never a second prompt. */
	retrySend(id: string): void {
		void this.deliver(id);
	}

	/** Drop a failed message without sending it (the bubble's Discard). */
	discardSend(id: string): void {
		this.sendPayloads.delete(id);
		this.remote.messages = this.remote.messages.filter((m) => sendStateOf(m)?.id !== id);
		this.emitRemote({ type: "turn_start" }); // repaint the list
		this.onStatusChange?.(this.status);
	}

	/** After a reconnect: failed sends go out again, oldest first; one failure stops the run until the next reconnect. */
	private async retryUnsent(): Promise<void> {
		for (const m of this.remote.messages.filter((x) => sendStateOf(x)?.state === "failed")) {
			const id = sendStateOf(m)?.id;
			if (id && !(await this.deliver(id))) break;
		}
	}

	private findSend(id: string): AgentMessage | undefined {
		return this.remote.messages.find((m) => sendStateOf(m)?.id === id);
	}

	/** Replace the bubble of send `id` with a copy carrying `state` (undefined = sent); returns the new bubble. */
	private markSend(id: string, state: SendState | undefined): AgentMessage | undefined {
		const current = this.findSend(id);
		if (!current) return undefined;
		const next = withSendState(current, state);
		this.remote.messages = this.remote.messages.map((m) => (m === current ? next : m));
		return next;
	}

	/**
	 * One attempt to get send `id` to the R730. Builds the prompt once (tab context, files shipped, images fitted)
	 * and keeps it for retries. Resolves true when the R730 has the message (also when it already had it).
	 */
	private async deliver(id: string): Promise<boolean> {
		const current = this.findSend(id);
		if (!current || this.delivering.has(id)) return false;
		let payload = this.sendPayloads.get(id);
		if (!payload) {
			payload = payloadFromMessage(current); // after a panel reload
			this.sendPayloads.set(id, payload);
		}
		this.delivering.add(id);
		this.markSend(id, { id, state: "sending", at: Date.now() });
		// Sent while a turn is running = steering, like a Telegram message mid-turn: delivered at the next
		// tool boundary (bridge streamingBehavior "steer"); the turn keeps going.
		const steering = this.remote.isStreaming;
		this.remote.error = undefined;
		if (!steering) {
			this.remote.isStreaming = true;
			this.emitRemote({ type: "agent_start" });
		} else {
			this.emitRemote({ type: "turn_start" }); // nudges the UI to re-render the list
		}
		try {
			// After a panel reload the context is rebuilt here; the chat then has messages, so it is the short form.
			if (payload.context === undefined) payload.context = await this.tabContext().catch(() => "");
			const sessionId = await this.ensureSession(
				payload.text.slice(0, 60) || payload.attachments[0]?.fileName || "browser session",
			);
			if (payload.outbound === undefined) {
				// The model gets images scaled to fit 2000 px: a full-size Retina screenshot (3432 px) broke every later
				// turn of a chat once it held more than 20 images (2026-10-17, src/utils/image-size.ts). Files stay full size.
				const fits = await Promise.all(payload.imageBlocks.map((block) => fitImageForModel(block)));
				const fitByData = new Map(payload.imageBlocks.map((block, i) => [block.data, fits[i]]));
				payload.modelImages = fits.map((fit) => fit.image as unknown as Json); // ImageContent is a plain JSON object
				// Attachments become files on the agent's host BEFORE the prompt goes out, so the prompt can name
				// their paths (the model reads/uploads the file; no extracted-text dump).
				const filesSection =
					payload.attachments.length > 0
						? await this.shipAttachments(sessionId, payload.attachments, fitByData)
						: "";
				payload.outbound = [payload.context, payload.text, filesSection]
					.filter((part) => part.trim().length > 0)
					.join("\n\n");
			}
			const reply = await primePrompt(
				this.agentId,
				sessionId,
				payload.outbound,
				payload.modelImages && payload.modelImages.length > 0 ? payload.modelImages : undefined,
				steering ? "steer" : undefined,
				id,
			);
			this.sendPayloads.delete(id);
			this.newChatAttempt = 0;
			const acceptedAt = typeof reply.acceptedAt === "string" ? Date.parse(reply.acceptedAt) : Number.NaN;
			if (reply.duplicate === true) {
				// The R730 already had it (an earlier attempt landed, its answer did not). If that was before this
				// panel loaded the chat, the history above already shows it; and no new turn starts for a repeat.
				if (Number.isFinite(acceptedAt) && acceptedAt < this.hydratedAt)
					this.remote.messages = this.remote.messages.filter((m) => sendStateOf(m)?.id !== id);
				else {
					const sent = this.markSend(id, undefined);
					if (sent) this.pendingEchoes.push(sent);
				}
				try {
					this.applyRemoteState(await primeRpc(this.agentId, sessionId, { type: "get_state" }));
				} catch (err) {
					console.warn("[prime] get_state after a duplicate send failed", err);
					this.remote.isStreaming = false;
				}
				if (!this.remote.isStreaming) this.emitRemote({ type: "agent_end", messages: [] });
				else this.emitRemote({ type: "turn_start" });
			} else {
				const sent = this.markSend(id, undefined);
				if (sent) this.pendingEchoes.push(sent);
				this.emitRemote({ type: "turn_start" }); // the bubble loses its "sending" line
			}
			return true;
		} catch (err) {
			const error = describeSendError(err);
			this.markSend(id, { id, state: "failed", at: Date.now(), error });
			if (!steering) {
				this.remote.isStreaming = false;
				this.emitRemote({ type: "agent_end", messages: [] });
			} else {
				this.emitRemote({ type: "turn_start" });
			}
			this.onNotice?.(`Not sent: ${error}. It goes out when the connection is back, or press Retry.`);
			if (this.socket)
				this.socket.reconnectNow(); // a failed send is a cheap sign the live connection is down too
			else if (!this.newChatRetryTimer) {
				// No session yet (the first message of a new chat failed): try again on a timer, 5 s, 10 s, 20 s, 40 s...
				const delay = Math.min(60_000, 5_000 * 2 ** Math.min(this.newChatAttempt++, 3));
				this.newChatRetryTimer = setTimeout(() => {
					this.newChatRetryTimer = undefined;
					void this.retryUnsent();
				}, delay);
			}
			return false;
		} finally {
			this.delivering.delete(id);
			this.onStatusChange?.(this.status); // header: the unsent count
		}
	}

	private composePrompt(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): { text: string; imageBlocks: ImageContent[]; attachments: Attachment[]; optimistic: AgentMessage } {
		const timestamp = Date.now();
		if (typeof input === "string") {
			const imageBlocks = images ?? [];
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: input }, ...imageBlocks];
			return {
				text: input,
				imageBlocks,
				attachments: [],
				optimistic: { role: "user", content, timestamp } as AgentMessage,
			};
		}
		const message = Array.isArray(input) ? input[0] : input;
		if (!message)
			return {
				text: "",
				imageBlocks: [],
				attachments: [],
				optimistic: { role: "user", content: "", timestamp } as AgentMessage,
			};
		const parts: string[] = [];
		const imageBlocks: ImageContent[] = [];
		const blocks: (TextContent | ImageContent)[] = [];
		const collect = (c: TextContent | ImageContent) => {
			blocks.push(c);
			if (c.type === "text") parts.push(c.text);
			else imageBlocks.push(c);
		};
		let attachments: Attachment[] = [];
		if (message.role === "user-with-attachments") {
			const um = message as UserMessageWithAttachments;
			if (typeof um.content === "string") collect({ type: "text", text: um.content });
			else for (const c of um.content) collect(c);
			// Not pi-web-ui's convertAttachments: that pastes a PDF's extracted text into the prompt. The
			// files go to the agent's host in prompt() and the prompt names their paths; images are also
			// passed inline so the model can see them.
			attachments = um.attachments ?? [];
			for (const a of attachments) {
				if (a.type === "image") collect({ type: "image", data: a.content, mimeType: a.mimeType });
			}
		} else if (message.role === "user") {
			if (typeof message.content === "string") collect({ type: "text", text: message.content });
			else for (const c of message.content) collect(c);
		}
		const optimistic: AgentMessage = {
			role: "user",
			content: blocks,
			timestamp,
			...(attachments.length > 0 ? { attachments } : {}),
		} as AgentMessage;
		return { text: parts.join("\n\n"), imageBlocks, attachments, optimistic };
	}

	/**
	 * Side-panel attachments -> files on the agent's host (relay /files -> bridge /files). The bytes never
	 * enter the prompt: the model gets paths (read it yourself, or browser_upload_file it into a page). When
	 * an upload fails, a document's browser-extracted text is inlined after the block as the fallback so the
	 * prompt still carries the content; an image is inline anyway.
	 */
	private async shipAttachments(
		sessionId: string,
		attachments: Attachment[],
		fitByData: Map<string, ImageFit | undefined>,
	): Promise<string> {
		const turnId = `sg-${Date.now().toString(36)}`;
		const shipped = await Promise.all(
			attachments.map(async (a) => {
				const fit = a.type === "image" ? fitByData.get(a.content) : undefined;
				const shownAs =
					fit?.scaled === true
						? {
								width: fit.width,
								height: fit.height,
								originalWidth: fit.originalWidth,
								originalHeight: fit.originalHeight,
							}
						: undefined;
				const base = { fileName: a.fileName, mimeType: a.mimeType, size: a.size, kind: a.type, shownAs };
				try {
					const stored = await primeUploadFile(this.agentId, sessionId, {
						filename: a.fileName,
						mime: a.mimeType,
						dataBase64: a.content,
						turnId,
					});
					return { ...base, path: stored.path };
				} catch (err) {
					console.warn("[prime] attachment upload failed", a.fileName, err);
					return {
						...base,
						error: err instanceof Error ? err.message : String(err),
						extractedText: a.extractedText,
					};
				}
			}),
		);
		return buildAttachmentsSection(shipped);
	}

	override abort(): void {
		if (!this.primeSessionId) return;
		void primeRpc(this.agentId, this.primeSessionId, { type: "abort" }).catch((err) =>
			console.warn("[prime] abort failed", err),
		);
	}

	override async waitForIdle(): Promise<void> {
		while (this.remote.isStreaming) await new Promise((r) => setTimeout(r, 250));
	}

	override setModel(m: Model<any>): void {
		// Called with a real bridge model (provider intact) from the prime model picker.
		this.remoteModel = m;
		this.remote.model = primeModelView(m);
		if (!this.primeSessionId) {
			this.chosenModel = m; // applied when the first send creates the session
			return;
		}
		void primeRpc(this.agentId, this.primeSessionId, {
			type: "set_model",
			provider: m.provider,
			modelId: m.id,
		}).catch((err) => {
			console.warn("[prime] set_model failed", err);
			this.onNotice?.(`Model ${m.id} was not applied: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	override setThinkingLevel(l: ThinkingLevel): void {
		this.remote.thinkingLevel = l;
		if (!this.primeSessionId) {
			this.chosenThinking = l; // applied when the first send creates the session
			return;
		}
		void primeRpc(this.agentId, this.primeSessionId, { type: "set_thinking_level", level: l }).catch((err) => {
			console.warn("[prime] set_thinking_level failed", err);
			this.onNotice?.(`Thinking level ${l} was not applied: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	override setSystemPrompt(): void {
		/* prime owns its system prompt */
	}

	override setTools(): void {
		/* tools run on the R730 */
	}

	override steer(): void {
		/* tab-switch steering is not forwarded to prime (v1) */
	}

	override followUp(): void {
		/* not used by the side panel */
	}

	override reset(): void {
		this.detach();
		this.remote.messages = [];
		this.remote.isStreaming = false;
		this.remote.streamMessage = null;
		this.remote.pendingToolCalls = new Set();
	}

	/**
	 * Model list from the bridge session's own registry. On a brand-new chat the session is created
	 * here (cheap: the bridge spawns it once and the first prompt reuses it), so the picker works
	 * before any message has been sent.
	 */
	async availableModels(): Promise<Model<any>[]> {
		// For main-pi the proxy catalog IS its registry (one source of truth), so no session is needed.
		// Workers have their own credentials/registries: ask their session.
		if (this.agentId === MAIN_AGENT_ID) {
			const fromCatalog = catalogProviders().flatMap((p) => registryModels(p));
			if (fromCatalog.length > 0) return fromCatalog;
		}
		const sessionId = await this.ensureSession("browser session");
		const data = await primeRpc(this.agentId, sessionId, { type: "get_available_models" });
		return Array.isArray(data.models) ? data.models.filter(isModel) : [];
	}

	async rename(name: string): Promise<void> {
		if (!this.primeSessionId) return;
		await primeRpc(this.agentId, this.primeSessionId, {
			type: "set_session_name",
			name: `sitegeist / ${name}`,
		}).catch(() => undefined);
	}
}
