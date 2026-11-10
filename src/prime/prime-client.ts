/**
 * Client for the prime relay (cors-proxy /sitegeist/prime/*): drives a prime-agent (main-pi body)
 * session on the R730 as a second client of the prime bridge - the Telegram router is the first.
 * The relay holds the bridge token; the browser only ever talks to the private cors-proxy host.
 */
import { getSitegeistStorage } from "../storage/app-storage.js";
import { DEFAULT_SYNC_URL, proxyToken, SYNC_URL_SETTING } from "../sync.js";
import { type RemoteChat, remoteChatOf } from "./chat-list.js";
import { type RemoteText, remoteTextOf } from "./chat-text.js";
import { type ImageRef, imageUrl } from "./image-refs.js";

export type Json = Record<string, unknown>;
export const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const TIMEOUT_MS = 90_000;

export async function primeBaseUrl(agentId: string): Promise<string> {
	const sync = ((await getSitegeistStorage().settings.get<string>(SYNC_URL_SETTING)) ?? DEFAULT_SYNC_URL).trim();
	return `${sync.replace(/\/$/, "")}/agents/${encodeURIComponent(agentId)}`;
}

export interface PrimeAgentInfo {
	id: string;
	label: string;
	ok: boolean;
}

/** Agents the relay can drive (main-pi + worker prime sidecars), with a liveness flag each. */
export async function primeAgents(): Promise<PrimeAgentInfo[]> {
	const sync = ((await getSitegeistStorage().settings.get<string>(SYNC_URL_SETTING)) ?? DEFAULT_SYNC_URL).trim();
	const token = await proxyToken();
	const res = await fetch(`${sync.replace(/\/$/, "")}/agents`, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`prime relay GET /agents -> ${res.status}`);
	const body: unknown = await res.json();
	const list = isJson(body) && Array.isArray(body.agents) ? body.agents : [];
	return list.filter(
		(a): a is PrimeAgentInfo =>
			isJson(a) && typeof a.id === "string" && typeof a.label === "string" && typeof a.ok === "boolean",
	);
}

