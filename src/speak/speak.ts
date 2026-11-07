import { SpeakPlayer } from "./speak-player.js";
import { loadSpeakSettings, onSpeakSettingsChanged, speakSettings } from "./speak-settings.js";

/** The panel's one read-aloud player. sidepanel.ts tells it which agent the open chat belongs to (voice choice). */
let agentId: string | null = null;

export function setSpeakAgent(id: string | null): void {
	agentId = id;
}

export const speakPlayer = new SpeakPlayer(speakSettings, () => agentId);

onSpeakSettingsChanged(() => {
	if (!speakSettings().enabled) speakPlayer.stop();
	speakPlayer.dispatchEvent(new Event("change"));
});

/** Panel start: read the settings, then fetch the voice list so the first click does not wait for it. */
export async function initSpeak(): Promise<void> {
	try {
		await loadSpeakSettings();
	} catch (err) {
		console.warn("[speak] settings unavailable", err);
	}
	void speakPlayer.warm();
}
