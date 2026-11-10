/**
 * The rules of the shared search text (src/prime/chat-text.ts). Run: npm run test:chat-text
 */
import assert from "node:assert/strict";
import test from "node:test";
import { remoteTextOf, TEXT_PUSH_PER_CALL, textToPull, textToPush } from "../src/prime/chat-text.ts";

const shared = (id: string) => id.startsWith("sg-");
const rec = (id: string, lastModified: string, text = "words", textFrom?: string) => ({
	id,
	lastModified,
	text,
	...(textFrom ? { textFrom } : {}),
});

test("push: texts built here that the R730 lacks or has in an older form, newest first, never fetched ones", () => {
	const records = [
		rec("sg-old", "2026-11-10T01:00:00.000Z"), // the R730 has this form already
		rec("sg-new", "2026-11-10T03:00:00.000Z"), // R730 has an older form
		rec("sg-none", "2026-11-10T02:00:00.000Z"), // R730 has none
		rec("sg-fetched", "2026-11-10T04:00:00.000Z", "words", "2026-11-10T04:00:00.000Z"), // came from the R730
		rec("browser-chat", "2026-11-10T05:00:00.000Z"), // not an R730 chat
		rec("sg-empty", "2026-11-10T05:00:00.000Z", ""), // nothing to send
	];
	const textAt = { "sg-old": "2026-11-10T01:00:00.000Z", "sg-new": "2026-11-10T02:00:00.000Z" };
	assert.deepEqual(
		textToPush(records, textAt, shared).map((r) => r.id),
		["sg-new", "sg-none"],
	);
});

test("push goes out in pieces: at most 50 texts, and the chars of one call are bounded", () => {
	const many = Array.from({ length: 70 }, (_, i) =>
		rec(`sg-${String(i).padStart(12, "0")}`, `2026-11-10T00:${String(i).padStart(2, "0")}:00.000Z`),
	);
	assert.equal(textToPush(many, {}, shared).length, TEXT_PUSH_PER_CALL);
	const big = [
		rec("sg-a", "2026-11-10T02:00:00.000Z", "x".repeat(1_500_000)),
		rec("sg-b", "2026-11-10T01:00:00.000Z", "y".repeat(1_500_000)),
		rec("sg-c", "2026-11-10T00:00:00.000Z", "z"),
	];
	assert.deepEqual(
		textToPush(big, {}, shared).map((r) => r.id),
		["sg-a"],
	); // the second would pass 2 MB
	// the next call: b (1.5 MB) and then c, which still fits under 2 MB
	assert.deepEqual(
		textToPush(big, { "sg-a": "2026-11-10T02:00:00.000Z" }, shared).map((r) => r.id),
		["sg-b", "sg-c"],
	);
	// one text larger than the whole budget still goes (alone)
	assert.deepEqual(
		textToPush([rec("sg-huge", "2026-11-10T02:00:00.000Z", "x".repeat(3_000_000))], {}, shared).map((r) => r.id),
		["sg-huge"],
	);
});

test("pull: chats the R730 has newer text for than this browser, newest chat first, 20 at a time", () => {
	const records = [
		rec("sg-same", "2026-11-10T01:00:00.000Z"), // built here from the same state
		rec("sg-older", "2026-11-10T01:00:00.000Z"), // built here from an older state
		rec("sg-fetched-old", "2026-11-10T00:00:00.000Z", "words", "2026-11-10T01:00:00.000Z"), // fetched, R730 has newer
		rec("sg-fetched-same", "2026-11-10T00:00:00.000Z", "words", "2026-11-10T02:00:00.000Z"),
	];
	const textAt = {
		"sg-same": "2026-11-10T01:00:00.000Z",
		"sg-older": "2026-11-10T02:00:00.000Z",
		"sg-fetched-old": "2026-11-10T02:00:00.000Z",
		"sg-fetched-same": "2026-11-10T02:00:00.000Z",
		"sg-missing": "2026-11-10T02:00:00.000Z",
		"sg-notext": "",
	};
	const lastModifiedOf = {
		"sg-older": "2026-11-10T09:00:00.000Z",
		"sg-missing": "2026-11-10T08:00:00.000Z",
		"sg-fetched-old": "2026-11-10T07:00:00.000Z",
	};
	assert.deepEqual(textToPull(records, textAt, lastModifiedOf), ["sg-older", "sg-missing", "sg-fetched-old"]);
	const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`sg-${i}`, "2026-11-10T02:00:00.000Z"]));
	assert.equal(textToPull([], many, {}).length, 20);
});

test("the relay's text is checked before use", () => {
	assert.deepEqual(remoteTextOf({ id: "sg-a", textAt: "t", text: "x", junk: 1 }), {
		id: "sg-a",
		textAt: "t",
		text: "x",
	});
	assert.equal(remoteTextOf({ id: "sg-a", textAt: "t" }), undefined);
	assert.equal(remoteTextOf("x"), undefined);
});
