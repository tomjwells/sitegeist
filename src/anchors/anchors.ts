/**
 * Page anchors: which sessions belong to which pages. One dependency-free module (page key
 * canonicalisation + the bindings index) so it runs in the side panel, the background worker and
 * node --test alike (tests/anchors.test.ts).
 *
 * Design (Tom, 2026-09-29): sessions bind to canonical page URLs — not tab or window ids, which die
 * with the browser and mean nothing in another profile. Page level only (no domain anchors). Local
 * to the browser profile (chrome.storage.local); prime sessions' transcripts live on the R730 anyway.
 */

// ---- page key ---------------------------------------------------------------------------------

const TRACKING_PARAMS = new Set([
	"fbclid",
	"gclid",
	"dclid",
	"msclkid",
	"yclid",
	"twclid",
	"ttclid",
	"igshid",
	"mc_cid",
	"mc_eid",
	"_ga",
	"_gl",
	"_hsenc",
	"_hsmi",
	"spm",
	"si",
	"feature",
	"ref",
	"ref_",
	"ref_src",
	"referrer",
	"source",
	"campaign",
	"cmpid",
	"ncid",
	"ocid",
	"pp",
	"t",
	"ved",
	"ei",
	"sa",
	"oq",
	"aqs",
	"sourceid",
	"ie",
	"gs_lcp",
	"gs_lp",
	"sclient",
	"uact",
	"bih",
	"biw",
	"rlz",
]);

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeVideoId(u: URL, host: string): string | undefined {
	if (host === "youtu.be") {
		const id = u.pathname.split("/")[1] ?? "";
		return YT_ID.test(id) ? id : undefined;
	}
	if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return undefined;
	if (u.pathname === "/watch") {
		const v = u.searchParams.get("v") ?? "";
		return YT_ID.test(v) ? v : undefined;
	}
	const m = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(u.pathname);
	return m?.[1];
}

function stripWww(host: string): string {
	return host.replace(/^(www|m|mobile)\./, "");
}

