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
	FAST_CHUNK,
	HARD_CAP,
	MAX_CHUNK,
	RENDER_CHARS_PER_SECOND,
	RENDER_OVERHEAD_SECONDS,
	renderSeconds,
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

test("chunks: packed at block boundaries up to each target, never above MAX_CHUNK, nothing lost", () => {
	const blocks = Array.from({ length: 16 }, (_, i) => para(24, `p${i}w`)); // ~130 characters each
	const md = blocks.join("\n\n");
	const chunks = chunkMarkdown(md);
	assert.ok(chunks.length >= 4);
	chunks.forEach((c, i) => {
		const target = CHUNK_TARGETS[Math.min(i, CHUNK_TARGETS.length - 1)] ?? MAX_CHUNK;
		assert.ok(c.length <= Math.max(target * 1.25, 140), `chunk ${i} is ${c.length} > ${target}`);
		for (const b of c.split("\n\n")) assert.ok(blocks.includes(b), "short blocks are packed whole");
	});
	assert.equal(chunks[0], blocks[0], "first chunk = the first block (one sentence, not cut)");
	assert.equal(norm(chunks.join(" ")), norm(blocks.join(" ")));
});

test("chunks: long paragraphs, lists and tables are split (sentences, top-level items, rows with the header)", () => {
	const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} says something useful here.`);
	const table = [
		"| Name | Value |",
		"| --- | --- |",
		...Array.from({ length: 40 }, (_, i) => `| row ${i} | ${i * 7} |`),
	].join("\n");
	const items = Array.from(
		{ length: 30 },
		(_, i) =>
			`- point ${i} with a few words and a clause to make it longer.${i % 5 === 0 ? "\n  - nested detail" : ""}`,
	);
	const list = items.join("\n");
	const middle = Array.from({ length: 30 }, (_, i) => `Middle sentence ${i} goes on a while.`).join(" ");
	const md = `${sentences.join(" ")}\n\n${list}\n\n${middle}\n\n${table}`;
	assert.ok(list.length > 1800, `the list is long (${list.length})`);
	const chunks = chunkMarkdown(md, targetsForRate(1.75));
	assert.ok(
		chunks[0] && chunks[0].length >= 60 && chunks[0].length <= 120 && chunks[0].endsWith("."),
		`first chunk: ${chunks[0]?.length}`,
	);
	assert.ok(
		sentences.some((s) => chunks[0]?.endsWith(s)),
		"cut at a sentence end",
	);
	for (const c of chunks) assert.ok(c.length <= MAX_CHUNK * 1.25, `chunk of ${c.length} characters`);
	for (const item of items)
		assert.ok(
			chunks.some((c) => c.includes(item)),
			"a list item is never cut inside",
		);
	const tableChunks = chunks.filter((c) => c.includes("| row "));
	assert.ok(tableChunks.length >= 2, "the table is split");
	for (const c of tableChunks)
		assert.ok(c.startsWith("| Name | Value |\n| --- | --- |"), "every piece keeps the header");
	const unique = (s: string) => norm(s.replaceAll("| Name | Value |\n| --- | --- |", ""));
	assert.equal(unique(chunks.join(" ")), unique(md), "nothing lost or repeated except the header rows");
});

test("chunks: a code block stays whole; a block above the hard cap is cut under it; empty input -> none", () => {
	const code = ["```ts", ...Array.from({ length: 40 }, (_, i) => `const value${i} = compute(${i});`), "```"].join(
		"\n",
	);
	assert.ok(chunkMarkdown(`Intro.\n\n${code}\n\nEnd.`).some((c) => c.includes(code)));
	const huge = ["```", ...Array.from({ length: 400 }, (_, i) => `line ${i} with some code text`), "```"].join("\n");
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

/**
 * Simulated playback at the rates measured on 2026-11-14 (speak-engine.log): speak renders one chunk at a time at
 * 0.3 s + characters / 26, the panel keeps it busy from the first click (pump), and the audio is heard at
 * ESTIMATED_CHARS_PER_SECOND x the playback rate. Returns when the first sound starts and the longest silence after it.
 */
function simulate(chunks: string[], rate: number): { first: number; longestWait: number; waits: number[] } {
	let rendered = 0;
	let playEnd = -1;
	let first = 0;
	const waits: number[] = [];
	for (const [i, c] of chunks.entries()) {
		rendered += RENDER_OVERHEAD_SECONDS + c.length / RENDER_CHARS_PER_SECOND;
		const start = i === 0 ? rendered : Math.max(rendered, playEnd);
		if (i === 0) first = start;
		else waits.push(start - playEnd);
		playEnd = start + c.length / (ESTIMATED_CHARS_PER_SECOND * rate);
	}
	return { first, longestWait: Math.max(0, ...waits), waits };
}

test("chunk ramp per speed: starts at 120, grows only as fast as rendering keeps ahead", () => {
	assert.deepEqual(targetsForRate(1), CHUNK_TARGETS);
	assert.deepEqual(targetsForRate(Number.NaN), CHUNK_TARGETS);
	for (const rate of SPEAK_RATES) {
		const t = targetsForRate(rate);
		assert.equal(t[0], 120, `${rate}x starts as quickly as 1x`);
		assert.ok(t.length <= 41 && t.every((c) => c <= MAX_CHUNK), `${rate}x ramp is short and capped (${t.join(",")})`);
	}
	assert.equal(targetsForRate(1).at(-1), MAX_CHUNK);
	assert.equal(targetsForRate(1.75).at(-1), MAX_CHUNK);
	assert.deepEqual(targetsForRate(2.5), [120, FAST_CHUNK], "playback outruns rendering: even, short waits");
	assert.ok(renderSeconds(400) > 400 / RENDER_CHARS_PER_SECOND, "planning includes overhead and safety");
});

test("simulated playback of a long answer with an 1,800-character list: quick start, no long silences", () => {
	const intro = Array.from({ length: 6 }, (_, i) => `Opening sentence ${i} explains the finding in plain words.`);
	const list = Array.from(
		{ length: 24 },
		(_, i) => `- **Step ${i}**: do the thing for part ${i}, then check it worked before moving on.`,
	).join("\n");
	const paras = Array.from({ length: 6 }, (_, p) =>
		Array.from({ length: 8 }, (_, i) => `Paragraph ${p} sentence ${i} adds a bit more detail.`).join(" "),
	);
	const table = [
		"| Thing | Before | After |",
		"| --- | --- | --- |",
		...Array.from({ length: 20 }, (_, i) => `| item ${i} | ${i * 3} s | ${i} s |`),
	].join("\n");
	const md = [intro.join(" "), list, ...paras.slice(0, 3), table, ...paras.slice(3)].join("\n\n");
	assert.ok(list.length > 1800);
	for (const rate of SPEAK_RATES) {
		const sim = simulate(chunkMarkdown(md, targetsForRate(rate)), rate);
		assert.ok(sim.first <= 6, `${rate}x: first sound at ${sim.first.toFixed(1)} s`);
		const limit = rate <= 1.75 ? 1 : rate <= 2 ? 5 : 15;
		assert.ok(sim.longestWait <= limit, `${rate}x: longest silence ${sim.longestWait.toFixed(1)} s > ${limit} s`);
	}
	// The old chunking (whole list in one 1,800+ character chunk, next two chunks fetched when one starts) left
	// ~50 s of silence before the list at 1.75x; the comparison is in the commit message.
});
