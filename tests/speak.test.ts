/**
 * Read aloud, pure parts: Markdown chunking, voice choice, and the speak client against a stand-in speak server
 * (OK audio, OpenAI-style errors, nothing listening). npm run test:speak
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { CHUNK_TARGETS, chunkMarkdown, HARD_CAP, splitBlocks } from "../src/speak/chunk.ts";
import { messageKey } from "../src/speak/message-key.ts";
import { errorNote, fetchHealth, fetchVoices, pickVoice, SpeakError, synthesize } from "../src/speak/speak-client.ts";

const para = (n: number, word = "word") => `${Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ")}.`;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

test("blocks: code, tables and lists stay whole across blank lines", () => {
	const md = [
		"# Title",
		"",
		"Intro paragraph one. Still intro.",
		"",
		"```ts",
		"const a = 1;",
		"",
		"const b = 2;",
		"```",
		"",
		"| A | B |",
		"| --- | --- |",
		"| 1 | 2 |",
		"",
		"- item one",
		"  continued",
		"",
		"- item two",
		"  - nested",
		"",
		"Closing paragraph.",
	].join("\n");
	const blocks = splitBlocks(md);
	assert.deepEqual(
		blocks.map((b) => b.kind),
		["heading", "paragraph", "code", "table", "list", "paragraph"],
	);
	assert.ok(blocks[2]?.text.includes("const b = 2;"), "code block keeps its inner blank line");
	assert.equal(blocks[4]?.text, "- item one\n  continued\n\n- item two\n  - nested");
});

test("chunks: targets ramp 250 -> 500 -> 800, packed at block boundaries, nothing lost", () => {
	const blocks = Array.from({ length: 16 }, (_, i) => para(24, `p${i}w`)); // ~130 characters each
	const md = blocks.join("\n\n");
	const chunks = chunkMarkdown(md);
	assert.ok(chunks.length >= 4);
	chunks.forEach((c, i) => {
		const target = CHUNK_TARGETS[Math.min(i, CHUNK_TARGETS.length - 1)] ?? 800;
		assert.ok(c.length <= target, `chunk ${i} is ${c.length} > ${target}`);
		for (const b of c.split("\n\n")) assert.ok(blocks.includes(b), "every chunk is whole blocks");
	});
	assert.ok((chunks[0]?.length ?? 0) <= 250 && (chunks[2]?.length ?? 0) > 500, "ramp");
	assert.equal(norm(chunks.join(" ")), norm(blocks.join(" ")));
});

test("chunks: a long first paragraph is cut after whole sentences; tables and lists are never cut", () => {
	const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} says something useful here.`);
	const table = [
		"| Name | Value |",
		"| --- | --- |",
		...Array.from({ length: 40 }, (_, i) => `| row ${i} | ${i * 7} |`),
	].join("\n");
	const list = Array.from({ length: 30 }, (_, i) => `- point ${i} with a few words`).join("\n");
	const chunks = chunkMarkdown(`${sentences.join(" ")}\n\n${table}\n\n${list}`);
	assert.ok(chunks[0] && chunks[0].length <= 250 && chunks[0].endsWith("."), `first chunk: ${chunks[0]?.length}`);
	assert.ok(
		sentences.some((s) => chunks[0]?.endsWith(s)),
		"cut at a sentence end",
	);
	assert.equal(chunks.filter((c) => c.includes("| Name | Value |")).length, 1);
	assert.ok(
		chunks.some((c) => c.includes(table)),
		"the table is in one chunk",
	);
	assert.ok(
		chunks.some((c) => c.includes(list)),
		"the list is in one chunk",
	);
	assert.equal(norm(chunks.join(" ")), norm(`${sentences.join(" ")} ${table} ${list}`));
});

test("chunks: a block above the hard cap is cut under it; empty input -> none", () => {
	const huge = Array.from({ length: 400 }, (_, i) => `| r${i} | some cell text here |`).join("\n");
	const chunks = chunkMarkdown(huge);
	assert.ok(chunks.length >= 3 && chunks.every((c) => c.length <= HARD_CAP));
	assert.deepEqual(chunkMarkdown("  \n\n "), []);
});

test("voice: the agent's own voice when speak has it, else main-pi", () => {
	assert.equal(pickVoice("prime", ["main-pi", "random"]), "main-pi");
	assert.equal(pickVoice("jennifer", ["main-pi", "random"]), "main-pi");
	assert.equal(pickVoice("jennifer", ["main-pi", "jennifer"]), "jennifer");
	assert.equal(pickVoice(null, []), "main-pi");
	assert.equal(messageKey("hello"), messageKey("hello"));
	assert.notEqual(messageKey("hello"), messageKey("hellp"));
});

async function standInSpeak(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
	const bodies: string[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c: Buffer) => {
			body += c.toString();
		});
		req.on("end", () => {
			bodies.push(body);
			handler(req, res, body);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo; // listen() on a TCP port: address() is an AddressInfo
	return { url: `http://127.0.0.1:${port}`, bodies, close: () => server.close() };
}

test("client: audio, voices, health, and the error kinds (503 offline, 413, 422, nothing listening)", async () => {
	let mode = "ok";
	const srv = await standInSpeak((req, res, body) => {
		if (req.url === "/v1/voices") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					voices: [
						{ name: "main-pi", locked: true },
						{ name: "random", locked: false },
					],
					attribution: "Built with Fish Audio",
				}),
			);
		} else if (req.url === "/health") {
			res.writeHead(mode === "ok" ? 200 : 503, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: mode === "ok" }));
		} else if (mode === "ok") {
			const parsed: unknown = JSON.parse(body);
			assert.deepEqual(parsed, {
				input: "Hello **there**.",
				voice: "main-pi",
				prepare: true,
				response_format: "mp3",
			});
			res.writeHead(200, { "content-type": "audio/mpeg" });
			res.end(Buffer.from([0xff, 0xfb, 0x90, 0x44]));
		} else {
			const status = Number(mode);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "nope", type: `t${status}` } }));
		}
	});
	try {
		assert.deepEqual(await fetchVoices(srv.url), ["main-pi", "random"]);
		assert.equal(await fetchHealth(srv.url), true);
		const blob = await synthesize(`${srv.url}/`, "Hello **there**.", "main-pi");
		assert.equal(blob.type, "audio/mpeg");
		assert.equal(blob.size, 4);
		for (const [status, kind, note] of [
			["503", "offline", "speak is offline (M4 asleep?)"],
			["413", "too-long", "too long for speak"],
			["422", "empty", "nothing to read aloud"],
			["502", "error", "speak error 502"],
		] as const) {
			mode = status;
			const err = await synthesize(srv.url, "x", "main-pi").then(
				() => undefined,
				(e: unknown) => e,
			);
			assert.ok(err instanceof SpeakError, `${status} -> SpeakError`);
			assert.equal(err.kind, kind);
			assert.equal(errorNote(err), note);
		}
		assert.equal(await fetchHealth(srv.url), false);
	} finally {
		srv.close();
	}
	const dead = await synthesize("http://127.0.0.1:9", "x", "main-pi").then(
		() => undefined,
		(e: unknown) => e,
	);
	assert.ok(dead instanceof SpeakError && dead.kind === "offline" && dead.status === 0, "nothing listening = offline");
});
