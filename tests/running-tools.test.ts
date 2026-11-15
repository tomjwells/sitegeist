/**
 * The panel's store of running commands (src/prime/running-tools.ts): seeded from the relay's hydrate, updated by its
 * pushes and by the agent's own start/end events; times moved onto this browser's clock; malformed input ignored.
 * npm run test:running
 */
import assert from "node:assert/strict";
import test from "node:test";
import { elapsed, RUNNING_CHANGED, runningTools } from "../src/prime/running-tools.ts";

const view = (id: string, extra: Record<string, unknown> = {}) => ({
	toolCallId: id,
	toolName: "ipython",
	startedAt: 1_000_000,
	seenFrom: 1_000_000,
	lastOutputAt: 1_005_000,
	lines: 3,
	tail: "a\nb\nc",
	truncated: false,
	missedOutput: false,
	...extra,
});

test("hydrate seed: the relay's clock is moved onto this browser's; durations kept; a new chat starts empty", () => {
	const relayNow = 1_010_000;
	runningTools.seed("prime/sg-a", { now: relayNow, running: [view("c1")], toolDurations: { old: 42_000 } });
	const run = runningTools.get("c1");
	const skew = Date.now() - relayNow;
	assert.ok(
		run && run.startedAt !== null && Math.abs(run.startedAt - (1_000_000 + skew)) < 50,
		"start moved by the skew",
	);
	assert.equal(runningTools.duration("old"), 42_000);
	runningTools.seed("prime/sg-b", undefined); // an old relay: nothing
	assert.equal(runningTools.list().length, 0);
	assert.equal(runningTools.duration("old"), undefined);
});

test("pushes: the list is the relay's; finished calls get a duration; another chat's push is ignored; junk ignored", async () => {
	runningTools.seed("prime/sg-c", { now: Date.now(), running: [], toolDurations: {} });
	let changes = 0;
	const count = () => {
		changes++;
	};
	runningTools.addEventListener(RUNNING_CHANGED, count);
	runningTools.push("prime/sg-c", {
		now: Date.now(),
		running: [view("c1", { args: { code: "import time" } }), view("c2")],
		finished: {},
	});
	assert.match(runningTools.get("c1")?.title ?? "", /^Python · import time/);
	runningTools.push("prime/sg-c", { now: Date.now(), running: [view("c1"), view("c2")], finished: {} });
	assert.match(
		runningTools.get("c1")?.title ?? "",
		/^Python · import time/,
		"a later push without args keeps the title",
	);
	assert.deepEqual(
		runningTools.list().map((r) => r.toolCallId),
		["c1", "c2"],
	);
	runningTools.push("prime/sg-OTHER", { now: Date.now(), running: [], finished: { c1: 5 } });
	assert.equal(runningTools.list().length, 2, "another chat's push changes nothing");
	runningTools.push("prime/sg-c", { now: "yesterday", running: "lots" });
	assert.equal(runningTools.list().length, 2, "malformed push ignored");
	await new Promise((r) => setTimeout(r, 300));
	runningTools.push("prime/sg-c", { now: Date.now(), running: [view("c2", { lines: 9 })], finished: { c1: 125_000 } });
	assert.deepEqual(
		runningTools.list().map((r) => r.toolCallId),
		["c2"],
	);
	assert.equal(runningTools.get("c2")?.lines, 9);
	assert.equal(runningTools.duration("c1"), 125_000);
	await new Promise((r) => setTimeout(r, 300));
	assert.ok(changes >= 2 && changes <= 4, `change events are throttled (${changes})`);
	runningTools.removeEventListener(RUNNING_CHANGED, count);
});

test("local events: a start shows at once (before any push); its end gives a duration; agent_end clears", () => {
	runningTools.seed("quantcoach/sg-d", undefined);
	runningTools.started("quantcoach/sg-d", "b1", "bash", { command: "sleep 600" });
	assert.match(runningTools.get("b1")?.title ?? "", /sleep 600/, "title from the call's input");
	const run = runningTools.get("b1");
	assert.ok(run && run.fromRelay === false && run.lines === 0 && run.startedAt !== null);
	// a push that does not list a call only started here keeps it
	runningTools.push("quantcoach/sg-d", { now: Date.now(), running: [], finished: {} });
	assert.ok(runningTools.get("b1"), "kept until the relay has seen it");
	runningTools.ended("quantcoach/sg-d", "b1");
	assert.equal(runningTools.get("b1"), undefined);
	assert.ok((runningTools.duration("b1") ?? -1) >= 0);
	runningTools.started("quantcoach/sg-d", "b2", "bash");
	runningTools.clear("quantcoach/sg-d");
	assert.equal(runningTools.list().length, 0);
});

test("elapsed: seconds, minutes, hours", () => {
	assert.equal(elapsed(4_200), "4s");
	assert.equal(elapsed(125_000), "2m 05s");
	assert.equal(elapsed(3_723_000), "1h 02m");
	assert.equal(elapsed(-5), "0s");
});
