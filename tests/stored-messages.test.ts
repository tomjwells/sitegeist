/**
 * The browser copy of an R730 chat keeps no oversized image data (src/prime/stored-messages.ts).
 * 2026-11-09: four pasted 4 MB screenshots made one chat's stored record 90 MB, rewritten on every streamed event;
 * Tom's laptop overheated and Zen crashed whenever the chat was opened.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { isQueued, isUnsent } from "../src/prime/send-state.ts";
import {
	isStoredSlim,
	STORED_ARTIFACT_MAX_CHARS,
	STORED_FORMAT,
	STORED_IMAGE_MAX_CHARS,
	STORED_MESSAGES_MAX,
	STORED_TOOL_TEXT_MAX_CHARS,
	slimForStorage as slim,
} from "../src/prime/stored-messages.ts";

/** As the panel calls it (src/sidepanel.ts saveSession). */
const slimForStorage = (messages: AgentMessage[]): AgentMessage[] => slim(messages, (m) => isUnsent(m) || isQueued(m));

const big = (seed: string) => seed.repeat(Math.ceil((STORED_IMAGE_MAX_CHARS + 1000) / seed.length));
const small = "c21hbGw=".repeat(1000);
// Test messages are plain data in the shapes the panel holds; AgentMessage is a wide union, so they are built as
// unknown and narrowed once here.
const msg = (v: unknown): AgentMessage => v as AgentMessage;
const json = (v: unknown): string => JSON.stringify(v);

test("a pasted screenshot: the image in the content and both tile copies are not kept; names and text are", () => {
	const shot = big("QUJD");
	const sent = msg({
		role: "user",
		content: [
			{ type: "text", text: "What do these mean?" },
			{ type: "image", mimeType: "image/png", data: shot },
		],
		attachments: [
			{
				id: "a1",
				type: "image",
				fileName: "image.png",
				mimeType: "image/png",
				size: 4_153_872,
				content: shot,
				preview: shot,
			},
		],
		timestamp: 1,
	});
	const [kept] = slimForStorage([sent]);
	assert.ok(kept);
	const text = json(kept);
	assert.ok(text.length < 1000, `stored size ${text.length}`);
	assert.ok(!("attachments" in kept), "tiles with full-size data are dropped");
	assert.match(text, /What do these mean\?/);
	assert.match(text, /\[image, \d+ KiB: shown when the chat has loaded from the R730\]/);
	assert.match(text, /Attached: image\.png \(4057 KiB\)/);
	assert.equal(json(sent).length > 3 * STORED_IMAGE_MAX_CHARS, true, "the message in memory is untouched");
});

test("a message the R730 does not have yet (failed or queued) is kept whole: a retry needs its files", () => {
	const shot = big("REVG");
	for (const state of ["failed", "sending", "queued"]) {
		const unsent = msg({
			role: "user",
			content: [
				{ type: "text", text: "retry me" },
				{ type: "image", mimeType: "image/png", data: shot },
			],
			attachments: [
				{
					id: "a1",
					type: "image",
					fileName: "image.png",
					mimeType: "image/png",
					size: 10,
					content: shot,
					preview: shot,
				},
			],
			sgSend: { id: "s1", state, at: 5 },
			timestamp: 1,
		});
		const all = [unsent];
		assert.equal(slimForStorage(all), all, state);
	}
});

test("tool results: small images stay, the duplicate in details.attachments goes, an oversized one becomes a note", () => {
	const huge = big("R0hJ");
	const result = msg({
		role: "toolResult",
		toolCallId: "t1",
		toolName: "ipython",
		content: [
			{ type: "text", text: "Loaded 2 image(s)" },
			{ type: "image", mimeType: "image/jpeg", data: small },
			{ type: "image", mimeType: "image/png", data: huge },
		],
		details: {
			stdout: "Loaded 2 image(s)",
			attachments: [
				{ mimeType: "image/jpeg", data: small, path: "/tmp/a.jpg" },
				{ mimeType: "image/png", data: huge, path: "/tmp/b.png" },
			],
		},
		isError: false,
		timestamp: 2,
	});
	const [kept] = slimForStorage([result]);
	const k = kept as unknown as {
		content: Array<Record<string, unknown>>;
		details: { stdout: string; attachments: Array<Record<string, unknown>> };
	}; // plain data built above
	assert.equal(k.content[1]?.data, small, "the small image is kept");
	assert.equal(k.content[2]?.type, "text");
	assert.deepEqual(k.details.attachments, [
		{ mimeType: "image/jpeg", path: "/tmp/a.jpg", dataInContent: true },
		{ mimeType: "image/png", path: "/tmp/b.png", dataInContent: true },
	]);
	assert.equal(k.details.stdout, "Loaded 2 image(s)");
	assert.ok(json(kept).length < small.length + 1000);
});

test("nothing to do: the same array and the same message objects come back (no copy per save)", () => {
	const messages = [
		msg({ role: "user", content: "plain text", timestamp: 1 }),
		msg({ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 }),
		msg({
			role: "toolResult",
			toolCallId: "t",
			toolName: "x",
			content: [{ type: "image", mimeType: "image/jpeg", data: small }],
			isError: false,
			timestamp: 3,
		}),
		msg({
			role: "user",
			content: "doc",
			attachments: [
				{ id: "d", type: "document", fileName: "a.pdf", mimeType: "application/pdf", size: 10, content: small },
			],
			timestamp: 4,
		}),
	];
	assert.equal(slimForStorage(messages), messages);
});

