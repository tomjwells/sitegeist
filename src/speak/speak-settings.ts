import { getSitegeistStorage } from "../storage/app-storage.js";
import { DEFAULT_SPEAK_URL } from "./speak-client.js";
import { DEFAULT_SPEAK_RATE, validRate } from "./timeline.js";

/** Settings → Read aloud. Stored in the panel's settings store; cached here so a click never waits on storage. */
export const SPEAK_URL_SETTING = "speak.url";
export const SPEAK_ENABLED_SETTING = "speak.enabled";
/** Playback speed chosen in the player bar; remembered across chats and restarts. */
export const SPEAK_RATE_SETTING = "speak.rate";

export interface SpeakSettings {
	url: string;
	enabled: boolean;
	rate: number;
}

let current: SpeakSettings = { url: DEFAULT_SPEAK_URL, enabled: true, rate: DEFAULT_SPEAK_RATE };
const listeners = new Set<() => void>();

export function speakSettings(): SpeakSettings {
	return current;
}

export function onSpeakSettingsChanged(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function set(next: SpeakSettings): void {
	current = next;
	for (const fn of listeners) fn();
}

export async function loadSpeakSettings(): Promise<SpeakSettings> {
	const settings = getSitegeistStorage().settings;
	const url = (await settings.get<string>(SPEAK_URL_SETTING))?.trim();
	const enabled = (await settings.get<boolean>(SPEAK_ENABLED_SETTING)) !== false;
	const rate = validRate(await settings.get<number>(SPEAK_RATE_SETTING));
	set({ url: url || DEFAULT_SPEAK_URL, enabled, rate });
	return current;
}

export async function saveSpeakSettings(patch: Partial<SpeakSettings>): Promise<void> {
	const settings = getSitegeistStorage().settings;
	const next = { ...current, ...patch };
	next.url = next.url.trim() || DEFAULT_SPEAK_URL;
	next.rate = validRate(next.rate);
	if (patch.url !== undefined) await settings.set(SPEAK_URL_SETTING, next.url);
	if (patch.enabled !== undefined) await settings.set(SPEAK_ENABLED_SETTING, next.enabled);
	if (patch.rate !== undefined) await settings.set(SPEAK_RATE_SETTING, next.rate);
	set(next);
}
