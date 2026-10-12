import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_NOTICE_MAX_AGE_MS, bridgeNoticeToast, isBridgeNotice } from "../src/prime/bridge-notice.ts";

const now = Date.parse("2026-10-12T12:00:00.000Z");
const deadCall = {
	type: "bridge_notice",
	source: "http-rpc-bridge",
	kind: "dead_call",
	trigger: "timeout",
	waitedMs: 30_000,
	model: "anthropic/claude-opus-5-5",
	action: "abort+resume",
	message: "⏱ The model sent nothing for 30 s, so the call was aborted and resumed.",
	timestamp: "2026-10-12T11:59:30.000Z",
};

test("a fresh dead-call notice becomes a toast", () => {
	assert.equal(isBridgeNotice(deadCall), true);
	assert.equal(bridgeNoticeToast(deadCall, now), deadCall.message);
	// only type, message and timestamp are needed
	assert.equal(
		bridgeNoticeToast({ type: "bridge_notice", message: " model switched ", timestamp: now - 1000 }, now),
		"model switched",
	);
	// a bridge clock slightly ahead of the browser still counts as fresh
	assert.equal(bridgeNoticeToast({ ...deadCall, timestamp: "2026-10-12T12:00:20.000Z" }, now), deadCall.message);
});

test("replayed, malformed or foreign events are not shown", () => {
	const old = new Date(now - BRIDGE_NOTICE_MAX_AGE_MS - 1).toISOString();
	assert.equal(bridgeNoticeToast({ ...deadCall, timestamp: old }, now), undefined, "older than 2 minutes");
	assert.equal(
		bridgeNoticeToast({ ...deadCall, timestamp: new Date(now - BRIDGE_NOTICE_MAX_AGE_MS).toISOString() }, now),
		deadCall.message,
		"exactly 2 minutes is still shown",
	);
	const { timestamp: _dropped, ...noTimestamp } = deadCall;
	assert.equal(bridgeNoticeToast(noTimestamp, now), undefined, "missing timestamp");
	assert.equal(bridgeNoticeToast({ ...deadCall, timestamp: "yesterday-ish" }, now), undefined, "unparsable");
	assert.equal(bridgeNoticeToast({ ...deadCall, timestamp: null }, now), undefined, "null timestamp");
	assert.equal(bridgeNoticeToast({ ...deadCall, message: 42 }, now), undefined, "message not a string");
	assert.equal(bridgeNoticeToast({ ...deadCall, message: "   " }, now), undefined, "blank message");
	assert.equal(bridgeNoticeToast({ ...deadCall, type: "agent_end" }, now), undefined, "not a notice");
	assert.equal(isBridgeNotice({ type: "message_end" }), false);
});
