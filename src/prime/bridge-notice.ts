/**
 * Bridge notices: the R730 http-rpc-bridge writes `bridge_notice` events into a session's journal for things the
 * user should know that are not agent events, e.g. its dead-call watchdog (a model call that sent nothing back for
 * 30 s, or was still waiting when the model was switched, is aborted):
 *   { type: "bridge_notice", source: "http-rpc-bridge", kind: "dead_call", trigger: "timeout" | "model_switch",
 *     waitedMs, model, action: "abort+resume" | "abort", message: "<one human sentence>", timestamp: ISO }
 * The relay forwards journal events unchanged; PrimeRemoteAgent shows `message` as a toast. Only `type`,
 * `message` and `timestamp` matter here; the other fields are optional. Pure logic, unit-tested with node --test
 * (tests/bridge-notice.test.ts).
 */

/** Notices older than this are not shown: attach/reconnect can replay journal events from an older offset. */
export const BRIDGE_NOTICE_MAX_AGE_MS = 2 * 60_000;

export function isBridgeNotice(event: Record<string, unknown>): boolean {
	return event.type === "bridge_notice";
}

/**
 * The toast text for a bridge_notice event, or undefined when it should not be shown: not a notice, no message,
 * no parsable timestamp (ISO string or epoch ms), or older than BRIDGE_NOTICE_MAX_AGE_MS at `now`.
 */
export function bridgeNoticeToast(event: Record<string, unknown>, now: number): string | undefined {
	if (!isBridgeNotice(event)) return undefined;
	const message = event.message;
	if (typeof message !== "string" || message.trim() === "") return undefined;
	const at =
		typeof event.timestamp === "string"
			? Date.parse(event.timestamp)
			: typeof event.timestamp === "number"
				? event.timestamp
				: Number.NaN;
	if (!Number.isFinite(at) || now - at > BRIDGE_NOTICE_MAX_AGE_MS) return undefined;
	return message.trim();
}
