/** Provider label shown for prime-agent sessions; also lets the UI's per-provider API-key gate through. */
export const PRIME_PROVIDER = "prime";
/** Bridge session ids created from the browser; the same id is the sitegeist session id. */
export const PRIME_SESSION_PREFIX = "sg-";
export const isPrimeSessionId = (id: string | undefined | null): id is string =>
	typeof id === "string" && id.startsWith(PRIME_SESSION_PREFIX);
