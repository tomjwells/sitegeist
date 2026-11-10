/** The side panel's stored place (src/utils/panel-place.ts): what is restored after a browser reload, and when. */
import assert from "node:assert/strict";
import test from "node:test";
import { parsePanelPlace, placeQuery, queryToRestore, RELOAD_WINDOW_MS, samePlace } from "../src/utils/panel-place.ts";

test("place <-> address query", () => {
	assert.equal(placeQuery({ session: "sg-jennifer-8c084791f6a6" }), "?session=sg-jennifer-8c084791f6a6");
	assert.equal(placeQuery({ agent: "jennifer" }), "?new=true&agent=jennifer");
	assert.equal(placeQuery({}), "?new=true");
	assert.equal(placeQuery({ session: "sg-1", agent: "jennifer" }), "?session=sg-1", "a chat wins over the agent");
});

test("stored place is validated", () => {
	assert.deepEqual(parsePanelPlace('{"session":"sg-jennifer-8c084791f6a6","leftAt":5}'), {
		session: "sg-jennifer-8c084791f6a6",
		leftAt: 5,
	});
	assert.deepEqual(parsePanelPlace('{"agent":"jennifer"}'), { agent: "jennifer" });
	assert.deepEqual(parsePanelPlace("{}"), {});
	assert.equal(parsePanelPlace(null), undefined);
	assert.equal(parsePanelPlace(""), undefined);
	assert.equal(parsePanelPlace("not json"), undefined);
	assert.equal(parsePanelPlace("[1]"), undefined);
	assert.deepEqual(
		parsePanelPlace('{"session":"a b&new=true","agent":"Jennifer!","leftAt":"x"}'),
		{},
		"bad fields are dropped",
	);
});

test("restore only for a bare address, a stored place, and a document that left a moment ago", () => {
	const chat = { session: "sg-1" };
	assert.equal(
		queryToRestore("", "", chat, 1000),
		"?session=sg-1",
		"no leave time: the last document died without saying",
	);
	assert.equal(queryToRestore("", "", { ...chat, leftAt: 900 }, 1000), "?session=sg-1", "left 100 ms ago: a reload");
	assert.equal(queryToRestore("", "", { ...chat, leftAt: 1000 }, 1000 + RELOAD_WINDOW_MS), "?session=sg-1");
	assert.equal(
		queryToRestore("", "", { ...chat, leftAt: 1000 }, 1001 + RELOAD_WINDOW_MS),
		undefined,
		"a panel opened later starts the usual way",
	);
	assert.equal(queryToRestore("", "", undefined, 1000), undefined, "nothing stored");
	assert.equal(queryToRestore("?session=sg-2", "", chat, 1000), undefined, "an address that names a chat is obeyed");
	assert.equal(queryToRestore("?new=true", "", chat, 1000), undefined, "Tom's New is obeyed");
	assert.equal(queryToRestore("", "#x", chat, 1000), undefined);
	assert.equal(
		queryToRestore("", "", { agent: "jennifer", leftAt: 990 }, 1000),
		"?new=true&agent=jennifer",
		"a new chat keeps its agent",
	);
	assert.equal(queryToRestore("", "", { leftAt: 990 }, 1000), "?new=true");
});

test("samePlace", () => {
	assert.ok(samePlace({ session: "a" }, { session: "a" }));
	assert.ok(!samePlace({ session: "a" }, { session: "a", leftAt: 1 }));
	assert.ok(!samePlace(undefined, {}));
	assert.ok(!samePlace({ agent: "x" }, { agent: "y" }));
});
