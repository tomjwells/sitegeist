import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSearchText,
	pastedSessionId,
	queryTerms,
	SEARCH_TEXT_MAX_CHARS,
	type SearchEntry,
	searchSessions,
	sessionsMatchingId,
	sgIdForNative,
	snippetAround,
} from "../src/sessions/session-search.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const asst = (text: string, thinking?: string) =>
	({
		role: "assistant",
		content: [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "text", text }],
		api: "x",
		provider: "p",
		model: "m",
		usage,
		stopReason: "stop",
		timestamp: 1,
	}) as never;
const user = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as never;

test("buildSearchText: transcript, thinking, tool output, pages, attachments; capped", () => {
	const text = buildSearchText(
		[
			user("Help me with this video. So what's the software he uses for the mapping?"),
			asst(
				"He uses Vial for the Corne keymap.",
				"Tom wants to know what keymapping software is used in this Corne wireless keyboard video",
			),
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "browser_page",
				content: [{ type: "text", text: "Transcript: ...QMK and Vial..." }],
				isError: false,
				timestamp: 1,
			} as never,
			{
				role: "navigation",
				url: "https://www.youtube.com/watch?v=wTMcH7u-vu0",
				title: "The Ultimate Minimalist Keyboard | Wireless Corne - YouTube",
				timestamp: 1,
			} as never,
			{
				role: "user-with-attachments",
				content: "fill the form",
				attachments: [{ fileName: "Tomos Wells - CV.pdf" }],
				timestamp: 1,
			} as never,
			{
				role: "artifact",
				action: "create",
				filename: "keymap.md",
				content: "x".repeat(5000),
				timestamp: "t",
			} as never,
		],
		"Help me with this video.",
	);
	for (const needle of [
		"Vial for the Corne",
		"keymapping software",
		"QMK and Vial",
		"Wireless Corne - YouTube",
		"youtube.com/watch?v=wTMcH7u-vu0",
		"Tomos Wells - CV.pdf",
		"keymap.md",
	])
		assert.ok(text.includes(needle), needle);
	assert.ok(!text.includes("xxxxx"), "artifact content is not indexed");

	const huge = buildSearchText([user("a".repeat(SEARCH_TEXT_MAX_CHARS)), user("tail-marker")], "t");
	assert.ok(huge.length <= SEARCH_TEXT_MAX_CHARS + 2);
	assert.ok(!huge.includes("tail-marker"));
});

const entries: SearchEntry[] = [
	{
		id: "corne",
		title: "Help me with this video.",
		text:
			"Tom wants to know what keymapping software is used in this Corne wireless keyboard video. ".repeat(3) +
			"Vial. corne corne",
		lastModified: "2026-09-27T22:25:00Z",
	},
	{
		id: "come",
		title: "Come to think of it",
		text: "core concerns about the chrome office",
		lastModified: "2026-09-28T00:00:00Z",
	},
	{
		id: "titled",
		title: "Corne build log",
		text: "nothing relevant in the body",
		lastModified: "2026-09-01T00:00:00Z",
	},
	{
		id: "anchored",
		title: "Help me with this video.",
		text: "",
		extra: "The Ultimate Minimalist Keyboard | Wireless Corne - YouTube https://www.youtube.com/watch?v=wTMcH7u-vu0",
		lastModified: "2026-09-29T00:00:00Z",
	},
];

test("searchSessions: exact terms only, every term required, ranked, snippet marks the hit", () => {
	assert.deepEqual(queryTerms("  Corne  VIAL corne "), ["corne", "vial"]);
	const hits = searchSessions("corne", entries);
	assert.deepEqual(
		hits.map((h) => h.id),
		["titled", "corne", "anchored"],
		"title hit outranks body hits; fuzzy 'come/core/corner' never matches",
	);
	const corne = hits.find((h) => h.id === "corne");
	assert.ok(corne);
	assert.equal(corne.hits, 5);
	assert.ok(
		corne.snippet.some((s) => s.hit && s.text === "Corne"),
		JSON.stringify(corne.snippet),
	);
	assert.ok(
		corne.snippet
			.map((s) => s.text)
			.join("")
			.includes("keymapping software is used in this Corne"),
	);
	// extra (bound page titles) is searchable
	assert.ok(
		hits
			.find((h) => h.id === "anchored")
			?.snippet.map((s) => s.text)
			.join("")
			.includes("Wireless Corne"),
	);
	// all terms required
	assert.deepEqual(
		searchSessions("corne vial", entries).map((h) => h.id),
		["corne"],
	);
	assert.deepEqual(searchSessions("corne zzz", entries), []);
	assert.deepEqual(searchSessions("   ", entries), []);
});

