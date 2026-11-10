/**
 * The rules of the chat list every browser shares (src/prime/chat-list.ts). Run: npm run test:chat-list
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	chatsToSend,
	decide,
	isBehind,
	isListOnly,
	latestUsedHere,
	pendingDeletesOf,
	type RemoteChat,
	remoteChatOf,
	syncStateOf,
	usedHere,
} from "../src/prime/chat-list.ts";

const remote = (lastModified: string, extra: Partial<RemoteChat> = {}): RemoteChat => ({
	id: "sg-aaaaaaaaaaaa",
	agentId: "prime",
	title: "P&L terms",
	createdAt: "2026-11-01T10:00:00.000Z",
	lastModified,
	messageCount: 12,
	preview: "Some PnL terms",
	rev: 5,
	...extra,
});
const local = (lastModified: string, marks: Record<string, unknown> = {}) => ({
	id: "sg-aaaaaaaaaaaa",
	title: "P&L terms",
	lastModified,
	messageCount: 12,
	preview: "Some PnL terms",
	...marks,
});

test("a chat this browser does not have is added; one it has is only touched when used later elsewhere", () => {
	assert.equal(decide(null, remote("2026-11-10T02:00:00.000Z")), "add");
	assert.equal(decide(local("2026-11-10T02:00:00.000Z"), remote("2026-11-10T02:00:00.000Z")), "none");
	assert.equal(decide(local("2026-11-10T03:00:00.000Z"), remote("2026-11-10T02:00:00.000Z")), "none");
	assert.equal(decide(local("2026-11-10T01:00:00.000Z"), remote("2026-11-10T02:00:00.000Z")), "behind");
});

test("a list-only entry follows the R730's entry", () => {
	const mine = local("2026-11-10T02:00:00.000Z", { sgListOnly: true });
	assert.equal(decide(mine, remote("2026-11-10T02:00:00.000Z")), "none");
	assert.equal(decide(mine, remote("2026-11-10T03:00:00.000Z")), "refresh");
	assert.equal(decide(mine, remote("2026-11-10T02:00:00.000Z", { title: "Renamed" })), "refresh");
	// even an older time: the R730's entry is the only source of a list-only entry
	assert.equal(decide(mine, remote("2026-11-10T01:00:00.000Z")), "refresh");
});

test("a chat deleted elsewhere is dropped, unless it was used here after the delete", () => {
	const gone = remote("2026-11-10T02:00:00.000Z", { deletedAt: "2026-11-10T04:00:00.000Z" });
	assert.equal(decide(null, gone), "none");
	assert.equal(decide(local("2026-11-10T03:00:00.000Z"), gone), "remove");
	assert.equal(decide(local("2026-11-10T05:00:00.000Z"), gone), "none");
	assert.equal(decide(local("2026-11-10T05:00:00.000Z", { sgListOnly: true }), gone), "remove");
});

test("only changed chats with a copy here are sent, never list-only ones", () => {
	const a = { ...local("2026-11-10T01:00:00.000Z"), id: "sg-a" };
	const b = { ...local("2026-11-10T02:00:00.000Z"), id: "sg-b" };
	const c = { ...local("2026-11-10T03:00:00.000Z", { sgListOnly: true }), id: "sg-c" };
	const d = { ...local("2026-11-10T04:00:00.000Z"), id: "sg-d" };
	const sent = { "sg-a": "2026-11-10T01:00:00.000Z", "sg-b": "2026-11-10T01:30:00.000Z" };
	assert.deepEqual(
		chatsToSend([a, b, c, d], sent, 10).map((e) => e.id),
		["sg-b", "sg-d"],
	);
	assert.deepEqual(
		chatsToSend([a, b, c, d], {}, 2).map((e) => e.id),
		["sg-a", "sg-b"],
	);
});

test("the chat resumed at start is the one this browser used last, not one used later elsewhere", () => {
	const mine = { ...local("2026-11-10T01:00:00.000Z"), id: "sg-mine" };
	// used here at 00:30, then on another machine at 05:00 (entry taken from the R730)
	const elsewhere = {
		...local("2026-11-10T05:00:00.000Z", { sgUsedHere: "2026-11-10T00:30:00.000Z", sgBehind: true }),
		id: "sg-elsewhere",
	};
	const never = { ...local("2026-11-10T06:00:00.000Z", { sgListOnly: true }), id: "sg-never" };
	assert.equal(latestUsedHere([never, elsewhere, mine]), "sg-mine");
	assert.equal(latestUsedHere([never]), null);
	assert.equal(latestUsedHere([]), null);
	assert.equal(usedHere(never), "");
	assert.equal(usedHere(mine), "2026-11-10T01:00:00.000Z");
	assert.equal(isListOnly(never), true);
	assert.equal(isBehind(elsewhere), true);
	assert.equal(isBehind(mine), false);
});

test("the relay's answer and the stored state are checked before use", () => {
	assert.equal(remoteChatOf({ id: "../../x", agentId: "prime" }), undefined);
	assert.equal(remoteChatOf({ ...remote("2026-11-10T02:00:00.000Z"), messageCount: "12" }), undefined);
	assert.equal(remoteChatOf("text"), undefined);
	const ok = remoteChatOf({ ...remote("2026-11-10T02:00:00.000Z"), deletedAt: "2026-11-10T04:00:00.000Z", junk: 1 });
	assert.equal(ok?.deletedAt, "2026-11-10T04:00:00.000Z");
	assert.equal(ok && "junk" in ok, false);
	assert.deepEqual(syncStateOf(null), { storeId: "", rev: 0, sent: {} });
	assert.deepEqual(syncStateOf({ storeId: "s", rev: 3, sent: { "sg-a": "t", "sg-b": 4 } }), {
		storeId: "s",
		rev: 3,
		sent: { "sg-a": "t" },
	});
	assert.deepEqual(pendingDeletesOf([{ id: "sg-a", deletedAt: "t" }, { id: 3 }, "x"]), [
		{ id: "sg-a", deletedAt: "t" },
	]);
	assert.deepEqual(pendingDeletesOf(undefined), []);
});
