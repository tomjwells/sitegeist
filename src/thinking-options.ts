import type { Model } from "@mariozechner/pi-ai";
import { supportsXhigh } from "./models-registry.js";
import { PRIME_PROVIDER } from "./prime/constants.js";

/** Canonical ladder; models that publish a thinkingLevelMap (e.g. Fable: off/xhigh/max) get exactly those rungs. */
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
 * - prime-agent sessions: the R730 harness applies the model's own thinkingLevelMap, so offer its keys
 *   (Fable → Off / XHigh / Max instead of a ladder the model does not have).
 * - Browser agent: pi-ai's ladder, plus XHigh where the model supports it. `max` is never offered here
 *   because the in-browser pi-ai has no budget for it.
 * The current level is always included so the control never shows an empty placeholder.
 */
export function thinkingOptionsFor(model: Model<any> | null | undefined, current?: string): ThinkingOption[] {
	const levelMap = (model as { thinkingLevelMap?: Record<string, unknown> } | null | undefined)?.thinkingLevelMap;
	let values: string[];
	if (model?.provider === PRIME_PROVIDER && levelMap && Object.keys(levelMap).length > 0) {
		values = Object.keys(levelMap);
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
