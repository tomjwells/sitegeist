/**
 * Client for the prime relay (cors-proxy /sitegeist/prime/*): drives a prime-agent (main-pi body)
 * session on the R730 as a second client of the prime bridge - the Telegram router is the first.
 * The relay holds the bridge token; the browser only ever talks to the private cors-proxy host.
 */
import { getSitegeistStorage } from "../storage/app-storage.js";
import { DEFAULT_SYNC_URL, SYNC_URL_SETTING } from "../sync.js";

export type Json = Record<string, unknown>;
export const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const TIMEOUT_MS = 90_000;

export async function primeBaseUrl(): Promise<string> {
	const sync = ((await getSitegeistStorage().settings.get<string>(SYNC_URL_SETTING)) ?? DEFAULT_SYNC_URL).trim();
	return `${sync.replace(/\/$/, "")}/prime`;
}

async function request(method: "GET" | "POST", path: string, body?: Json): Promise<Json> {
	const base = await primeBaseUrl();
	const init: RequestInit = { method, signal: AbortSignal.timeout(TIMEOUT_MS) };
	if (body) init.headers = { "content-type": "application/json" };
	if (body) init.body = JSON.stringify(body);
	const res = await fetch(`${base}${path}`, init);
	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		throw new Error(`prime relay ${method} ${path}: non-JSON response (${res.status})`);
	}
	if (!isJson(parsed)) throw new Error(`prime relay ${method} ${path}: unexpected body (${res.status})`);
	if (!res.ok) {
		const err = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
		throw new Error(`prime relay ${method} ${path}: ${err}`);
	}
	return parsed;
}

export interface PrimeHealth {
	ok: boolean;
	bridge?: { version?: string; worker?: string; agent?: string; sessions?: number };
	connectedBrowsers: string[];
}

export async function primeHealth(): Promise<PrimeHealth> {
	const r = await request("GET", "/health");
	return {
		ok: r.ok === true,
		bridge: isJson(r.bridge) ? (r.bridge as PrimeHealth["bridge"]) : undefined,
		connectedBrowsers: Array.isArray(r.connectedBrowsers)
			? r.connectedBrowsers.filter((s): s is string => typeof s === "string")
			: [],
	};
}

export async function primeCreateSession(name: string): Promise<{ sessionId: string; state: Json }> {
	const r = await request("POST", "/sessions", { name });
	if (typeof r.sessionId !== "string") throw new Error("prime relay: session create returned no id");
	return { sessionId: r.sessionId, state: isJson(r.state) ? r.state : {} };
}

export interface PrimeHydration {
	offset: number;
	state: Json;
	messages: Json[];
}

export async function primeHydrate(sessionId: string): Promise<PrimeHydration> {
	const r = await request("GET", `/sessions/${encodeURIComponent(sessionId)}`);
	if (r.ok !== true) throw new Error("prime relay: session is not available (bridge could not start it)");
	return {
		offset: typeof r.offset === "number" ? r.offset : 0,
		state: isJson(r.state) ? r.state : {},
		messages: Array.isArray(r.messages) ? r.messages.filter(isJson) : [],
	};
}

export async function primePrompt(
	sessionId: string,
	message: string,
	images?: Json[],
	streamingBehavior?: "steer" | "followUp",
): Promise<Json> {
	const body: Json = { message };
	if (images && images.length > 0) body.images = images;
	if (streamingBehavior) body.streamingBehavior = streamingBehavior;
	return request("POST", `/sessions/${encodeURIComponent(sessionId)}/prompt`, body);
}

export async function primeRpc(sessionId: string, command: Json): Promise<Json> {
	const r = await request("POST", `/sessions/${encodeURIComponent(sessionId)}/rpc`, command);
	const response = isJson(r.response) ? r.response : undefined;
	if (response && response.success === false) {
		throw new Error(typeof response.error === "string" ? response.error : `rpc ${String(command.type)} failed`);
	}
	return response && isJson(response.data) ? response.data : {};
}

