/**
 * A stand-in for the R730 relay plus a few pages to read, for the "sitegeist next to the page" tests (Chrome and Zen):
 * serves one prime session (hydrate, rpc, prompt, artifacts), accepts the panel's socket and sends browser_* tool calls
 * over it the way the relay does, and serves /article (red), /other (blue) and /next (green).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { acceptWebSocket, type MiniSocket } from "./ws-mini.fixture.ts";

const PAGES: Record<string, string> = { "/article": "#cc0000", "/other": "#0000cc", "/next": "#00aa00" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface StandInRelay {
	/** http://127.0.0.1:<port>; the relay lives at <base>/sitegeist (the panel's sync.url). */
	base: string;
	/** Prompts the session accepted (first time per clientMessageId), in order. */
	prompts: Array<Record<string, unknown>>;
	/** Prompt POSTs that repeated an accepted clientMessageId (answered duplicate:true, like the real relay). */
	repeats: number;
	/** The train tunnel: every request and socket is cut at the TCP level. */
	offline: boolean;
	/** The prompt lands but its answer is lost (a 504 after the relay recorded it); no echo until flushEchoes(). */
	swallowPrompt: boolean;
	/** Sessions the panel created (POST /sessions). */
	created(): number;
	/** Open panel sockets for the session; tool calls go to the newest. */
	openSockets(): number;
	/** Close every panel socket (the connection died). */
	dropSockets(): void;
	/** Send the bridge's echo of accepted prompts that were held back (swallowPrompt) over the open sockets. */
	flushEchoes(): void;
	/** A browser_* tool call from the R730; resolves with the panel's result, throws on a failed call. */
	call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
	close(): void;
}

