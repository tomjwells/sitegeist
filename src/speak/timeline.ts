/**
 * The read-aloud timeline (Tom, 2026-11-09: "scrollable position, ability to adjust playback speed"). An answer is
 * played as several clips, one per chunk. The player bar shows them as one timeline: a clip's real length once speak
 * has rendered it, an estimate from its text until then (chunk.ts ESTIMATED_CHARS_PER_SECOND).
 */

/** Same speeds as the YouTube summaries player. Speed is the browser's playbackRate; speak renders at 1x only. */
export const SPEAK_RATES: readonly number[] = [1, 1.25, 1.5, 1.75, 2, 2.5];
/** speak's voice is slow (~89 words/min at 1x); 1.75x is about normal talking pace. */
export const DEFAULT_SPEAK_RATE = 1.75;

export function validRate(value: unknown): number {
	return typeof value === "number" && SPEAK_RATES.includes(value) ? value : DEFAULT_SPEAK_RATE;
}

/** Map a position on the whole timeline to a clip and an offset inside it. */
export function locateInParts(durations: readonly number[], seconds: number): { part: number; offset: number } {
	let start = 0;
	let lastPlayable = -1;
	for (let part = 0; part < durations.length; part++) {
		const length = durations[part] ?? 0;
		if (length <= 0) continue; // nothing to read in this clip
		lastPlayable = part;
		if (seconds < start + length) {
			return { part, offset: Math.max(0, seconds - start) };
		}
		start += length;
	}
	if (lastPlayable < 0) return { part: 0, offset: 0 };
	// At or past the end: just before the end of the last clip (landing exactly on its end would skip it at once).
	return { part: lastPlayable, offset: Math.max(0, (durations[lastPlayable] ?? 0) - 0.25) };
}

export function clock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
