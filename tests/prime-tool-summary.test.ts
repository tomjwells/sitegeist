/**
 * The compact R730 tool-call display builds its title from the tool name and arguments and its subtitle from the
 * first output line (Tom, 2026-11-02: prime tool calls showed as "Tool Call" + raw JSON while the Browser agent's
 * showed "Reading the Reddit thread"). Pure text, plain node.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { primeToolSubtitleText, primeToolTitle } from "../src/prime/tool-summary.ts";
import { agentIdFromSessionId, harnessFromSessionId } from "../src/prime/constants.ts";

test("titles say what the tool is doing, like the Browser agent's rows", () => {
	assert.equal(primeToolTitle("browser_page", { tabId: 121, links: false }), "Reading the page · tab 121");
	assert.equal(
		primeToolTitle("browser_page", { tabId: 121, find: "128\\s?GB|Memory", context: 250 }),
		'Reading the page · tab 121 · find "128\\s?GB|Memory"',
	);
	assert.equal(primeToolTitle("browser_page", { mode: "text", selector: "main" }), "Reading the page · main · text");
	assert.equal(
		primeToolTitle("browser_eval", {
			tabId: 60,
			code: "const main = document.querySelector('main');\nreturn main.innerText;",
		}),
		"Running JavaScript in the page · tab 60 · const main = document.querySelector('main');",
	);
	assert.equal(
		primeToolTitle("browser_eval", { urls: ["https://a/1", "https://a/2"], code: "return 1;" }),
		"Running JavaScript on 2 pages · return 1;",
	);
	assert.equal(
		primeToolTitle("browser_navigate", {
			url: "https://www.dell.com/en-gb/shop/laptop-computers/spd/xps16dx16263",
			newTab: true,
		}),
		"Opening www.dell.com/en-gb/shop/laptop-computers/spd/xps16dx16263 in a new tab",
	);
	assert.equal(primeToolTitle("browser_tabs", { query: "linkedin" }), 'Finding tabs matching "linkedin"');
	assert.equal(primeToolTitle("browser_tab_action", { action: "close", tabIds: [1, 2, 3] }), "Closing 3 tabs");
	assert.equal(primeToolTitle("browser_screenshot", { tabId: 7 }), "Screenshot · tab 7");
	assert.equal(
		primeToolTitle("ipython", { code: "import json\nh = await bash('ls')\nprint(h.output)" }),
		"Python · import json",
	);
	assert.equal(
		primeToolTitle("telegram_attach", { paths: ["/tmp/a/chart.png", "/tmp/notes.md"] }),
		"Sending chart.png, notes.md",
	);
	assert.equal(primeToolTitle("agent_wiki_search", { query: "CeX returns" }), 'Searching the wiki for "CeX returns"');
	assert.equal(
		primeToolTitle("agent_wiki_read", { uri: "agentswiki://page/01a06426-e6df", heading: "Follow-ups" }),
		"Reading the wiki · 01a06426-e6df · Follow-ups",
	);
	assert.equal(
		primeToolTitle("agent_wiki_append_section", { page_id: "x", under_heading: "Changelog" }),
		"Wiki: append section · Changelog",
	);
	assert.equal(
		primeToolTitle("searxng_search", { query: "Dell XPS 16 Creator Edition 128GB" }),
		'Searching the web for "Dell XPS 16 Creator Edition 128GB"',
	);
	assert.equal(
		primeToolTitle("rotfetch_fetch", { url: "https://www.storagereview.com/review/dell-xps-16" }),
		"Fetching www.storagereview.com/review/dell-xps-16",
	);
	assert.equal(
		primeToolTitle("komainu_env_exec", { items: ["ebay-developer-keys"], command: "ebay item 1" }),
		"Credentials: env exec",
	);
	assert.equal(
		primeToolTitle("some_new_tool", { thing: "first string wins", n: 3 }),
		"some new tool · first string wins",
	);
	assert.equal(primeToolTitle("browser_page", undefined), "Reading the page");
});

test("long arguments are cut, never dumped", () => {
	const long = "x".repeat(500);
	assert.ok(primeToolTitle("browser_eval", { code: long }).length < 120);
	assert.ok(primeToolTitle("searxng_search", { query: long }).length < 100);
});

test("the subtitle is the first output line; an image-only result says so", () => {
	assert.equal(
		primeToolSubtitleText([
			{
				type: "text",
				text: "Tomos Wells | LinkedIn — https://www.linkedin.com/in/tomos-wells/\n[browser_page: main via semantic; 3,540 chars]",
			},
		]),
		"Tomos Wells | LinkedIn — https://www.linkedin.com/in/tomos-wells/",
	);
	assert.equal(
		primeToolSubtitleText([
			{ type: "text", text: "\n\nbrowser tool browser_page (reader script) failed: browser_call_timeout" },
		]),
		"browser tool browser_page (reader script) failed: browser_call_timeout",
	);
	assert.equal(primeToolSubtitleText([{ type: "image" }]), "image");
	assert.equal(
		primeToolSubtitleText(
			[
				{
					type: "text",
					text: 'id\tmark\twin\ttitle\turl\n60\t*>\t38\tTomos Wells | LinkedIn\thttps://x\nShowing 1; 1 of 14 open tabs match "linkedin". Marks: …',
				},
			],
			"browser_tabs",
		),
		'Showing 1; 1 of 14 open tabs match "linkedin". Marks: …',
	);
	assert.equal(primeToolSubtitleText([{ type: "text", text: "a".repeat(300) }]).length, 140);
});

test("pi harness tools and duo's mode tools get readable titles (2026-11-15)", () => {
	assert.equal(primeToolTitle("bash", { command: "sleep 40 && echo done\nmore" }), "Shell · sleep 40 && echo done");
	assert.equal(primeToolTitle("bash", {}), "Shell");
	assert.equal(primeToolTitle("read", { path: "/workspace/notes.md" }), "Reading /workspace/notes.md");
	assert.equal(primeToolTitle("edit", { path: "src/a.ts" }), "Editing src/a.ts");
	assert.equal(primeToolTitle("write", { path: "out.txt" }), "Writing out.txt");
	assert.equal(primeToolTitle("handoff", { brief: "x" }), "Switching mode");
	assert.equal(primeToolTitle("decide", { question: "Which one?\nmore" }), "Deciding in planning mode · Which one?");
	assert.equal(primeToolTitle("stay_in_planning", {}), "Your next message starts in planning mode");
});

test("session ids: pi chats have pi- before the hex; the agent comes first", () => {
	assert.equal(harnessFromSessionId("sg-pi-0123456789ab"), "pi");
	assert.equal(agentIdFromSessionId("sg-pi-0123456789ab"), "prime");
	assert.equal(harnessFromSessionId("sg-quantcoach-pi-0123456789ab"), "pi");
	assert.equal(agentIdFromSessionId("sg-quantcoach-pi-0123456789ab"), "quantcoach");
	assert.equal(harnessFromSessionId("sg-0123456789ab"), "prime");
	assert.equal(agentIdFromSessionId("sg-0123456789ab"), "prime");
	assert.equal(harnessFromSessionId("sg-cassianvale-5e3b401fe41e"), "prime");
	assert.equal(agentIdFromSessionId("sg-cassianvale-5e3b401fe41e"), "cassianvale");
});
