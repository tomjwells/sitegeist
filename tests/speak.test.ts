/**
 * Read aloud, pure parts: Markdown chunking, voice choice, and the speak client against a stand-in speak server
 * (OK audio, OpenAI-style errors, nothing listening). npm run test:speak
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
	CHUNK_TARGETS,
	chunkMarkdown,
	ESTIMATED_CHARS_PER_SECOND,
	HARD_CAP,
	RENDER_CHARS_PER_SECOND,
	RENDER_OVERHEAD_SECONDS,
	splitBlocks,
	targetsForRate,
} from "../src/speak/chunk.ts";
import { messageKey } from "../src/speak/message-key.ts";
import { errorNote, fetchHealth, fetchVoices, pickVoice, SpeakError, synthesize } from "../src/speak/speak-client.ts";
import { clock, DEFAULT_SPEAK_RATE, locateInParts, SPEAK_RATES, validRate } from "../src/speak/timeline.ts";

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

test("chunks: targets ramp 120 -> 250 -> 500 -> 800, packed at block boundaries, nothing lost", () => {
	const blocks = Array.from({ length: 16 }, (_, i) => para(24, `p${i}w`)); // ~130 characters each
	const md = blocks.join("\n\n");
	const chunks = chunkMarkdown(md);
	assert.ok(chunks.length >= 4);
	chunks.forEach((c, i) => {
		const target = CHUNK_TARGETS[Math.min(i, CHUNK_TARGETS.length - 1)] ?? 800;
		// a chunk may exceed its target only when it is a single block (blocks are never split here)
		assert.ok(c.length <= target || !c.includes("\n\n"), `chunk ${i} is ${c.length} > ${target}`);
		for (const b of c.split("\n\n")) assert.ok(blocks.includes(b), "every chunk is whole blocks");
	});
	assert.equal(chunks[0], blocks[0], "first chunk = the first block (one sentence, not cut)");
	assert.ok((chunks[1]?.length ?? 0) <= 250 && (chunks[3]?.length ?? 0) > 500, "ramp");
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
	assert.ok(
		chunks[0] && chunks[0].length >= 60 && chunks[0].length <= 120 && chunks[0].endsWith("."),
		`first chunk: ${chunks[0]?.length}`,
	);
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
			res.writeHead(200, { "content-type": "audio/mpeg", "x-speak-audio-seconds": "1.50" });
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
		const clip = await synthesize(`${srv.url}/`, "Hello **there**.", "main-pi");
		assert.equal(clip.blob.type, "audio/mpeg");
		assert.equal(clip.blob.size, 4);
		assert.equal(clip.seconds, 1.5, "length from speak's x-speak-audio-seconds header");
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

test("timeline: a position maps to a clip and an offset; empty clips are passed over; the end stays inside the last clip", () => {
	const d = [13, 0, 25, 65];
	assert.deepEqual(locateInParts(d, 0), { part: 0, offset: 0 });
	assert.deepEqual(locateInParts(d, 12.5), { part: 0, offset: 12.5 });
	assert.deepEqual(locateInParts(d, 13), { part: 2, offset: 0 }, "the clip with nothing to read is never the target");
	assert.deepEqual(locateInParts(d, 40), { part: 3, offset: 2 });
	assert.deepEqual(locateInParts(d, 103), { part: 3, offset: 64.75 });
	assert.deepEqual(locateInParts(d, 9999), { part: 3, offset: 64.75 });
	assert.deepEqual(locateInParts([5, 0], 99), { part: 0, offset: 4.75 }, "a trailing empty clip is not the target");
	assert.deepEqual(locateInParts([], 3), { part: 0, offset: 0 });
	assert.deepEqual(locateInParts([0, 0], 3), { part: 0, offset: 0 });
	assert.equal(clock(0), "0:00");
	assert.equal(clock(59.9), "0:59");
	assert.equal(clock(605), "10:05");
	assert.equal(clock(-3), "0:00");
	assert.equal(validRate(2), 2);
	assert.equal(validRate(3), DEFAULT_SPEAK_RATE);
	assert.equal(validRate("2"), DEFAULT_SPEAK_RATE);
	assert.equal(validRate(undefined), DEFAULT_SPEAK_RATE);
});

test("chunk ramp per speed: 1x keeps the measured ramp; up to 2x each chunk renders while the one before plays", () => {
	assert.deepEqual(targetsForRate(1), CHUNK_TARGETS);
	assert.deepEqual(targetsForRate(0.5), CHUNK_TARGETS);
	assert.deepEqual(targetsForRate(2.5), CHUNK_TARGETS, "above 2x nothing keeps up: fewer, longer waits");
	assert.deepEqual(targetsForRate(Number.NaN), CHUNK_TARGETS);
	const render = (chars: number) => RENDER_OVERHEAD_SECONDS + chars / RENDER_CHARS_PER_SECOND;
	for (const rate of SPEAK_RATES) {
		const t = targetsForRate(rate);
		assert.equal(t[0], 120, `${rate}x starts as quickly as 1x`);
		assert.equal(t.at(-1), 800, `${rate}x reaches the full chunk size`);
		assert.ok(t.length <= 25, `${rate}x ramp is finite and short (${t.length})`);
		for (let i = 1; i < t.length; i++) {
			const prev = t[i - 1] ?? 0;
			const cur = t[i] ?? 0;
			assert.ok(cur > prev, `${rate}x ramp grows (${t.join(",")})`);
			const wait = render(cur) - prev / (ESTIMATED_CHARS_PER_SECOND * rate);
			// 1.25x-1.75x: no wait at all (rounding aside). 2x: under a second, on the first small chunks only.
			if (rate > 1 && rate <= 1.75)
				assert.ok(wait <= 0.05, `${rate}x: chunk ${i} ready in time (${wait.toFixed(2)} s late)`);
			if (rate === 2) assert.ok(wait < 1, `2x: chunk ${i} at most 1 s late (${wait.toFixed(2)} s)`);
		}
	}
	assert.deepEqual(targetsForRate(1.75), [120, 135, 156, 186, 228, 287, 370, 486, 649, 800]);
	const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} of a long answer is here.`).join("\n\n");
	assert.ok(
		chunkMarkdown(text, targetsForRate(1.75)).length > chunkMarkdown(text).length,
		"gentler ramp = more chunks",
	);
	assert.equal(chunkMarkdown(text, targetsForRate(1.75)).join("\n\n"), text, "no text lost with another ramp");
});
