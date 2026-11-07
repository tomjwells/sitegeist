import { chunkMarkdown } from "./chunk.js";
import { messageKey } from "./message-key.js";
import { errorNote, fetchVoices, pickVoice, SpeakError, synthesize } from "./speak-client.js";

/**
 * The read-aloud player (Tom, 2026-11-07). One audio element for the whole panel, so only one message plays at a
 * time. A message is split into chunks (chunk.ts); chunk 1 plays as soon as it arrives and the next two chunks are
 * fetched, one after another, while the current one plays. Every fetched chunk stays in memory per voice + message, so a replay is instant (the
 * newest 40 messages are kept). A failed request is not retried: the button shows a short note and the next click
 * tries again. Requests still running when Tom stops are left to finish, so they land in the cache. Never logs the
 * message text.
 */

export type SpeakPhase = "idle" | "loading" | "playing";

interface Entry {
	chunks: string[];
	/** Blob = audio; "skip" = speak said there is nothing to read in this chunk (422, e.g. a code block). */
	audio: Array<Blob | "skip" | undefined>;
	urls: Array<string | undefined>;
}

interface Run {
	id: number;
	key: string;
	/** Chunk requests of this run that failed: not tried again in this run. */
	failed: Map<number, unknown>;
}

export interface SpeakStatus {
	phase: SpeakPhase;
	message: string | null;
	chunkIndex: number;
	chunkCount: number;
	played: number[];
	fetched: number[];
	currentTime: number;
	duration: number;
	paused: boolean;
	cachedMessages: number;
	lastNote: string | null;
}

const MAX_ENTRIES = 40;
/** Chunks requested ahead of the one playing (see fetchAhead). */
const LOOKAHEAD = 2;
const VOICES_FRESH_MS = 10 * 60_000;
const NOTE_MS = 10_000;

export class SpeakPlayer extends EventTarget {
	private audio: HTMLAudioElement | undefined;
	private readonly entries = new Map<string, Entry>();
	private readonly inflight = new Map<string, Promise<Blob | "skip">>();
	private readonly attached = new Map<string, number>();
	private readonly notes = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
	private run: Run | undefined;
	private runSeq = 0;
	private phase: SpeakPhase = "idle";
	private endWait: (() => void) | undefined;
	private voices: { url: string; names: string[]; at: number } | undefined;
	private trace = {
		chunkIndex: -1,
		chunkCount: 0,
		played: [] as number[],
		fetched: [] as number[],
		lastNote: null as string | null,
	};

	private readonly config: () => { url: string; enabled: boolean };
	private readonly agent: () => string | null;

	constructor(config: () => { url: string; enabled: boolean }, agent: () => string | null) {
		super();
		this.config = config;
		this.agent = agent;
	}

	/** What the button for this message shows. */
	view(key: string): { phase: SpeakPhase; note: string | undefined } {
		return { phase: this.run?.key === key ? this.phase : "idle", note: this.notes.get(key)?.text };
	}

	/** Click: start this message (stopping any other), or stop it if it is the one playing/loading. */
	toggle(text: string): void {
		const key = messageKey(text);
		if (this.run?.key === key) this.stop();
		else void this.play(text, key);
	}

	stop(): void {
		if (!this.run) return;
		this.run = undefined;
		this.audio?.pause();
		const wait = this.endWait;
		this.endWait = undefined;
		wait?.();
		this.setPhase("idle");
	}

	/** A button for this message mounted / unmounted. When the last one goes (chat switched), playback stops. */
	attach(key: string): void {
		this.attached.set(key, (this.attached.get(key) ?? 0) + 1);
	}

	detach(key: string): void {
		const n = (this.attached.get(key) ?? 1) - 1;
		if (n > 0) this.attached.set(key, n);
		else this.attached.delete(key);
		setTimeout(() => {
			if (!this.attached.has(key) && this.run?.key === key) this.stop();
		}, 500);
	}