export async function primeStop(sessionId: string): Promise<void> {
	await request("POST", `/sessions/${encodeURIComponent(sessionId)}/stop`, {});
}

// ---- event socket -----------------------------------------------------------------------------

export interface PrimeAttachment {
	id: string;
	filename: string;
	mime: string;
	bytes: number;
	caption: string;
	dataBase64: string;
}

const isAttachment = (v: unknown): v is PrimeAttachment =>
	isJson(v) &&
	typeof v.id === "string" &&
	typeof v.filename === "string" &&
	typeof v.mime === "string" &&
	typeof v.dataBase64 === "string";

export interface PrimeSocketHandlers {
	onEvents: (events: Json[], offset: number) => void;
	onBrowserCall: (id: string, tool: string, args: Json) => void;
	onBrowserCancel: (id: string, reason: string) => void;
	onAttachments: (items: PrimeAttachment[]) => void;
	onStatus: (status: "connecting" | "open" | "closed", detail?: string) => void;
}

/** One WebSocket per session; reconnects with backoff, resumes from the last seen log offset. */
export class PrimeSocket {
	private ws: WebSocket | undefined;
	private closed = false;
	private attempt = 0;
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly sessionId: string,
		private offset: number,
		private readonly handlers: PrimeSocketHandlers,
	) {}

	async connect(): Promise<void> {
		if (this.closed) return;
		const base = await primeBaseUrl();
		const url = `${base.replace(/^http/, "ws")}/sessions/${encodeURIComponent(this.sessionId)}/ws?offset=${this.offset}`;
		this.handlers.onStatus("connecting");
		const ws = new WebSocket(url);
		this.ws = ws;
		ws.onopen = () => {
			this.attempt = 0;
			this.handlers.onStatus("open");
			this.pingTimer = setInterval(() => this.send({ type: "ping" }), 20_000);
		};
		ws.onmessage = (ev) => this.handleMessage(ev.data);
		ws.onerror = () => {
			/* onclose follows; nothing to do here */
		};
		ws.onclose = (ev) => {
			if (this.pingTimer) clearInterval(this.pingTimer);
			this.pingTimer = undefined;
			if (this.ws !== ws) return;
			this.ws = undefined;
			this.handlers.onStatus("closed", `${ev.code}${ev.reason ? ` ${ev.reason}` : ""}`);
			if (!this.closed) {
				const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt++, 5));
				this.reconnectTimer = setTimeout(() => void this.connect(), delay);
			}
		};
	}

	private handleMessage(raw: unknown): void {
		if (typeof raw !== "string") return;
		let msg: unknown;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (!isJson(msg)) return;
		if (msg.type === "events") {
			const events = Array.isArray(msg.events) ? msg.events.filter(isJson) : [];
			if (typeof msg.offset === "number") this.offset = msg.offset;
			if (events.length > 0) this.handlers.onEvents(events, this.offset);
		} else if (msg.type === "browser_call" && typeof msg.id === "string" && typeof msg.tool === "string") {
			this.handlers.onBrowserCall(msg.id, msg.tool, isJson(msg.args) ? msg.args : {});
		} else if (msg.type === "browser_cancel" && typeof msg.id === "string") {
			this.handlers.onBrowserCancel(msg.id, typeof msg.reason === "string" ? msg.reason : "");
		} else if (msg.type === "attachments" && Array.isArray(msg.items)) {
			const items = msg.items.filter(isAttachment);
			if (items.length > 0) this.handlers.onAttachments(items);
		} else if (msg.type === "relay_error") {
			console.warn("[prime] relay error:", msg.message);
		}
	}

	send(payload: Json): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
	}

	ackAttachments(ids: string[]): void {
		this.send({ type: "attachments_ack", ids });
	}

	replyBrowserCall(id: string, ok: boolean, result: unknown, error?: string): void {
		this.send({ type: "browser_result", id, ok, result, error });
	}

	close(): void {
		this.closed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.ws?.close();
		this.ws = undefined;
	}
}
