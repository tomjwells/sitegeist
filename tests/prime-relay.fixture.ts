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
	/** Prompts the panel sent to the session. */
	prompts: unknown[];
	/** Open panel sockets for the session; tool calls go to the newest. */
	openSockets(): number;
	/** A browser_* tool call from the R730; resolves with the panel's result, throws on a failed call. */
	call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
	close(): void;
}

export async function startStandInRelay(sessionId: string, messages: unknown[]): Promise<StandInRelay> {
	const sockets: MiniSocket[] = [];
	const pending = new Map<string, (reply: { ok: boolean; result: unknown; error: string }) => void>();
	const prompts: unknown[] = [];
	const prime = "/sitegeist/agents/prime";
	const session = `${prime}/sessions/${sessionId}`;
	const server = createServer(async (req, res) => {
		const url = req.url ?? "";
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
					offset: 0,
					state: { thinkingLevel: "high", isStreaming: false },
					messages,
				}),
			);
		} else if (url === `${session}/artifacts`) {
			res.end(JSON.stringify({ ok: true, artifacts: [] }));
		} else if (url === `${session}/prompt`) {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			prompts.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
			res.end(JSON.stringify({ ok: true }));
		} else if (url.startsWith(`${session}/rpc`)) {
			res.end(JSON.stringify({ ok: true, response: { success: true, data: {} } }));
		} else {
			res.statusCode = 404;
			res.end(JSON.stringify({ error: "not found" }));
		}
	});
	server.on("upgrade", (req, raw) => {
		if (!(req.url ?? "").startsWith(`${session}/ws`)) {
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
		openSockets: () => sockets.length,
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
