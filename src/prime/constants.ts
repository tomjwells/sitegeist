/** Provider label shown for remote-agent sessions; also lets the UI's per-provider API-key gate through. */
export const PRIME_PROVIDER = "prime";
/** Bridge session ids created from the browser; the same id is the sitegeist session id. */
export const PRIME_SESSION_PREFIX = "sg-";
export const isPrimeSessionId = (id: string | undefined | null): id is string =>
	typeof id === "string" && id.startsWith(PRIME_SESSION_PREFIX);
/** The relay's own agent id for main-pi (the original, un-suffixed session ids). */
export const MAIN_AGENT_ID = "prime";
/**
 * "sg-<hex>" → main-pi; "sg-<agentId>-<hex>" → that worker (the relay mints the ids this way). A chat on the pi
 * harness (2026-11-15) has "pi-" before the hex: "sg-pi-<hex>" (main-pi), "sg-<agentId>-pi-<hex>".
 */
export function agentIdFromSessionId(id: string): string {
	const m = /^sg-(?:(?!pi-)([a-z0-9]+)-)?(?:pi-)?[0-9a-f]{12}$/.exec(id);
	return m?.[1] ?? MAIN_AGENT_ID;
}

/** Where a chat runs: "pi" (duo can run there; new chats since 2026-11-15) or "prime" (older chats, Python cells). */
export type PrimeHarness = "pi" | "prime";
export function harnessFromSessionId(id: string): PrimeHarness {
	return /^sg-(?:[a-z0-9]+-)?pi-[0-9a-f]{12}$/.test(id) ? "pi" : "prime";
}

/** Duo-start (pi harness only): the model a new chat starts on (Tom, 2026-11-15). The session then reads "duo". */
export const DUO_PROVIDER = "anthropic";
export const DUO_MODEL_ID = "duo";
export const DUO_START_MODEL_ID = "duo-start";
