/** Provider label shown for remote-agent sessions; also lets the UI's per-provider API-key gate through. */
export const PRIME_PROVIDER = "prime";
/** Bridge session ids created from the browser; the same id is the sitegeist session id. */
export const PRIME_SESSION_PREFIX = "sg-";
export const isPrimeSessionId = (id: string | undefined | null): id is string =>
	typeof id === "string" && id.startsWith(PRIME_SESSION_PREFIX);
/** The relay's own agent id for main-pi (the original, un-suffixed session ids). */
export const MAIN_AGENT_ID = "prime";
/** "sg-<hex>" → main-pi; "sg-<agentId>-<hex>" → that worker (the relay mints the ids this way). */
export function agentIdFromSessionId(id: string): string {
	const m = /^sg-(?:([a-z0-9]+)-)?[0-9a-f]{12}$/.exec(id);
	return m?.[1] ?? MAIN_AGENT_ID;
}
