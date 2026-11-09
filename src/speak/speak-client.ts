import { z } from "zod";

/**
 * speak HTTP client (main-pi's TTS service, Agent Wiki shared -> "speak — text-to-speech service"). Every JSON reply
 * is validated with zod; audio comes back as bytes. Every request is bounded. Never logs or echoes the text.
 */

export const DEFAULT_SPEAK_URL = "http://speak.tjwpier:8610";
export const FALLBACK_VOICE = "main-pi";
/** One chunk: up to ~4,000 characters at ~2.5x real time, plus 4-18 s when the model has to load first. */
const SPEECH_TIMEOUT_MS = 180_000;
const SMALL_TIMEOUT_MS = 6_000;

const VoiceSchema = z.object({ name: z.string().min(1), locked: z.boolean().optional() });
export const VoicesSchema = z.object({ voices: z.array(VoiceSchema), attribution: z.string().optional() });
export const ErrorSchema = z.object({ error: z.object({ message: z.string(), type: z.string().optional() }) });
export const HealthSchema = z.object({ ok: z.boolean() });

export type SpeakErrorKind = "offline" | "too-long" | "empty" | "voice" | "error";

export class SpeakError extends Error {
	readonly status: number;
	readonly kind: SpeakErrorKind;
	constructor(status: number, kind: SpeakErrorKind, message: string) {
		super(message);
		this.name = "SpeakError";
		this.status = status;
		this.kind = kind;
	}
}

/** Short note for the button. 0 = no answer at all (network error / timeout), treated like 503. */
export function errorNote(err: SpeakError): string {
	switch (err.kind) {
		case "offline":
			return "speak is offline (M4 asleep?)";
		case "too-long":
			return "too long for speak";
		case "voice":
			return "speak: unknown voice";
		case "empty":
			return "nothing to read aloud";
		default:
			return `speak error ${err.status || ""}`.trim();
	}
}

function kindFor(status: number): SpeakErrorKind {
	if (status === 0 || status === 503) return "offline";
	if (status === 413) return "too-long";
	if (status === 422) return "empty";
	if (status === 404) return "voice";
	return "error";
}

function base(url: string): string {
	return url.trim().replace(/\/+$/, "") || DEFAULT_SPEAK_URL;
}

/** fetch with a deadline, combined with the caller's abort signal. Network failure / timeout -> SpeakError(0). */
async function boundedFetch(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Response> {
	const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
	try {
		return await fetch(url, { ...init, signal: AbortSignal.any(signals) });
	} catch (err) {
		if (signal?.aborted) throw err; // the caller stopped: not an error to show
		throw new SpeakError(
			0,
			"offline",
			err instanceof Error && err.name === "TimeoutError" ? "timeout" : "unreachable",
		);
	}
}

async function failure(res: Response): Promise<SpeakError> {
	let message = res.statusText || `HTTP ${res.status}`;
	try {
		const parsed = ErrorSchema.safeParse(await res.json());
		if (parsed.success) message = parsed.data.error.type ?? parsed.data.error.message;
	} catch {
		/* not JSON */
	}
	return new SpeakError(res.status, kindFor(res.status), message.slice(0, 120));
}

export async function fetchVoices(url: string, signal?: AbortSignal): Promise<string[]> {
	const res = await boundedFetch(`${base(url)}/v1/voices`, {}, SMALL_TIMEOUT_MS, signal);
	if (!res.ok) throw await failure(res);
	const parsed = VoicesSchema.safeParse(await res.json());
	if (!parsed.success) throw new SpeakError(res.status, "error", "bad /v1/voices reply");
	return parsed.data.voices.map((v) => v.name);
}

export async function fetchHealth(url: string, signal?: AbortSignal): Promise<boolean> {
	const res = await boundedFetch(`${base(url)}/health`, {}, SMALL_TIMEOUT_MS, signal);
	if (!res.ok) return false;
	const parsed = HealthSchema.safeParse(await res.json());
	return parsed.success && parsed.data.ok;
}

export interface Clip {
	blob: Blob;
	/** Length of the audio from speak's x-speak-audio-seconds header; null when the header is missing. */
	seconds: number | null;
}

/** One chunk of Markdown -> mp3. prepare:true: the server turns Markdown into speakable text. */
export async function synthesize(url: string, input: string, voice: string, signal?: AbortSignal): Promise<Clip> {
	const res = await boundedFetch(
		`${base(url)}/v1/audio/speech`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input, voice, prepare: true, response_format: "mp3" }),
		},
		SPEECH_TIMEOUT_MS,
		signal,
	);
	if (!res.ok) throw await failure(res);
	const blob = await res.blob();
	if (blob.size === 0) throw new SpeakError(res.status, "error", "empty audio");
	const seconds = Number(res.headers.get("x-speak-audio-seconds"));
	return {
		blob: blob.type ? blob : new Blob([blob], { type: "audio/mpeg" }),
		seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
	};
}

/**
 * The voice for an agent: its own name when speak has a voice by that name, else main-pi. main-pi's panel id is
 * "prime" (MAIN_AGENT_ID), so it maps to "main-pi".
 */
export function pickVoice(agentId: string | null | undefined, voices: readonly string[]): string {
	const name = !agentId || agentId === "prime" ? FALLBACK_VOICE : agentId;
	return voices.includes(name) ? name : FALLBACK_VOICE;
}
