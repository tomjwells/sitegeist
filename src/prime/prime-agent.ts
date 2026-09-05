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
import { convertAttachments, type UserMessageWithAttachments } from "@mariozechner/pi-web-ui";
import { cancelBrowserCall, handleBrowserCall } from "./browser-tools.js";
import { PRIME_PROVIDER } from "./constants.js";
import {
	isJson,
	type Json,
	type PrimeAttachment,
	PrimeSocket,
	primeCreateSession,
	primeHydrate,
	primePrompt,
	primeRpc,
} from "./prime-client.js";

export { isPrimeSessionId, PRIME_PROVIDER, PRIME_SESSION_PREFIX } from "./constants.js";

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
function stripContextText(text: string): string {
	return text.replace(CONTEXT_RE, "");
}
/** Returns the messages with the browser-context preamble removed from user text (no-op for other roles). */
export function stripBrowserContext(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((m) => {
		if (m.role !== "user") return m;
		const content = m.content;
		if (typeof content === "string")
			return CONTEXT_RE.test(content) ? { ...m, content: stripContextText(content) } : m;
		let changed = false;
		const next = content.map((c) => {
			if (c.type !== "text" || !CONTEXT_RE.test(c.text)) return c;
			changed = true;
			return { ...c, text: stripContextText(c.text) };
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

export class PrimeRemoteAgent extends Agent {
	primeSessionId: string | undefined;
	status: PrimeStatus = "idle";
	statusDetail = "";
	/** The real remote model (provider intact) — `state.model` is the display view. */
	remoteModel: Model<any> | undefined;
	onStatusChange: ((status: PrimeStatus) => void) | undefined;
	/** Files the agent queued with telegram_attach; the side panel turns them into artifacts. */
	onAttachments: ((items: PrimeAttachment[]) => Promise<void>) | undefined;

	private readonly remote: AgentState;
	private readonly remoteListeners = new Set<(e: AgentEvent) => void>();
	private socket: PrimeSocket | undefined;
	private optimisticUser: AgentMessage | undefined;
	private readonly windowId: number;
	private readonly tabContext: () => Promise<string>;
	private createInFlight: Promise<string> | undefined;

	constructor(opts: {
		sessionId?: string;
		model: Model<any>;
		thinkingLevel: ThinkingLevel;
		messages?: AgentMessage[];
		windowId: number;
		/** Short description of the active tab, prefixed to each prompt so prime knows where Tom is. */
		tabContext: () => Promise<string>;
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
		this.primeSessionId = opts.sessionId;
		this.windowId = opts.windowId;
		this.tabContext = opts.tabContext;
		this.remoteModel = opts.model;
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

	/** Resume an existing bridge session: fresh history from the bridge, then live events. */
	async attach(): Promise<void> {
		if (!this.primeSessionId) return;
		this.setStatus("connecting");
		try {
			const h = await primeHydrate(this.primeSessionId);
			this.applyRemoteState(h.state);
			const artifacts = this.remote.messages.filter(isArtifactMessage);
			this.remote.messages = [...toAgentMessages(h.messages), ...artifacts];
			this.openSocket(h.offset);
			this.emitRemote({ type: "agent_end", messages: [] });
		} catch (err) {
			this.setStatus("error", err instanceof Error ? err.message : String(err));
			throw err;
		}
	}

	private async ensureSession(name: string): Promise<string> {
		if (this.primeSessionId) return this.primeSessionId;
		if (!this.createInFlight) {
			this.setStatus("creating");
			this.createInFlight = primeCreateSession(name).then(({ sessionId, state }) => {
				this.primeSessionId = sessionId;
				this.applyRemoteState(state);
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

	private applyRemoteState(state: Json): void {
		if (isModel(state.model)) {
			this.remoteModel = state.model;
			this.remote.model = primeModelView(state.model);
		}
		if (typeof state.thinkingLevel === "string") this.remote.thinkingLevel = state.thinkingLevel as ThinkingLevel;
		if (typeof state.isStreaming === "boolean") this.remote.isStreaming = state.isStreaming;
	}

	private openSocket(offset: number): void {
		if (!this.primeSessionId) return;
		this.socket?.close();
		this.socket = new PrimeSocket(this.primeSessionId, offset, {
			onEvents: (events) => this.applyEvents(events),
			onBrowserCall: (id, tool, args) => void this.runBrowserCall(id, tool, args),
			onBrowserCancel: (id) => void cancelBrowserCall(id),
			onAttachments: (items) => void this.receiveAttachments(items),
			onStatus: (status, detail) => this.setStatus(status, detail ?? ""),
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
		this.socket?.close();
		this.socket = undefined;
	}

	// ---- event replay -----------------------------------------------------------------------------

	private applyEvents(events: Json[]): void {
		for (const raw of events) {
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
		const message = incoming.role === "user" ? (stripBrowserContext([incoming])[0] ?? incoming) : incoming;
		const messages = this.remote.messages;
		if (message.role === "user" && this.optimisticUser) {
			const idx = messages.lastIndexOf(this.optimisticUser);
			this.optimisticUser = undefined;
			if (idx >= 0) {
				// Take the bridge's position: a steer sent mid-tool belongs after that tool's result, not before it.
				this.remote.messages = [...messages.slice(0, idx), ...messages.slice(idx + 1), message];
				return;
			}
		}
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
		const { text, imageBlocks, optimistic } = this.composePrompt(input, images);
		if (!text.trim() && imageBlocks.length === 0) return;
		const context = await this.tabContext().catch(() => "");
		const outbound = context ? `${context}\n\n${text}` : text;
		const sessionId = await this.ensureSession(text.slice(0, 60) || "browser session");
		// Sent while a turn is running = steering, like a Telegram message mid-turn: delivered at the next
		// tool boundary (bridge streamingBehavior "steer"); the turn keeps going.
		const steering = this.remote.isStreaming;
		this.optimisticUser = optimistic;
		this.remote.messages = [...this.remote.messages, optimistic];
		this.remote.error = undefined;
		if (!steering) {
			this.remote.isStreaming = true;
			this.emitRemote({ type: "agent_start" });
		} else {
			this.emitRemote({ type: "turn_start" }); // nudges the UI to re-render the list
		}
		try {
			await primePrompt(
				sessionId,
				outbound,
				imageBlocks.length ? (imageBlocks as unknown as Json[]) : undefined,
				steering ? "steer" : undefined,
			);
		} catch (err) {
			this.remote.error = err instanceof Error ? err.message : String(err);
			this.setStatus("error", this.remote.error);
			if (!steering) {
				this.remote.isStreaming = false;
				this.emitRemote({ type: "agent_end", messages: [] });
			}
			throw err;
		}
	}

	private composePrompt(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): { text: string; imageBlocks: ImageContent[]; optimistic: AgentMessage } {
		const timestamp = Date.now();
		if (typeof input === "string") {
			const imageBlocks = images ?? [];
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: input }, ...imageBlocks];
			return { text: input, imageBlocks, optimistic: { role: "user", content, timestamp } as AgentMessage };
		}
		const message = Array.isArray(input) ? input[0] : input;
		if (!message)
			return { text: "", imageBlocks: [], optimistic: { role: "user", content: "", timestamp } as AgentMessage };
		const parts: string[] = [];
		const imageBlocks: ImageContent[] = [];
		const blocks: (TextContent | ImageContent)[] = [];
		const collect = (c: TextContent | ImageContent) => {
			blocks.push(c);
			if (c.type === "text") parts.push(c.text);
			else imageBlocks.push(c);
		};
		if (message.role === "user-with-attachments") {
			const um = message as UserMessageWithAttachments;
			if (typeof um.content === "string") collect({ type: "text", text: um.content });
			else for (const c of um.content) collect(c);
			if (um.attachments) for (const c of convertAttachments(um.attachments)) collect(c);
		} else if (message.role === "user") {
			if (typeof message.content === "string") collect({ type: "text", text: message.content });
			else for (const c of message.content) collect(c);
		}
		return {
			text: parts.join("\n\n"),
			imageBlocks,
			optimistic: { role: "user", content: blocks, timestamp } as AgentMessage,
		};
	}

	override abort(): void {
		if (!this.primeSessionId) return;
		void primeRpc(this.primeSessionId, { type: "abort" }).catch((err) => console.warn("[prime] abort failed", err));
	}

	override async waitForIdle(): Promise<void> {
		while (this.remote.isStreaming) await new Promise((r) => setTimeout(r, 250));
	}

	override setModel(m: Model<any>): void {
		// Called with a real bridge model (provider intact) from the prime model picker.
		this.remoteModel = m;
		this.remote.model = primeModelView(m);
		if (this.primeSessionId) {
			void primeRpc(this.primeSessionId, { type: "set_model", provider: m.provider, modelId: m.id }).catch((err) =>
				console.warn("[prime] set_model failed", err),
			);
		}
	}

	override setThinkingLevel(l: ThinkingLevel): void {
		this.remote.thinkingLevel = l;
		if (this.primeSessionId) {
			void primeRpc(this.primeSessionId, { type: "set_thinking_level", level: l }).catch((err) =>
				console.warn("[prime] set_thinking_level failed", err),
			);
		}
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
		const sessionId = await this.ensureSession("browser session");
		const data = await primeRpc(sessionId, { type: "get_available_models" });
		return Array.isArray(data.models) ? data.models.filter(isModel) : [];
	}

	async rename(name: string): Promise<void> {
		if (!this.primeSessionId) return;
		await primeRpc(this.primeSessionId, { type: "set_session_name", name: `sitegeist / ${name}` }).catch(
			() => undefined,
		);
	}
}