test("only changed messages are copied; a string content gets the attachment names appended", () => {
	const shot = big("SktM");
	const untouched = msg({ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 });
	const withTiles = msg({
		role: "user",
		content: "see file",
		attachments: [
			{ id: "a", type: "image", fileName: "photo.jpg", mimeType: "image/jpeg", size: 2048, content: shot },
		],
		timestamp: 3,
	});
	const out = slimForStorage([untouched, withTiles]);
	assert.equal(out[0], untouched);
	assert.deepEqual(out[1], { role: "user", content: "see file\n\nAttached: photo.jpg (2 KiB)", timestamp: 3 });
});

test("the list entry says whether a record was written slim", () => {
	assert.equal(isStoredSlim({ id: "sg-1", sgStored: STORED_FORMAT }), true);
	assert.equal(isStoredSlim({ id: "sg-1" }), false);
	assert.equal(isStoredSlim({ id: "sg-1", sgStored: 1 }), false);
});

// --- stage 5 (2026-11-10): the copy is the last screen of the chat ---

const turn = (i: number): AgentMessage[] => [
	msg({ role: "user", content: `question ${i}`, timestamp: i * 10 }),
	msg({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }], timestamp: i * 10 + 1 }),
];

test("only the last messages are kept, a note stands first; messages that never left the browser stay whatever their place", () => {
	const many = Array.from({ length: 60 }, (_, i) => turn(i)).flat(); // 120 messages
	const unsent = msg({
		role: "user",
		content: "never sent",
		timestamp: 5,
		sgSend: { id: "u1", state: "failed", at: 5 },
	});
	many.splice(3, 0, unsent); // early in the chat
	const kept = slimForStorage(many);
	assert.equal(kept.length, STORED_MESSAGES_MAX + 2, "the last 80, the unsent one, and the note");
	assert.equal(kept[0]?.role, "user");
	assert.match(String(kept[0]?.content), /^\[40 earlier messages: shown when the chat has loaded from the R730\]$/);
	assert.equal(kept[1], unsent, "the unsent message is kept whole, before the last 80");
	assert.equal(
		String(kept[kept.length - 1]?.content && json(kept[kept.length - 1]?.content)),
		json([{ type: "text", text: "answer 59" }]),
	);
	assert.equal(kept[2]?.content, `question ${60 - STORED_MESSAGES_MAX / 2}`, "the kept part starts a whole turn in");
	// a short chat is returned as it is
	const few = Array.from({ length: 10 }, (_, i) => turn(i)).flat();
	assert.equal(slimForStorage(few), few);
});

test("artifacts (files the agent sent) are kept up to a budget, newest first; the R730 covers the rest", () => {
	const art = (name: string, chars: number, ts: number) =>
		msg({ role: "artifact", action: "create", filename: name, content: "A".repeat(chars), timestamp: ts });
	const chat = [...turn(1), art("report.pdf", 120_000, 20), ...turn(2)];
	assert.equal(slimForStorage(chat), chat, "a small artifact set is kept as it is: the same array");
	const heavy = [
		...turn(1),
		art("old-big.bin", STORED_ARTIFACT_MAX_CHARS - 1000, 20), // would pass the budget with the two newer ones
		...turn(2),
		art("mid.png", 600_000, 40),
		art("new.pdf", 500_000, 50),
	];
	const kept = slimForStorage(heavy);
	assert.deepEqual(
		kept.filter((m) => m.role === "artifact").map((m) => (m as { filename: string }).filename),
		["mid.png", "new.pdf"],
	);
	assert.equal(kept.length, heavy.length - 1);
	assert.equal(kept[0]?.content, "question 1", "no 'earlier messages' note: no message of the chat was dropped");
	// one artifact larger than the whole budget is still kept (alone)
	const one = [...turn(1), art("huge.bin", STORED_ARTIFACT_MAX_CHARS + 5000, 20)];
	assert.equal(slimForStorage(one), one);
});

test("a tool result's long output is cut, with a note; short output and the call itself are kept as they are", () => {
	const long = "line of output\n".repeat(3000); // 45,000 chars
	const chat = [
		...turn(1),
		msg({
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "ls" } }],
			timestamp: 12,
		}),
		msg({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "ipython",
			content: [{ type: "text", text: long }],
			details: { stdout: long },
			isError: false,
			timestamp: 13,
		}),
		msg({
			role: "toolResult",
			toolCallId: "c2",
			toolName: "ipython",
			content: [{ type: "text", text: "short" }],
			isError: false,
			timestamp: 14,
		}),
	];
	const kept = slimForStorage(chat);
	const cut = kept[3] as { content: Array<{ type: string; text: string }>; details: { stdout: string } };
	const cutText = cut.content[0]?.text ?? "";
	assert.ok(cutText.startsWith("line of output"));
	assert.ok(cutText.length < STORED_TOOL_TEXT_MAX_CHARS + 120, `cut: ${cutText.length}`);
	assert.match(cutText, /KiB of output: shown when the chat has loaded from the R730\]$/);
	assert.ok(cut.details.stdout.length <= STORED_TOOL_TEXT_MAX_CHARS + 1);
	assert.equal(kept[4], chat[4], "the short result is the same object");
	assert.equal(kept[2], chat[2], "the call is the same object");
	// content text + details.stdout, each cut to the cap, plus the JSON escaping of the newlines
	assert.ok(json(kept).length < 2 * STORED_TOOL_TEXT_MAX_CHARS + 8000, `small: ${json(kept).length}`);
});
