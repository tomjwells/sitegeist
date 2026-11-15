/**
 * The turn store behind the status line (src/prime/turn-status.ts, 2026-11-15; Tom: "both these sessions seem stopped
 * and I cant tell what it's waiting on"). Pure, plain node.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { autoResumeTime, phaseText, turnStatus } from "../src/prime/turn-status.ts";

test("phase follows the events: waiting, thinking, writing, a command, a tool, done", () => {
	turnStatus.seed("prime/sg-a", undefined, true, 1000);
	assert.equal(turnStatus.phase.kind, "waiting");
	turnStatus.event("prime/sg-a", "message_start", undefined, "assistant", 2000);
	assert.equal(turnStatus.phase.kind, "waiting");
	turnStatus.event("prime/sg-a", "message_update", "thinking_delta", "assistant", 3000);
	assert.deepEqual(turnStatus.phase, { kind: "thinking", since: 3000 });
	turnStatus.event("prime/sg-a", "message_update", "thinking_delta", "assistant", 4000);
	assert.equal(turnStatus.phase.since, 3000, "same phase keeps its start");
	assert.equal(turnStatus.lastEventAt, 4000);
	turnStatus.event("prime/sg-a", "message_update", "text_delta", "assistant", 5000);
	assert.equal(turnStatus.phase.kind, "writing");
	turnStatus.event("prime/sg-a", "message_update", "toolcall_delta", "assistant", 6000);
	assert.equal(turnStatus.phase.kind, "command");
	turnStatus.event("prime/sg-a", "tool_execution_start", undefined, undefined, 7000);
	assert.equal(turnStatus.phase.kind, "tool");
	turnStatus.event("prime/sg-a", "message_end", undefined, "toolResult", 8000);
	assert.equal(turnStatus.phase.kind, "waiting");
	turnStatus.event("prime/sg-a", "agent_end", undefined, undefined, 9000);
	assert.equal(turnStatus.phase.kind, "none");
	turnStatus.event("prime/sg-other", "agent_start", undefined, undefined, 9500);
	assert.equal(turnStatus.phase.kind, "none", "another chat's events are ignored");
	assert.equal(phaseText("waiting"), "Waiting for the model");
	assert.equal(phaseText("none"), undefined);
});

test("relay view: hydrate and pushes, junk ignored; a new turn clears a cut note", () => {
	turnStatus.seed(
		"prime/sg-b",
		{ state: "cut", at: 1, note: "Cut by a restart at 15:37 UTC. Nothing is running." },
		false,
		1000,
	);
	assert.equal(turnStatus.relay?.state, "cut");
	assert.equal(turnStatus.push("prime/sg-b", { state: "nonsense" }), undefined);
	assert.equal(turnStatus.relay?.state, "cut");
	assert.equal(turnStatus.push("prime/sg-other", { state: "idle", at: 1, note: "" }), undefined);
	turnStatus.event("prime/sg-b", "agent_start", undefined, undefined, 2000);
	assert.equal(turnStatus.relay?.state, "running");
	turnStatus.push("prime/sg-b", { state: "cut_resumed", at: 5, cutAt: 5, resumedAt: 6, note: "x" });
	turnStatus.event("prime/sg-b", "agent_start", undefined, undefined, 3000);
	assert.equal(turnStatus.relay?.state, "cut_resumed", "the resumed turn keeps its note");
	turnStatus.seed("prime/sg-c", undefined, false);
	assert.equal(turnStatus.relay, undefined, "an older relay sends no turn");
});

test("the resume prompt's cut time", () => {
	assert.equal(
		autoResumeTime("[sitegeist auto-resume — …]\nYour turn on this request was cut at about 15:37 UTC: the agent"),
		"15:37",
	);
	assert.equal(autoResumeTime("hello"), undefined);
});
