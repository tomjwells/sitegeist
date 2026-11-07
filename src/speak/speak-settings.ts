import { getSitegeistStorage } from "../storage/app-storage.js";
import { DEFAULT_SPEAK_URL } from "./speak-client.js";

/** Settings → Read aloud. Stored in the panel's settings store; cached here so a click never waits on storage. */
export const SPEAK_URL_SETTING = "speak.url";
export const SPEAK_ENABLED_SETTING = "speak.enabled";

export interface SpeakSettings {
	url: string;
	enabled: boolean;
}

let current: SpeakSettings = { url: DEFAULT_SPEAK_URL, enabled: true };
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
	set({ url: url || DEFAULT_SPEAK_URL, enabled });
	return current;
}

export async function saveSpeakSettings(patch: Partial<SpeakSettings>): Promise<void> {
	const settings = getSitegeistStorage().settings;
	const next = { ...current, ...patch };
	next.url = next.url.trim() || DEFAULT_SPEAK_URL;
	if (patch.url !== undefined) await settings.set(SPEAK_URL_SETTING, next.url);
	if (patch.enabled !== undefined) await settings.set(SPEAK_ENABLED_SETTING, next.enabled);
	set(next);
}