test("snippetAround: window, word snapping, ellipses, multiple terms", () => {
	const text = `${"lorem ipsum ".repeat(20)}the Corne keyboard uses Vial for keymaps${" dolor sit ".repeat(20)}`;
	const seg = snippetAround(text, text.toLowerCase(), ["corne", "vial"]);
	const joined = seg.map((s) => s.text).join("");
	assert.ok(joined.startsWith("…") && joined.endsWith("…"));
	assert.equal(seg[0]?.hit, false);
	assert.ok(joined.length < 170, String(joined.length));
	assert.deepEqual(
		seg.filter((s) => s.hit).map((s) => s.text),
		["Corne", "Vial"],
	);
	// no hit → plain head of text
	assert.deepEqual(snippetAround("abc", "abc", ["zzz"]), [{ text: "abc", hit: false }]);
});

test("pasted ids: sg ids, UUIDs, session-finder lines and jsonl paths resolve to a session", () => {
	assert.equal(pastedSessionId("sg-95134e79fa34"), "sg-95134e79fa34");
	assert.equal(pastedSessionId("  SG-95134E79FA34 "), "sg-95134e79fa34");
	assert.equal(pastedSessionId("sg-quantcoach-0a1b2c3d4e5f"), "sg-quantcoach-0a1b2c3d4e5f");
	assert.equal(
		pastedSessionId("/session_resume 01a0df45-9e92-7599-b7d2-9fbd9cfaa12e"),
		"01a0df45-9e92-7599-b7d2-9fbd9cfaa12e",
	);
	assert.equal(
		pastedSessionId(
			"/home/vscode/.prime/agent/state/prime-host-telegram-rpc/sessions/sg-95134e79fa34/prime-session/01a0df45-9e92-7599-b7d2-9fbd9cfaa12e.jsonl",
		),
		"01a0df45-9e92-7599-b7d2-9fbd9cfaa12e",
	);
	assert.equal(pastedSessionId("corne keyboard"), undefined);
	assert.equal(pastedSessionId("video"), undefined);
	const ids = [
		{ id: "sg-95134e79fa34" },
		{ id: "sg-95134e79fa34-other" },
		{ id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" },
	];
	assert.deepEqual(sessionsMatchingId("sg-95134e79fa34", ids), ["sg-95134e79fa34", "sg-95134e79fa34-other"]);
	assert.deepEqual(sessionsMatchingId("9B1DEB4D-3B7D-4BAD-9BDD-2B0D7B3DCB6D", ids), [
		"9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
	]);
	assert.deepEqual(sessionsMatchingId("01a0df45-9e92-7599-b7d2-9fbd9cfaa12e", ids), []);
	// a prime session is also known by its native UUID / jsonl path (indexed as aliases once the panel attached it)
	const withAliases = [
		...ids,
		{
			id: "sg-95134e79fa34-p",
			aliases: [
				"01a0df45-9e92-7599-b7d2-9fbd9cfaa12e",
				"/home/vscode/.prime/agent/state/prime-host-telegram-rpc/sessions/sg-95134e79fa34/prime-session/01a0df45-9e92-7599-b7d2-9fbd9cfaa12e.jsonl",
			],
		},
	];
	assert.deepEqual(sessionsMatchingId("01a0df45-9e92-7599-b7d2-9fbd9cfaa12e", withAliases), ["sg-95134e79fa34-p"]);
});

test("quoted phrases and native-id lookup", () => {
	assert.deepEqual(queryTerms('"corne v4" vial'), ["corne v4", "vial"]);
	assert.deepEqual(queryTerms('"Corne   V4"'), ["corne v4"]);
	assert.deepEqual(queryTerms('"unterminated phrase'), ["unterminated", "phrase"]);
	const entries: SearchEntry[] = [
		{ id: "a", title: "t", text: "The Corne V4 is foostan's newer revision", lastModified: "2026-10-01T00:00:00Z" },
		{ id: "b", title: "t", text: "corne keyboard, v4 of something else", lastModified: "2026-10-02T00:00:00Z" },
	];
	assert.deepEqual(
		searchSessions('"corne v4"', entries).map((h) => h.id),
		["a"],
	);
	assert.deepEqual(
		searchSessions("corne v4", entries)
			.map((h) => h.id)
			.sort(),
		["a", "b"],
	);
	const map = new Map([["sg-95134e79fa34", ["01a0df45-9e92-7599-b7d2-9fbd9cfaa12e"]]]);
	assert.equal(sgIdForNative("01A0DF45-9E92-7599-B7D2-9FBD9CFAA12E", map), "sg-95134e79fa34");
	assert.equal(sgIdForNative("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", map), undefined);
});