export async function startStandInRelay(sessionId: string, messages: unknown[]): Promise<StandInRelay> {
	const sockets: MiniSocket[] = [];
	const pending = new Map<string, (reply: { ok: boolean; result: unknown; error: string }) => void>();
	const prompts: Array<Record<string, unknown>> = [];
	const accepted = new Map<string, string>(); // clientMessageId -> acceptedAt
	const heldEchoes: Array<Record<string, unknown>> = [];
	const history: unknown[] = [...messages]; // what hydrate returns; accepted prompts are appended like the bridge log
	let offset = 0;
	let created = 0;
	const prime = "/sitegeist/agents/prime";
	const session = `${prime}/sessions/${sessionId}`;
	const relayState = { offline: false, swallowPrompt: false, repeats: 0 };
	/** What the bridge logs for an accepted prompt: the user message echoed, then an idle turn. */
	const echo = (text: string): void => {
		const events = [
			{ type: "agent_start" },
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } },
			{ type: "agent_end", messages: [] },
		];
		offset += events.length;
		for (const ws of sockets) ws.send(JSON.stringify({ type: "events", events, offset }));
	};
	const server = createServer(async (req, res) => {
		const url = req.url ?? "";
		if (relayState.offline && url.startsWith("/sitegeist/")) {
			req.socket.destroy();
			return;
		}
		const color = PAGES[url];
		if (color !== undefined) {
			const name = url.slice(1);
			res.setHeader("content-type", "text/html");
			res.end(
				`<!doctype html><title>${name.charAt(0).toUpperCase()}${name.slice(1)}</title><body style="margin:0;height:100vh;background:${color}"><h1>${name.toUpperCase()}</h1></body>`,
			);
			return;
		}
		res.setHeader("content-type", "application/json");
		res.setHeader("access-control-allow-origin", "*");
		if (url === "/sitegeist/agents") {
			res.end(JSON.stringify({ agents: [{ id: "prime", label: "main-pi (prime-agent)", ok: true }] }));
		} else if (url.startsWith(`${prime}/native-ids`)) {
			res.end(JSON.stringify({ ok: true, agent: "prime", ids: {} }));
		} else if (url === session && req.method === "GET") {
			res.end(
				JSON.stringify({
					ok: true,
					sessionId,
					offset,
					state: { thinkingLevel: "high", isStreaming: false },
					messages: history,
				}),
			);
		} else if (url === `${session}/exists` && req.method === "GET") {
			// The real relay asks the bridge for the log size only; a chat with history exists, named after its first message.
			const first = history.find((m) => isRecord(m) && m.role === "user");
			const firstText = isRecord(first) && typeof first.content === "string" ? first.content : "";
			const exists = history.length > 0 || prompts.length > 0;
			res.end(JSON.stringify({ ok: true, sessionId, exists, name: exists ? `sitegeist / ${firstText}` : "" }));
		} else if (/^\/sitegeist\/agents\/prime\/sessions\/[^/]+\/exists$/.test(url) && req.method === "GET") {
			res.end(JSON.stringify({ ok: true, exists: false, name: "" })); // any other id: not on the R730
		} else if (url === `${prime}/sessions` && req.method === "POST") {
			// A new chat: the stand-in has one session, so a new chat is that one (start the relay with no history).
			created++;
			res.end(
				JSON.stringify({ ok: true, sessionId, name: `sitegeist / ${sessionId}`, state: { thinkingLevel: "high" } }),
			);
		} else if (url === `${session}/artifacts`) {
			res.end(JSON.stringify({ ok: true, artifacts: [] }));
		} else if (url === `${session}/prompt`) {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
			const id = typeof body.clientMessageId === "string" ? body.clientMessageId : undefined;
			const seen = id ? accepted.get(id) : undefined;
			if (seen) {
				// The real relay: the first accepted prompt per clientMessageId wins, a repeat never reaches the bridge.
				relayState.repeats++;
				res.end(JSON.stringify({ ok: true, duplicate: true, acceptedAt: seen }));
				return;
			}
			const text = typeof body.message === "string" ? body.message : "";
			if (id) accepted.set(id, new Date().toISOString());
			prompts.push(body);
			history.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
			if (relayState.swallowPrompt) {
				// Accepted, but the answer never gets back to the panel. (Cutting the socket here is not enough: Chrome
				// retries a POST whose reused connection died before any response byte, and the retry is then a repeat.)
				heldEchoes.push({ text });
				res.statusCode = 504;
				res.end(JSON.stringify({ error: "the bridge's answer was lost" }));
				return;
			}
			res.end(JSON.stringify({ ok: true, id: `bridge-${prompts.length}` }));
			echo(text);
		} else if (url.startsWith(`${session}/rpc`)) {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			const data =
				isRecord(parsed) && parsed.type === "get_state" ? { thinkingLevel: "high", isStreaming: false } : {};
			res.end(JSON.stringify({ ok: true, response: { success: true, data } }));
		} else {
			res.statusCode = 404;
			res.end(JSON.stringify({ error: "not found" }));
		}
	});
	server.on("upgrade", (req, raw) => {
		if (relayState.offline || !(req.url ?? "").startsWith(`${session}/ws`)) {
			raw.destroy();
			return;
		}
		const ws = acceptWebSocket(req, raw);
		sockets.push(ws);
		ws.onClose(() => {
			const i = sockets.indexOf(ws);
			if (i >= 0) sockets.splice(i, 1);
		});
		ws.onMessage((text) => {
			const msg: unknown = JSON.parse(text);
			if (isRecord(msg) && msg.type === "ping") {
				ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
				return;
			}
			if (!isRecord(msg) || msg.type !== "browser_result" || typeof msg.id !== "string") return;
			pending.get(msg.id)?.({
				ok: msg.ok === true,
				result: msg.result,
				error: typeof msg.error === "string" ? msg.error : "",
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // listen(0) on TCP: an AddressInfo
	let calls = 0;
	return {
		base,
		prompts,
		get repeats() {
			return relayState.repeats;
		},
		get offline() {
			return relayState.offline;
		},
		set offline(v: boolean) {
			relayState.offline = v;
		},
		get swallowPrompt() {
			return relayState.swallowPrompt;
		},
		set swallowPrompt(v: boolean) {
			relayState.swallowPrompt = v;
		},
		created: () => created,
		openSockets: () => sockets.length,
		dropSockets: () => {
			for (const ws of [...sockets]) ws.close();
		},
		flushEchoes: () => {
			for (const held of heldEchoes.splice(0)) echo(String(held.text));
		},
		async call(tool, args = {}) {
			const ws = sockets[sockets.length - 1];
			if (!ws) throw new Error("the panel has no relay socket");
			const id = `call-${++calls}`;
			const reply = await new Promise<{ ok: boolean; result: unknown; error: string }>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`${tool} timed out`)), 45_000);
				pending.set(id, (r) => {
					clearTimeout(timer);
					resolve(r);
				});
				ws.send(JSON.stringify({ type: "browser_call", id, tool, args }));
			});
			pending.delete(id);
			if (!reply.ok) throw new Error(`${tool} failed: ${reply.error}`);
			return reply.result;
		},
		close: () => {
			for (const ws of [...sockets]) ws.close();
			server.close();
		},
	};
}

/** The text blocks of a browser tool result. */
export function textOf(result: unknown): string {
	if (!isRecord(result) || !Array.isArray(result.content)) return "";
	return result.content
		.map((c: unknown) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
		.join("");
}

/** The base64 PNG of a browser_screenshot result. */
export function imageOf(result: unknown): string | undefined {
	if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
	const image = result.content.find((c: unknown) => isRecord(c) && c.type === "image");
	return isRecord(image) && typeof image.data === "string" ? image.data : undefined;
}

/** A prime session as the panel stores it (IndexedDB sessions + sessions-metadata). */
export function seededPrimeSession(id: string, title: string) {
	const model = {
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const lastModified = "2026-10-12T20:00:00.000Z";
	const messages = [
		{ role: "user", content: "Help me read this article.", timestamp: Date.parse(lastModified) - 1000 },
		{
			role: "assistant",
			content: [{ type: "text", text: "Sure: ask away." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: Date.parse(lastModified),
		},
	];
	return {
		messages,
		data: { id, title, model, thinkingLevel: "high", messages, createdAt: lastModified, lastModified },
		metadata: {
			id,
			title,
			createdAt: lastModified,
			lastModified,
			messageCount: messages.length,
			usage,
			modelId: model.id,
			thinkingLevel: "high",
			preview: title,
		},
	};
}
