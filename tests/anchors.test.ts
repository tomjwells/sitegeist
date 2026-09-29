import assert from "node:assert/strict";
import test from "node:test";
import {
	type AnchorBinding,
	type AnchorsBackend,
	AnchorsStore,
	AUTO_ANCHORS_PER_SESSION,
	bindingsForKey,
	bindingsForSession,
	pageKey,
	pruneBindings,
	removeBinding,
	upsertBinding,
} from "../src/anchors/anchors.ts";

test("pageKey: the same page in every form gives one key", () => {
	const yt = "youtube.com/watch?v=xsd_VoJHFAk";
	for (const url of [
		"https://www.youtube.com/watch?v=xsd_VoJHFAk",
		"https://www.youtube.com/watch?v=xsd_VoJHFAk&t=1210s&list=PLx&index=3",
		"https://m.youtube.com/watch?v=xsd_VoJHFAk&feature=share",
		"https://youtu.be/xsd_VoJHFAk?si=abc123",
		"https://www.youtube.com/shorts/xsd_VoJHFAk",
		"https://www.youtube.com/live/xsd_VoJHFAk?feature=share",
		"http://youtube.com/embed/xsd_VoJHFAk",
	])
		assert.equal(pageKey(url), yt, url);

	assert.equal(
		pageKey("https://www.amazon.co.uk/Corne-Keyboard-Wireless/dp/B0CXYZ1234/ref=sr_1_3?keywords=corne&qid=1"),
		"amazon.co.uk/dp/B0CXYZ1234",
	);
	assert.equal(pageKey("https://www.amazon.com/gp/product/B0CXYZ1234?psc=1"), "amazon.com/dp/B0CXYZ1234");
	assert.equal(
		pageKey("https://www.ebay.co.uk/itm/Corne-v4-kit/123456789012?hash=abc&_trkparms=x"),
		"ebay.co.uk/itm/123456789012",
	);
	assert.equal(pageKey("https://www.ebay.co.uk/itm/123456789012"), "ebay.co.uk/itm/123456789012");
	assert.equal(
		pageKey("https://www.google.com/search?q=split+keyboard&oq=split&sourceid=chrome&ie=UTF-8"),
		"google.com/search?q=split%20keyboard",
	);

	// generic: scheme/www/fragment/trailing slash/tracking params gone, remaining params sorted
	assert.equal(
		pageKey("http://www.mechboards.co.uk/products/corne-kit/?variant=42&utm_source=x&fbclid=y#reviews"),
		"mechboards.co.uk/products/corne-kit?variant=42",
	);
	assert.equal(
		pageKey("https://mechboards.co.uk/products/corne-kit?b=2&a=1"),
		"mechboards.co.uk/products/corne-kit?a=1&b=2",
	);
	assert.equal(pageKey("https://example.com/"), "example.com");
	assert.equal(pageKey("https://example.com:443/"), "example.com");
	assert.equal(pageKey("http://localhost:5173/app?x=1"), "localhost:5173/app?x=1");
	assert.equal(pageKey("https://example.com"), "example.com");
	// pages that cannot anchor
	for (const url of [
		"chrome://extensions",
		"chrome-extension://abc/sidepanel.html",
		"about:blank",
		"data:text/html,hi",
		"not a url",
		"",
	])
		assert.equal(pageKey(url), undefined, url);
});

const at = (iso: string) => new Date(iso);
const video = {
	url: "https://www.youtube.com/watch?v=xsd_VoJHFAk&t=5s",
	pageTitle: "The Life of a Process",
	sessionId: "s-video",
};