	/** Fetch the voice list ahead of the first click (panel start). Failures are ignored here. */
	async warm(): Promise<void> {
		const { url, enabled } = this.config();
		if (!enabled) return;
		try {
			await this.voiceFor(url);
		} catch {
			/* shown on click */
		}
	}

	status(): SpeakStatus {
		const a = this.audio;
		return {
			phase: this.phase,
			message: this.run?.key ?? null,
			chunkIndex: this.trace.chunkIndex,
			chunkCount: this.trace.chunkCount,
			played: [...this.trace.played],
			fetched: [...this.trace.fetched].sort((x, y) => x - y),
			currentTime: a ? Math.round(a.currentTime * 100) / 100 : 0,
			duration: a && Number.isFinite(a.duration) ? Math.round(a.duration * 100) / 100 : 0,
			paused: a ? a.paused : true,
			cachedMessages: this.entries.size,
			lastNote: this.trace.lastNote,
		};
	}

	private setPhase(phase: SpeakPhase): void {
		this.phase = phase;
		this.dispatchEvent(new Event("change"));
	}

	private showNote(key: string, text: string): void {
		const old = this.notes.get(key);
		if (old) clearTimeout(old.timer);
		this.trace.lastNote = text;
		const timer = setTimeout(() => {
			this.notes.delete(key);
			this.dispatchEvent(new Event("change"));
		}, NOTE_MS);
		this.notes.set(key, { text, timer });
		this.dispatchEvent(new Event("change"));
	}

	private clearNote(key: string): void {
		const old = this.notes.get(key);
		if (!old) return;
		clearTimeout(old.timer);
		this.notes.delete(key);
	}

	private async voiceFor(url: string): Promise<string> {
		const v = this.voices;
		if (!v || v.url !== url || Date.now() - v.at > VOICES_FRESH_MS) {
			try {
				this.voices = { url, names: await fetchVoices(url), at: Date.now() };
			} catch (err) {
				if (err instanceof SpeakError && err.kind === "offline") throw err; // speak is down: say so
				this.voices = { url, names: [], at: Date.now() }; // odd reply: use the default voice
			}
		}
		return pickVoice(this.agent(), this.voices?.names ?? []);
	}