async function request(
	agentId: string,
	method: "GET" | "POST" | "DELETE" | "PATCH",
	path: string,
	body?: Json,
	timeoutMs = TIMEOUT_MS,
): Promise<Json> {
	const base = await primeBaseUrl(agentId);
	const headers: Record<string, string> = {};
	const token = await proxyToken();
	if (token) headers.authorization = `Bearer ${token}`;
	if (body) headers["content-type"] = "application/json";
	const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
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

export async function primeHealth(agentId: string): Promise<PrimeHealth> {
	const r = await request(agentId, "GET", "/health");
	return {
		ok: r.ok === true,
		bridge: isJson(r.bridge) ? (r.bridge as PrimeHealth["bridge"]) : undefined,
		connectedBrowsers: Array.isArray(r.connectedBrowsers)
			? r.connectedBrowsers.filter((s): s is string => typeof s === "string")
			: [],
	};
}

export async function primeCreateSession(agentId: string, name: string): Promise<{ sessionId: string; state: Json }> {
	const r = await request(agentId, "POST", "/sessions", { name });
	if (typeof r.sessionId !== "string") throw new Error("prime relay: session create returned no id");
	return { sessionId: r.sessionId, state: isJson(r.state) ? r.state : {} };
}

/** A message waiting in the relay's queue for the session to be idle (Queue / Alt+Enter). */
export interface PrimeQueuedItem {
	id: string;
	text: string;
	at: string;
	error?: string;
}

function queuedItems(v: unknown): PrimeQueuedItem[] {
	if (!Array.isArray(v)) return [];
	return v.flatMap((e: unknown): PrimeQueuedItem[] => {
		if (!isJson(e) || typeof e.id !== "string" || typeof e.text !== "string") return [];
		return [
			{
				id: e.id,
				text: e.text,
				at: typeof e.at === "string" ? e.at : "",
				...(typeof e.error === "string" && e.error ? { error: e.error } : {}),
			},
		];
	});
}

export interface PrimeHydration {
	offset: number;
	state: Json;
	messages: Json[];
	/** Messages waiting in the relay's queue, in order. */
	queue: PrimeQueuedItem[];
}

/**
 * The chat list every browser shares (chat-list.ts): send what changed here, get what changed elsewhere.
 * Not per agent: one list for all R730 chats.
 */
export async function primeChatsSync(body: Json): Promise<{ storeId: string; rev: number; chats: RemoteChat[] }> {
	const sync = ((await getSitegeistStorage().settings.get<string>(SYNC_URL_SETTING)) ?? DEFAULT_SYNC_URL).trim();
	const token = await proxyToken();
	const res = await fetch(`${sync.replace(/\/$/, "")}/chats/sync`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`prime relay POST /chats/sync -> ${res.status}`);
	const parsed: unknown = await res.json();
	if (!isJson(parsed) || typeof parsed.storeId !== "string" || typeof parsed.rev !== "number")
		throw new Error("prime relay POST /chats/sync: unexpected answer");
	const chats = Array.isArray(parsed.chats) ? parsed.chats : [];
	return {
		storeId: parsed.storeId,
		rev: parsed.rev,
		chats: chats.flatMap((c: unknown): RemoteChat[] => {
			const chat = remoteChatOf(c);
			return chat ? [chat] : [];
		}),
	};
}

/** Send chats' search text to the R730 (chat-text.ts). Answer: which were kept, and which it has a later form of. */
export async function primeChatTextPush(
	texts: Array<{ id: string; agentId: string; textAt: string; text: string }>,
): Promise<{ kept: string[]; stale: Array<{ id: string; textAt: string }> }> {
	const sync = ((await getSitegeistStorage().settings.get<string>(SYNC_URL_SETTING)) ?? DEFAULT_SYNC_URL).trim();
	const token = await proxyToken();
	const res = await fetch(`${sync.replace(/\/$/, "")}/chats/text`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify({ texts }),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) throw new Error(`prime relay POST /chats/text -> ${res.status}`);
	const parsed: unknown = await res.json();
	if (!isJson(parsed)) throw new Error("prime relay POST /chats/text: unexpected answer");
	const kept = Array.isArray(parsed.kept) ? parsed.kept.filter((v): v is string => typeof v === "string") : [];
	const stale = Array.isArray(parsed.stale)
		? parsed.stale.flatMap((s: unknown) =>
				isJson(s) && typeof s.id === "string" && typeof s.textAt === "string"
					? [{ id: s.id, textAt: s.textAt }]
					: [],
			)
		: [];
	return { kept, stale };
}

/** The R730's search text of these chats (chat-text.ts). `more`: not all fitted in one answer. */
export async function primeChatTextPull(ids: string[]): Promise<{ texts: RemoteText[]; more: boolean }> {
	const sync = ((await getSitegeistStorage().settings.get<string>(SYNC_URL_SETTING)) ?? DEFAULT_SYNC_URL).trim();
	const token = await proxyToken();
	const res = await fetch(`${sync.replace(/\/$/, "")}/chats/text?ids=${encodeURIComponent(ids.join(","))}`, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) throw new Error(`prime relay GET /chats/text -> ${res.status}`);
	const parsed: unknown = await res.json();
	if (!isJson(parsed)) throw new Error("prime relay GET /chats/text: unexpected answer");
	const texts = Array.isArray(parsed.texts)
		? parsed.texts.flatMap((t: unknown): RemoteText[] => {
				const text = remoteTextOf(t);
				return text ? [text] : [];
			})
		: [];
	return { texts, more: parsed.more === true };
}

/** One picture of a chat's history, by its link. `edge`: a copy no larger than that; without it, the stored file. */
export async function primeImage(ref: ImageRef, edge?: number): Promise<Blob> {
	const sync = ((await getSitegeistStorage().settings.get<string>(SYNC_URL_SETTING)) ?? DEFAULT_SYNC_URL).trim();
	const token = await proxyToken();
	const res = await fetch(imageUrl(sync, ref, edge), {
		headers: token ? { authorization: `Bearer ${token}` } : {},
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) throw new Error(`prime relay: picture ${ref.hash.slice(0, 8)} -> ${res.status}`);
	return res.blob();
}

export async function primeHydrate(agentId: string, sessionId: string): Promise<PrimeHydration> {
	// images=refs: pictures come as links (image-refs.ts), so the history is text. A relay that does not know the
	// option sends them inline, and they are drawn from there.
	const r = await request(agentId, "GET", `/sessions/${encodeURIComponent(sessionId)}?images=refs`);
	if (r.ok !== true) throw new Error("prime relay: session is not available (bridge could not start it)");
	return {
		offset: typeof r.offset === "number" ? r.offset : 0,
		state: isJson(r.state) ? r.state : {},
		messages: Array.isArray(r.messages) ? r.messages.filter(isJson) : [],
		queue: queuedItems(r.queue),
	};
}

/**
 * Queue a message (Queue / Alt+Enter): the relay keeps it, in front of prime, and sends it as a plain prompt as soon
 * as the session is idle - so it can still be edited or cancelled while it waits, and runs even if the panel is
 * closed by then. The same id again is not a second message.
 */
export async function primeQueue(
	agentId: string,
	sessionId: string,
	clientMessageId: string,
	text: string,
	message: string,
	images?: Json[],
): Promise<Json> {
	const body: Json = { clientMessageId, text, message };
	if (images && images.length > 0) body.images = images;
	return request(agentId, "POST", `/sessions/${encodeURIComponent(sessionId)}/queue`, body, PROMPT_TIMEOUT_MS);
}

/** Take a waiting message out of the relay's queue. `found: false` when it already went in (or was never there). */
export async function primeDequeue(
	agentId: string,
	sessionId: string,
	itemId: string,
): Promise<{ found: boolean; started: boolean }> {
	const r = await request(
		agentId,
		"DELETE",
		`/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`,
		undefined,
		15_000,
	);
	return { found: r.found === true, started: r.started === true };
}

/** How long one prompt POST may take. The relay itself waits at most 30 s for the bridge; a retry is safe (clientMessageId). */
const PROMPT_TIMEOUT_MS = 45_000;

export async function primePrompt(
	agentId: string,
	sessionId: string,
	message: string,
	images?: Json[],
	streamingBehavior?: "steer" | "followUp",
	clientMessageId?: string,
): Promise<Json> {
	const body: Json = { message };
	if (images && images.length > 0) body.images = images;
	if (streamingBehavior) body.streamingBehavior = streamingBehavior;
	// The relay prompts the bridge once per clientMessageId; a repeat gets duplicate:true back (2026-10-18).
	if (clientMessageId) body.clientMessageId = clientMessageId;
	return request(agentId, "POST", `/sessions/${encodeURIComponent(sessionId)}/prompt`, body, PROMPT_TIMEOUT_MS);
}

export interface PrimeStoredFile {
	path: string;
	bytes: number;
	filename: string;
	mime: string;
}

/**
 * Side-panel attachment -> file on the agent's host (relay /files -> bridge /files, the rail the Telegram
 * router uses for photos/documents). Returns where the bytes landed so the prompt can name the path.
 */
export async function primeUploadFile(
	agentId: string,
	sessionId: string,
	file: { filename: string; mime: string; dataBase64: string; turnId?: string },
): Promise<PrimeStoredFile> {
	const r = await request(agentId, "POST", `/sessions/${encodeURIComponent(sessionId)}/files`, file);
	if (r.ok !== true || typeof r.path !== "string") {
		throw new Error(typeof r.error === "string" ? r.error : "prime relay: file upload returned no path");
	}
	return {
		path: r.path,
		bytes: typeof r.bytes === "number" ? r.bytes : 0,
		filename: typeof r.filename === "string" ? r.filename : file.filename,
		mime: typeof r.mime === "string" ? r.mime : file.mime,
	};
}

/**
 * Is this chat on the agent's host, and what is it called there? The relay reads the log size only, so asking never
 * starts (or creates) a session: a mistyped id is just "not there".
 */
export async function primeSessionExists(
	agentId: string,
	sessionId: string,
): Promise<{ exists: boolean; name: string }> {
	const r = await request(agentId, "GET", `/sessions/${encodeURIComponent(sessionId)}/exists`, undefined, 10_000);
	return { exists: r.exists === true, name: typeof r.name === "string" ? r.name : "" };
}

/**
 * sg-… panel session id → the harness's own session UUIDs on the R730 (what session-finder and Telegram's
 * /session_resume show). Main-pi only; worker agents answer with an empty map.
 */
export async function primeNativeIds(agentId: string): Promise<Map<string, string[]>> {
	const r = await request(agentId, "GET", "/native-ids", undefined, 5_000);
	const out = new Map<string, string[]>();
	if (!isJson(r.ids)) return out;
	for (const [sg, list] of Object.entries(r.ids)) {
		if (Array.isArray(list))
			out.set(
				sg,
				list.filter((v): v is string => typeof v === "string"),
			);
	}
	return out;
}

export interface PrimeStoredArtifact {
	id: string;
	filename: string;
	mime: string;
	bytes: number;
	caption: string;
	deliveredAt: string;
}

const isStoredArtifact = (v: unknown): v is PrimeStoredArtifact =>
	isJson(v) &&
	typeof v.id === "string" &&
	typeof v.filename === "string" &&
	typeof v.mime === "string" &&
	typeof v.bytes === "number" &&
	typeof v.caption === "string" &&
	typeof v.deliveredAt === "string";

/** R730 copies of the files the agent sent to this session's artifacts panel (kept by the relay on delivery). */
export async function primeListArtifacts(agentId: string, sessionId: string): Promise<PrimeStoredArtifact[]> {
	const r = await request(agentId, "GET", `/sessions/${encodeURIComponent(sessionId)}/artifacts`, undefined, 10_000);
	return Array.isArray(r.artifacts) ? r.artifacts.filter(isStoredArtifact) : [];
}

/** The bytes of one stored artifact, base64 (what the artifacts panel stores for binaries). */
export async function primeFetchArtifact(agentId: string, sessionId: string, artifactId: string): Promise<string> {
	const base = await primeBaseUrl(agentId);
	const headers: Record<string, string> = {};
	const token = await proxyToken();
	if (token) headers.authorization = `Bearer ${token}`;
	const res = await fetch(
		`${base}/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
		{
			headers,
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!res.ok) throw new Error(`prime relay GET artifact ${artifactId} -> ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

export async function primeDeleteArtifacts(agentId: string, sessionId: string): Promise<void> {
	const base = await primeBaseUrl(agentId);
	const headers: Record<string, string> = {};
	const token = await proxyToken();
	if (token) headers.authorization = `Bearer ${token}`;
	await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
		method: "DELETE",
		headers,
		signal: AbortSignal.timeout(10_000),
	});
}

export async function primeRpc(agentId: string, sessionId: string, command: Json): Promise<Json> {
	const r = await request(agentId, "POST", `/sessions/${encodeURIComponent(sessionId)}/rpc`, command);
	const response = isJson(r.response) ? r.response : undefined;
	if (response && response.success === false) {
		throw new Error(typeof response.error === "string" ? response.error : `rpc ${String(command.type)} failed`);
	}
	return response && isJson(response.data) ? response.data : {};
}

/**
 * The agent's model menu: the list Telegram /models shows for this agent (Tom, 2026-11-09: "make them use the same
 * source"). The relay asks the Telegram router for it, so the panel filters nothing itself. Needs no session.
 */
export async function primeModels(agentId: string): Promise<unknown[]> {
	const r = await request(agentId, "GET", "/models", undefined, 60_000);
	return Array.isArray(r.models) ? r.models : [];
}

export async function primeStop(agentId: string, sessionId: string): Promise<void> {
	await request(agentId, "POST", `/sessions/${encodeURIComponent(sessionId)}/stop`, {});
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
	/** detail: plain words for the status light's tooltip (why it closed, when it retries). */
	onStatus: (status: "connecting" | "open" | "closed", detail?: string) => void;
}

const PING_EVERY_MS = 20_000;
/** Two pings without a pong: the connection is dead even if the browser has not noticed (a train tunnel). */
const PONG_OVERDUE_MS = 45_000;

/**
 * One WebSocket per session; reconnects with backoff, resumes from the last seen log offset. Not polling: the
 * relay pushes events. The panel pings every 20 s and expects a pong; a connection that stops answering is closed
 * and reopened, so the status light follows reality within ~45 s instead of waiting for the browser's own TCP
 * timeout. The browser's online/offline events shortcut the backoff (2026-10-18, Tom on a train).
 */
export class PrimeSocket {
	private ws: WebSocket | undefined;
	private closed = false;
	private attempt = 0;
	private lastPong = 0;
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly onOnline = (): void => {
		// Back online: do not sit out the rest of a 30 s backoff.
		if (this.closed || this.ws) return;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.attempt = 0;
		void this.connect();
	};
	private readonly onOffline = (): void => {
		// The browser says the network is gone: show it now; the backoff then waits for "online".
		if (this.ws) this.drop(this.ws, "browser offline");
	};

	constructor(
		private readonly agentId: string,
		private readonly sessionId: string,
		private offset: number,
		private readonly handlers: PrimeSocketHandlers,
	) {
		window.addEventListener("online", this.onOnline);
		window.addEventListener("offline", this.onOffline);
	}

	async connect(): Promise<void> {
		if (this.closed || this.ws) return;
		const base = await primeBaseUrl(this.agentId);
		// Browsers cannot set headers on a WebSocket handshake, so the token travels as a query parameter.
		const token = await proxyToken();
		// images=refs: pictures in the events come as links, like the history (image-refs.ts). The bridge's events carry
		// a tool result's picture five times per turn; inline, one screenshot was about 1 MB down the tunnel.
		const url = `${base.replace(/^http/, "ws")}/sessions/${encodeURIComponent(this.sessionId)}/ws?offset=${this.offset}&images=refs${token ? `&token=${encodeURIComponent(token)}` : ""}`;
		this.handlers.onStatus("connecting", this.attempt > 0 ? `attempt ${this.attempt + 1}` : undefined);
		const ws = new WebSocket(url);
		this.ws = ws;
		ws.onopen = () => {
			this.attempt = 0;
			this.lastPong = Date.now();
			this.handlers.onStatus("open");
			this.pingTimer = setInterval(() => {
				if (Date.now() - this.lastPong > PONG_OVERDUE_MS)
					this.drop(ws, `no answer to pings for ${Math.round(PONG_OVERDUE_MS / 1000)} s`);
				else this.send({ type: "ping" });
			}, PING_EVERY_MS);
		};
		ws.onmessage = (ev) => this.handleMessage(ev.data);
		ws.onerror = () => {
			/* onclose follows; nothing to do here */
		};
		ws.onclose = (ev) =>
			this.drop(ws, ev.reason ? ev.reason : ev.code === 1006 ? "connection lost" : `closed (${ev.code})`);
	}

	/**
	 * Give up on `ws` now and schedule the next attempt. Also used before the browser reports the close: a dead
	 * socket's own onclose can take Chrome a minute to arrive, and the light should not lie that long.
	 */
	private drop(ws: WebSocket, why: string): void {
		if (this.ws !== ws) return;
		this.ws = undefined;
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = undefined;
		ws.onopen = null;
		ws.onmessage = null;
		ws.onclose = null;
		ws.onerror = null;
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
		if (this.closed) {
			this.handlers.onStatus("closed", why);
			return;
		}
		const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt++, 5));
		this.handlers.onStatus("closed", `${why}; retrying in ${Math.round(delay / 1000)} s (attempt ${this.attempt})`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect();
		}, delay);
	}

	/** Reconnect now (after a failed send): skips the rest of the backoff. */
	reconnectNow(): void {
		this.onOnline();
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
		if (msg.type === "pong") {
			this.lastPong = Date.now();
			return;
		}
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
		window.removeEventListener("online", this.onOnline);
		window.removeEventListener("offline", this.onOffline);
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.ws?.close();
		this.ws = undefined;
	}
}