test("upsertBinding: records, refreshes, keeps pinned, caps auto anchors per session", () => {
	let list: AnchorBinding[] = [];
	({ list } = upsertBinding(list, video, at("2026-09-29T01:00:00Z")));
	assert.equal(list.length, 1);
	assert.deepEqual(list[0], {
		key: "youtube.com/watch?v=xsd_VoJHFAk",
		url: video.url,
		pageTitle: "The Life of a Process",
		sessionId: "s-video",
		lastActive: "2026-09-29T01:00:00.000Z",
		pinned: false,
	});
	// same page again: one binding, newer time, title kept when the new one is empty
	({ list } = upsertBinding(
		list,
		{ ...video, url: "https://youtu.be/xsd_VoJHFAk", pageTitle: "" },
		at("2026-09-29T02:00:00Z"),
	));
	assert.equal(list.length, 1);
	assert.equal(list[0]?.lastActive, "2026-09-29T02:00:00.000Z");
	assert.equal(list[0]?.pageTitle, "The Life of a Process");
	// pin by hand, then an auto prompt on the same page does not unpin
	({ list } = upsertBinding(list, { ...video, pinned: true }, at("2026-09-29T02:10:00Z")));
	({ list } = upsertBinding(list, video, at("2026-09-29T02:20:00Z")));
	assert.equal(list[0]?.pinned, true);
	// unanchorable URL is a no-op
	const r = upsertBinding(list, { url: "chrome://newtab", pageTitle: "New tab", sessionId: "s-video" });
	assert.equal(r.key, undefined);
	assert.equal(r.list, list);

	// cap: research session prompts from many pages; the oldest auto anchors drop, the pinned one stays
	let research: AnchorBinding[] = [];
	({ list: research } = upsertBinding(
		research,
		{ url: "https://shop.example/pinned", pageTitle: "Pinned", sessionId: "s-kb", pinned: true },
		at("2026-09-01T00:00:00Z"),
	));
	for (let i = 0; i < AUTO_ANCHORS_PER_SESSION + 3; i++) {
		({ list: research } = upsertBinding(
			research,
			{ url: `https://shop.example/p/${i}`, pageTitle: `P${i}`, sessionId: "s-kb" },
			at(`2026-09-10T00:${String(i).padStart(2, "0")}:00Z`),
		));
	}
	const mine = bindingsForSession(research, "s-kb");
	assert.equal(mine.length, AUTO_ANCHORS_PER_SESSION + 1);
	assert.equal(mine[0]?.key, "shop.example/pinned");
	assert.ok(!mine.some((b) => b.key === "shop.example/p/0"));
	assert.ok(mine.some((b) => b.key === `shop.example/p/${AUTO_ANCHORS_PER_SESSION + 2}`));
});

test("lookups: most recent session per page, pages per session, remove and prune", () => {
	let list: AnchorBinding[] = [];
	({ list } = upsertBinding(list, video, at("2026-09-29T01:00:00Z")));
	({ list } = upsertBinding(list, { ...video, sessionId: "s-video-2" }, at("2026-09-29T03:00:00Z")));
	({ list } = upsertBinding(
		list,
		{ url: "https://shop.example/p/1", pageTitle: "P1", sessionId: "s-video" },
		at("2026-09-29T04:00:00Z"),
	));
	const forVideo = bindingsForKey(list, "youtube.com/watch?v=xsd_VoJHFAk");
	assert.deepEqual(
		forVideo.map((b) => b.sessionId),
		["s-video-2", "s-video"],
	);
	assert.deepEqual(
		bindingsForSession(list, "s-video").map((b) => b.key),
		["shop.example/p/1", "youtube.com/watch?v=xsd_VoJHFAk"],
	);
	list = removeBinding(list, "youtube.com/watch?v=xsd_VoJHFAk", "s-video-2");
	assert.deepEqual(
		bindingsForKey(list, "youtube.com/watch?v=xsd_VoJHFAk").map((b) => b.sessionId),
		["s-video"],
	);
	list = pruneBindings(list, new Set(["s-video-2"]));
	assert.equal(list.length, 0);
});

test("AnchorsStore round-trips through an injected backend", async () => {
	let stored: AnchorBinding[] = [];
	const backend: AnchorsBackend = {
		read: async () => stored.slice(),
		write: async (l) => {
			stored = l;
		},
	};
	const store = new AnchorsStore(backend);
	assert.equal(await store.record(video), "youtube.com/watch?v=xsd_VoJHFAk");
	assert.equal(await store.record({ url: "chrome://newtab", pageTitle: "", sessionId: "x" }), undefined);
	assert.equal((await store.forUrl("https://youtu.be/xsd_VoJHFAk")).length, 1);
	assert.equal((await store.forSession("s-video")).length, 1);
	await store.detach("youtube.com/watch?v=xsd_VoJHFAk", "s-video");
	assert.equal(stored.length, 0);
	await store.record(video);
	await store.prune(new Set());
	assert.equal(stored.length, 0);
});