/** Returns undefined for URLs that cannot anchor a session (extension pages, chrome://, about:, data:, …). */
export function pageKey(url: string): string | undefined {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return undefined;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
	const host = stripWww(u.host.toLowerCase()); // host keeps a non-default port (localhost:3000 ≠ localhost:5173)
	if (!host) return undefined;

	const ytId = youtubeVideoId(u, host);
	if (ytId) return `youtube.com/watch?v=${ytId}`;

	if (/^amazon\.[a-z.]+$/.test(host)) {
		const m = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/.exec(u.pathname);
		if (m) return `${host}/dp/${m[1]}`;
	}
	if (/^ebay\.[a-z.]+$/.test(host)) {
		const m = /^\/itm\/(?:[^/]+\/)?(\d{9,15})(?:[/?#]|$)/.exec(u.pathname);
		if (m) return `${host}/itm/${m[1]}`;
	}
	if (/^google\.[a-z.]+$/.test(host) && u.pathname === "/search") {
		const q = u.searchParams.get("q")?.trim();
		return q ? `${host}/search?q=${encodeURIComponent(q)}` : `${host}/search`;
	}

	let path = u.pathname.replace(/\/+$/, "");
	if (path === "") path = "";
	const params = Array.from(u.searchParams.entries())
		.filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()) && !/^utm_/i.test(k))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const query =
		params.length > 0
			? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`
			: "";
	return `${host}${path}${query}`;
}

/** Short human form of a key for titles/tooltips ("youtube.com/watch?v=…" → "youtube.com/watch?v=…", long keys truncated). */
export function pageKeyLabel(key: string, max = 60): string {
	return key.length > max ? `${key.slice(0, max - 1)}…` : key;
}

// ---- bindings index -----------------------------------------------------------------------------

export interface AnchorBinding {
	key: string;
	url: string;
	pageTitle: string;
	sessionId: string;
	/** ISO time of the last prompt sent from (or attach of) this page in this session. */
	lastActive: string;
	pinned: boolean;
}

export interface AnchorsBackend {
	read(): Promise<AnchorBinding[]>;
	write(list: AnchorBinding[]): Promise<void>;
}

/** Auto (unpinned) anchors kept per session; the oldest are dropped past this. */
export const AUTO_ANCHORS_PER_SESSION = 12;
export const ANCHORS_STORAGE_KEY = "sg.anchors";

const byLastActiveDesc = (a: AnchorBinding, b: AnchorBinding): number =>
	a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : 0;

export function isAnchorBinding(v: unknown): v is AnchorBinding {
	if (typeof v !== "object" || v === null) return false;
	const b = v as Record<string, unknown>;
	return (
		typeof b.key === "string" &&
		typeof b.url === "string" &&
		typeof b.pageTitle === "string" &&
		typeof b.sessionId === "string" &&
		typeof b.lastActive === "string" &&
		typeof b.pinned === "boolean"
	);
}

export interface RecordInput {
	url: string;
	pageTitle: string;
	sessionId: string;
	/** Attach by hand (pinned). Default false = auto anchor from a prompt. */
	pinned?: boolean;
}

/** Pure: add/refresh a binding; auto anchors beyond the per-session cap are dropped oldest-first. */
export function upsertBinding(
	list: AnchorBinding[],
	input: RecordInput,
	now: Date = new Date(),
): { list: AnchorBinding[]; key: string | undefined } {
	const key = pageKey(input.url);
	if (!key) return { list, key: undefined };
	const existing = list.find((b) => b.key === key && b.sessionId === input.sessionId);
	const next: AnchorBinding = {
		key,
		url: input.url,
		pageTitle: input.pageTitle || existing?.pageTitle || key,
		sessionId: input.sessionId,
		lastActive: now.toISOString(),
		pinned: input.pinned === true || existing?.pinned === true,
	};
	const others = list.filter((b) => !(b.key === key && b.sessionId === input.sessionId));
	const result = [...others, next];
	const auto = result.filter((b) => b.sessionId === input.sessionId && !b.pinned).sort(byLastActiveDesc);
	const drop = new Set(auto.slice(AUTO_ANCHORS_PER_SESSION).map((b) => b.key));
	return { list: result.filter((b) => !(b.sessionId === input.sessionId && !b.pinned && drop.has(b.key))), key };
}

export function removeBinding(list: AnchorBinding[], key: string, sessionId: string): AnchorBinding[] {
	return list.filter((b) => !(b.key === key && b.sessionId === sessionId));
}

export function removeSessionBindings(list: AnchorBinding[], sessionId: string): AnchorBinding[] {
	return list.filter((b) => b.sessionId !== sessionId);
}

/** Drop bindings of sessions that no longer exist. */
export function pruneBindings(list: AnchorBinding[], liveSessionIds: ReadonlySet<string>): AnchorBinding[] {
	return list.filter((b) => liveSessionIds.has(b.sessionId));
}

/** Sessions bound to a page, most recently active first. */
export function bindingsForKey(list: AnchorBinding[], key: string): AnchorBinding[] {
	return list.filter((b) => b.key === key).sort(byLastActiveDesc);
}

/** Pages bound to a session, pinned first, then most recently active. */
export function bindingsForSession(list: AnchorBinding[], sessionId: string): AnchorBinding[] {
	return list
		.filter((b) => b.sessionId === sessionId)
		.sort((a, b) => (a.pinned === b.pinned ? byLastActiveDesc(a, b) : a.pinned ? -1 : 1));
}

export class AnchorsStore {
	private readonly backend: AnchorsBackend;
	constructor(backend: AnchorsBackend) {
		this.backend = backend;
	}

	async all(): Promise<AnchorBinding[]> {
		return this.backend.read();
	}

	/** Returns the key the page was bound under (undefined = the URL cannot anchor a session). */
	async record(input: RecordInput): Promise<string | undefined> {
		const { list, key } = upsertBinding(await this.backend.read(), input);
		if (key) await this.backend.write(list);
		return key;
	}

	async detach(key: string, sessionId: string): Promise<void> {
		await this.backend.write(removeBinding(await this.backend.read(), key, sessionId));
	}

	/** A session was deleted: forget every page it was bound to. */
	async removeSession(sessionId: string): Promise<void> {
		await this.backend.write(removeSessionBindings(await this.backend.read(), sessionId));
	}

	async prune(liveSessionIds: ReadonlySet<string>): Promise<void> {
		const before = await this.backend.read();
		const after = pruneBindings(before, liveSessionIds);
		if (after.length !== before.length) await this.backend.write(after);
	}

	async forKey(key: string): Promise<AnchorBinding[]> {
		return bindingsForKey(await this.backend.read(), key);
	}

	async forUrl(url: string): Promise<AnchorBinding[]> {
		const key = pageKey(url);
		return key ? this.forKey(key) : [];
	}

	async forSession(sessionId: string): Promise<AnchorBinding[]> {
		return bindingsForSession(await this.backend.read(), sessionId);
	}
}

/** chrome.storage.local backend (shared by the side panel and the background worker). */
export function chromeLocalBackend(): AnchorsBackend {
	return {
		async read() {
			const data = await chrome.storage.local.get(ANCHORS_STORAGE_KEY);
			const raw = data[ANCHORS_STORAGE_KEY];
			return Array.isArray(raw) ? raw.filter(isAnchorBinding) : [];
		},
		async write(list) {
			await chrome.storage.local.set({ [ANCHORS_STORAGE_KEY]: list });
		},
	};
}