	private entryFor(cacheKey: string, text: string): Entry {
		const entry = this.entries.get(cacheKey) ?? { chunks: chunkMarkdown(text), audio: [], urls: [] };
		this.entries.delete(cacheKey);
		this.entries.set(cacheKey, entry); // Map order = least recently used first
		while (this.entries.size > MAX_ENTRIES) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			const old = this.entries.get(oldest.value);
			for (const u of old?.urls ?? []) if (u) URL.revokeObjectURL(u);
			this.entries.delete(oldest.value);
		}
		return entry;
	}

	private chunkAudio(
		entry: Entry,
		cacheKey: string,
		run: Run,
		url: string,
		voice: string,
		i: number,
	): Promise<Blob | "skip"> {
		const have = entry.audio[i];
		if (have) return Promise.resolve(have);
		if (run.failed.has(i)) return Promise.reject(run.failed.get(i));
		const k = `${cacheKey}#${i}`;
		const pending = this.inflight.get(k);
		if (pending) return pending;
		const p = synthesize(url, entry.chunks[i] ?? "", voice)
			.then(
				(blob): Blob => {
					entry.audio[i] = blob;
					if (this.run === run) this.trace.fetched.push(i);
					return blob;
				},
				(err: unknown): "skip" => {
					if (err instanceof SpeakError && err.kind === "empty") {
						entry.audio[i] = "skip";
						return "skip";
					}
					run.failed.set(i, err);
					throw err;
				},
			)
			.finally(() => this.inflight.delete(k));
		this.inflight.set(k, p);
		return p;
	}

	/**
	 * Keep speak busy while chunk `playing` plays: request the next LOOKAHEAD chunks one after another (speak renders one
	 * at a time). Measured 2026-11-07 in Tom's Zen: with only the next chunk requested when the current one started, a
	 * long chunk 3 (65 s of audio, ~25 s to render) followed a short chunk 2 (15 s) with 10 s of silence; chunk 2 had
	 * been ready 12 s before it played. A failure stops the chain (no further requests) and shows when the play loop
	 * reaches that chunk; a stopped run starts no new request. Cached and in-flight chunks are not requested again.
	 */
	private fetchAhead(entry: Entry, cacheKey: string, run: Run, url: string, voice: string, playing: number): void {
		let chain: Promise<unknown> = Promise.resolve();
		for (let j = playing + 1; j <= playing + LOOKAHEAD && j < entry.chunks.length; j++) {
			chain = chain.then(() =>
				this.run === run ? this.chunkAudio(entry, cacheKey, run, url, voice, j) : undefined,
			);
		}
		chain.catch(() => undefined);
	}

	private playBlob(entry: Entry, i: number, blob: Blob, run: Run): Promise<void> {
		const src = entry.urls[i] ?? URL.createObjectURL(blob);
		entry.urls[i] = src;
		if (!this.audio) this.audio = new Audio();
		const audio = this.audio;
		return new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				audio.removeEventListener("ended", done);
				audio.removeEventListener("error", fail);
				if (this.endWait === done) this.endWait = undefined;
			};
			const done = () => {
				cleanup();
				resolve();
			};
			const fail = () => {
				cleanup();
				reject(new SpeakError(0, "error", "playback failed"));
			};
			audio.addEventListener("ended", done);
			audio.addEventListener("error", fail);
			this.endWait = done;
			audio.src = src;
			this.trace.chunkIndex = i;
			audio.play().then(
				() => {
					if (this.run !== run) return;
					this.trace.played.push(i);
					this.setPhase("playing");
				},
				(err: unknown) => {
					cleanup();
					const blocked = err instanceof DOMException && err.name === "NotAllowedError";
					reject(new SpeakError(0, "error", blocked ? "autoplay blocked" : "playback failed"));
				},
			);
		});
	}

	private async play(text: string, key: string): Promise<void> {
		this.stop();
		const run: Run = { id: ++this.runSeq, key, failed: new Map() };
		this.run = run;
		this.clearNote(key);
		this.trace = { chunkIndex: -1, chunkCount: 0, played: [], fetched: [], lastNote: null };
		this.setPhase("loading");
		try {
			const { url } = this.config();
			const voice = await this.voiceFor(url);
			if (this.run !== run) return;
			const cacheKey = `${voice}\u0000${key}`;
			const entry = this.entryFor(cacheKey, text);
			this.trace.chunkCount = entry.chunks.length;
			this.trace.fetched = entry.audio.flatMap((a, n) => (a ? [n] : []));
			let playedAny = false;
			for (let i = 0; i < entry.chunks.length; i++) {
				if (!entry.audio[i]) this.setPhase("loading");
				const got = await this.chunkAudio(entry, cacheKey, run, url, voice, i);
				if (this.run !== run) return;
				if (got === "skip") continue;
				this.fetchAhead(entry, cacheKey, run, url, voice, i);
				await this.playBlob(entry, i, got, run);
				playedAny = true;
				if (this.run !== run) return;
			}
			if (!playedAny) throw new SpeakError(422, "empty", "nothing to read");
		} catch (err) {
			if (this.run !== run) return; // stopped, or another message started
			const e =
				err instanceof SpeakError ? err : new SpeakError(0, "error", err instanceof Error ? err.name : "error");
			this.showNote(key, e.message === "autoplay blocked" ? "click again to play (autoplay blocked)" : errorNote(e));
			console.warn("[speak] failed:", e.status, e.kind, e.message);
		} finally {
			if (this.run === run) {
				this.run = undefined;
				this.setPhase("idle");
			}
		}
	}
}
