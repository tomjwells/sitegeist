/**
 * Where a real side panel is: a chat, or a new chat and its agent (Tom, 2026-11-10: "It opens a new tab successfully,
 * but then loads a new sitegeist session").
 *
 * Edge 156 reloads the side panel at its start address ("sidepanel.html") on every tab switch while the panel's
 * address is anything else, such as "sidepanel.html?session=…" (measured in Edge 156.0.4314.50; Edge 157 and Chrome
 * do not). The reloaded panel opened the most recently changed chat, or a blank one when another window held that
 * chat, and an agent's browser call in flight got no answer. So a real side panel keeps its address bare, which
 * Edge 156 leaves alone, and keeps its place here, in the panel's own sessionStorage. A panel the browser reloads
 * anyway goes back to that place. sessionStorage belongs to one panel and ends with it.
 */

export const PANEL_PLACE_KEY = "sg.panelPlace";
/** A panel that starts later than this after the last one left is a newly opened panel, not a reload. */
export const RELOAD_WINDOW_MS = 5_000;

export interface PanelPlace {
	/** The open chat. Absent: a new chat. */
	session?: string;
	/** The agent picked for a new chat. Absent: not picked yet. */
	agent?: string;
	/** When the panel's document last went away (pagehide). Absent: it is still there, or it died without saying. */
	leftAt?: number;
}

const SESSION_RE = /^[A-Za-z0-9_.:-]{1,150}$/;
const AGENT_RE = /^[a-z0-9]{1,40}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The stored place, or undefined when there is none or it is not one. */
export function parsePanelPlace(raw: string | null): PanelPlace | undefined {
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const place: PanelPlace = {};
	if (typeof parsed.session === "string" && SESSION_RE.test(parsed.session)) place.session = parsed.session;
	if (typeof parsed.agent === "string" && AGENT_RE.test(parsed.agent)) place.agent = parsed.agent;
	if (typeof parsed.leftAt === "number" && Number.isFinite(parsed.leftAt)) place.leftAt = parsed.leftAt;
	return place;
}

/** The place as the panel's address query. */
export function placeQuery(place: PanelPlace): string {
	if (place.session) return `?session=${encodeURIComponent(place.session)}`;
	return place.agent ? `?new=true&agent=${encodeURIComponent(place.agent)}` : "?new=true";
}

export function samePlace(a: PanelPlace | undefined, b: PanelPlace): boolean {
	return a !== undefined && a.session === b.session && a.agent === b.agent && a.leftAt === b.leftAt;
}

/**
 * The query to go back to, when this start is the browser reloading a living panel: the address is the bare start
 * address, a place is stored, and the last document left a moment ago (or never said it left: a crash). A panel
 * opened some time after the last one closed gets undefined and starts the usual way.
 */
export function queryToRestore(
	search: string,
	hash: string,
	saved: PanelPlace | undefined,
	now: number,
): string | undefined {
	if (search !== "" || hash !== "" || !saved) return undefined;
	if (saved.leftAt !== undefined && now - saved.leftAt > RELOAD_WINDOW_MS) return undefined;
	return placeQuery(saved);
}
