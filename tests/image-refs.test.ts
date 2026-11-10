/**
 * Pictures by link (src/prime/image-refs.ts): which blocks count as a link, which URL is fetched, and that the
 * browser's stored copy keeps a link as it is. Run: npm run test:image-refs
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { boxFor, drawnImages, edgeFor, imageRefOf, imageUrl } from "../src/prime/image-refs.ts";
import { slimForStorage } from "../src/prime/stored-messages.ts";

const HASH = "0123456789abcdef0123456789abcdef";
const PATH = `/agents/quantcoach/sessions/sg-quantcoach-2160ac2e3499/images/${HASH}`;
const block = (ref: Record<string, unknown>) => ({ type: "image", mimeType: "image/png", data: "", ref });
const good = { hash: HASH, bytes: 4_153_872, mimeType: "image/png", width: 1440, height: 1920, path: PATH };

test("a block with the relay's link is a link, with its size", () => {
	assert.deepEqual(imageRefOf(block(good)), good);
	const noSize = { hash: HASH, bytes: 10, mimeType: "image/jpeg", path: PATH };
	assert.deepEqual(imageRefOf(block(noSize)), noSize);
});

test("only the relay's picture route for the block's own hash is accepted", () => {
	// The path is fetched with the relay token; the history is written by an agent that reads web pages.
	const other = "f".repeat(32);
	for (const path of [
		`/agents/quantcoach/sessions/sg-1/images/${other}`, // another picture's route
		"/agents/quantcoach/sessions/sg-1/stop",
		`/agents/quantcoach/sessions/sg-1/images/${HASH}/../../stop`,
		`/agents/quantcoach/sessions/sg-1/images/${HASH}?w=1`,
		`https://example.com/agents/a/sessions/b/images/${HASH}`,
		`//example.com/agents/a/sessions/b/images/${HASH}`,
		`/sync/agents/a/sessions/b/images/${HASH}`,
	])
		assert.equal(imageRefOf(block({ ...good, path })), undefined, path);
	assert.equal(imageRefOf(block({ ...good, hash: "short" })), undefined);
	assert.equal(imageRefOf(block({ ...good, mimeType: "text/html" })), undefined);
	assert.equal(imageRefOf({ type: "text", text: "x", ref: good }), undefined);
	assert.equal(imageRefOf({ type: "image", mimeType: "image/png", data: "AAAA" }), undefined);
});

test("the URL is the sync url plus the path; an edge asks for a smaller copy", () => {
	const ref = imageRefOf(block(good));
	assert.ok(ref);
	assert.equal(
		imageUrl("https://cors-proxy.tjw-private/sitegeist/", ref),
		`https://cors-proxy.tjw-private/sitegeist${PATH}`,
	);
	assert.equal(
		imageUrl("https://cors-proxy.tjw-private/sitegeist", ref, 512),
		`https://cors-proxy.tjw-private/sitegeist${PATH}?w=512`,
	);
});

test("the copy asked for is the smallest that is sharp on this screen", () => {
	assert.equal(edgeFor(160, 1), 256);
	assert.equal(edgeFor(256, 1), 256);
	assert.equal(edgeFor(256, 2), 512);
	assert.equal(edgeFor(455, 2), 960);
	assert.equal(edgeFor(5000, 2), 2000);
});

test("the box keeps the picture's shape, no taller than the limit and never enlarged", () => {
	const ref = imageRefOf(block(good));
	assert.ok(ref);
	assert.deepEqual(boxFor(ref, 160), { width: 120, height: 160 });
	assert.deepEqual(boxFor({ ...ref, width: 300, height: 100 }, 256), { width: 300, height: 100 });
	assert.equal(boxFor({ hash: HASH, bytes: 1, mimeType: "image/png", path: PATH }, 256), undefined);
});

test("a message's pictures: links, inline data, and nothing for an empty block", () => {
	const drawn = drawnImages([
		{ type: "text", text: "see these" },
		block(good),
		{ type: "image", mimeType: "image/png", data: "AAAA" },
		{ type: "image", mimeType: "image/png", data: "" },
		block({ ...good, path: "/agents/a/sessions/b/stop" }),
	]);
	assert.equal(drawn.length, 2);
	assert.deepEqual(drawn[0], { kind: "link", ref: good });
	assert.deepEqual(drawn[1], { kind: "inline", src: "data:image/png;base64,AAAA" });
	assert.deepEqual(drawnImages("plain text"), []);
});

test("the browser's stored copy keeps a link as it is", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "four screenshots" }, block(good)], timestamp: 1 },
	] as unknown as AgentMessage[]; // test data in the R730's shape: an image block carrying a link
	assert.equal(
		slimForStorage(messages, () => false),
		messages,
	);
});
