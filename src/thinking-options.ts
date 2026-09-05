import type { Model } from "@mariozechner/pi-ai";
import { supportsXhigh } from "./models-registry.js";
import { PRIME_PROVIDER } from "./prime/constants.js";

/** Canonical ladder (pi-ai EXTENDED_THINKING_LEVELS order). */
const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LABELS: Record<string, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};

export interface ThinkingOption {
	value: string;
	label: string;
}

/**
 * Options for the composer's thinking selector (wired into pi-web-ui's MessageEditor by scripts/build.mjs).
 * - prime-agent sessions: exactly the levels the R730 harness offers for that model (see harnessLevels).
 * - Browser agent: pi-ai's ladder, plus XHigh where the model supports it. `max` is never offered here
 *   because the in-browser pi-ai has no budget for it.
 * The current level is always included so the control never shows an empty placeholder.
 */
/**
 * Same rule the R730 harness uses (pi-ai `getSupportedThinkingLevels`): a level mapped to null is
 * removed, xhigh/max exist only when the model maps them, everything else on the ladder is offered.
 * Fable 5.1 (map off:null, xhigh, max) → minimal / low / medium / high / xhigh / max — what the TUI shows.
 */
function harnessLevels(model: Model<any>): string[] {
	if (!model.reasoning) return ["off"];
	const levelMap = (model as { thinkingLevelMap?: Record<string, unknown> }).thinkingLevelMap ?? {};
	return ORDER.filter((level) => {
		const mapped = levelMap[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function thinkingOptionsFor(model: Model<any> | null | undefined, current?: string): ThinkingOption[] {
	let values: string[];
	if (model?.provider === PRIME_PROVIDER) {
		values = harnessLevels(model);
	} else {
		values = ["off", "minimal", "low", "medium", "high"];
		if (model && supportsXhigh(model)) values.push("xhigh");
	}
	if (current && !values.includes(current)) values.push(current);
	const rank = (v: string) => {
		const i = (ORDER as readonly string[]).indexOf(v);
		return i === -1 ? ORDER.length : i;
	};
	return [...new Set(values)]
		.sort((a, b) => rank(a) - rank(b))
		.map((value) => ({ value, label: LABELS[value] ?? value }));
}
