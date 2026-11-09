import { chunkMarkdown, ESTIMATED_CHARS_PER_SECOND, targetsForRate } from "./chunk.js";
import { messageKey } from "./message-key.js";
import { errorNote, fetchVoices, pickVoice, SpeakError, synthesize } from "./speak-client.js";
import { DEFAULT_SPEAK_RATE, locateInParts, validRate } from "./timeline.js";

/**
 * The read-aloud player (Tom, 2026-11-07). One audio element for the whole panel, so only one message plays at a
 * time. A message is split into chunks (chunk.ts); chunk 1 plays as soon as it arrives and the next two chunks are
 * fetched, one after another, while the current one plays. Every fetched chunk stays in memory per voice + message, so a replay is instant (the
 * newest 40 messages are kept). A failed request is not retried: the button shows a short note and the next click
 * tries again. Requests still running when Tom stops are left to finish, so they land in the cache. Never logs the
 * message text.
 *
 * Player controls (Tom, 2026-11-09: "as fully featured as in the youtube extension"): pause/resume, seek anywhere on
 * one timeline across all chunks (timeline.ts), skip, and playback speed. The player bar (components/SpeakBar.ts)
 * drives these; the "time" event fires when the position or the timeline's length changes, "change" when the phase
 * or a note changes. Seeking into a chunk that is not rendered yet shows the spinner and fetches it first.
 */

export type SpeakPhase = "idle" | "loading" | "playing" | "paused";

interface Entry {
	chunks: string[];
	/** Blob = audio; "skip" = speak said there is nothing to read in this chunk (422, e.g. a code block). */
	audio: Array<Blob | "skip" | undefined>;
	urls: Array<string | undefined>;
	/** Real length of each rendered chunk in seconds (speak's header, else the audio element's metadata). */
	seconds: Array<number | undefined>;
}

interface Source {
	entry: Entry;
	cacheKey: string;
	url: string;
	voice: string;
}

interface Run {
	id: number;
	key: string;
	/** Chunk requests of this run that failed: not tried again in this run. */
	failed: Map<number, unknown>;
	/** Set once the voice is known. */
	src: Source | undefined;
	playedAny: boolean;
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
	muted: boolean;
	/** Position and length on the whole-message timeline, in seconds of audio at 1x. */
	position: number;
	total: number;
	rate: number;
	playbackRate: number;
	cachedMessages: number;
	lastNote: string | null;
	/** What went wrong last, for diagnosis (e.g. "playback failed (NotSupportedError)"). Never message text. */
	lastError: string | null;
	/** The audio element's last events ("playing 2 @0.00" = event, chunk, currentTime), newest last. */
	events: string[];
}

/** What the player bar shows. */
export interface SpeakProgress {
	phase: SpeakPhase;
	position: number;
	total: number;
	rate: number;
}

const MAX_ENTRIES = 40;
/** Chunks requested ahead of the one playing (see fetchAhead). */
const LOOKAHEAD = 2;
const VOICES_FRESH_MS = 10 * 60_000;
const NOTE_MS = 10_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export class SpeakPlayer extends EventTarget {
	private audio: HTMLAudioElement | undefined;
	private readonly entries = new Map<string, Entry>();
	private readonly inflight = new Map<string, Promise<Blob | "skip">>();
	private readonly attached = new Map<string, number>();
	private readonly notes = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
	private run: Run | undefined;
	private runSeq = 0;
	private phase: SpeakPhase = "idle";
	private voices: { url: string; names: string[]; at: number } | undefined;
	private rate = DEFAULT_SPEAK_RATE;
	/** The chunk the player is on (playing, paused on, or waiting for). */
	private part = 0;
	/** Where in that chunk to start once its audio has loaded. */
	private pendingSeek = 0;
	/** Play as soon as the chunk has loaded (false = Tom paused while it was loading, or seeked while paused). */
	private wantPlay = true;
	/** True from a chunk switch until its audio is actually playing: pause events in between are not Tom's. */
	private switching = false;
	/** Bumped by every chunk switch, so an older switch still waiting for its audio gives way. */
	private switchSeq = 0;
	/** The chunk whose audio is in the audio element / whose metadata has loaded / that was counted as played. */
	private srcPart = -1;
	private loadedPart = -1;
	private startedPart = -1;
	private trace = {
		chunkIndex: -1,
		chunkCount: 0,
		played: [] as number[],
		fetched: [] as number[],
		lastNote: null as string | null,
		lastError: null as string | null,
	};

	private events: string[] = [];

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

	/** Click: start this message (stopping any other), or stop it if it is the one playing/loading/paused. */
	toggle(text: string): void {
		const key = messageKey(text);
		if (this.run?.key === key) this.stop();
		else void this.start(text, key);
	}

	stop(): void {
		if (!this.run) return;
		this.run = undefined;
		this.switchSeq++;
		this.switching = false;
		this.audio?.pause();
		this.setPhase("idle");
	}

	/** Pause, or carry on. While a chunk is still rendering, pause means "do not start when it arrives". */
	togglePause(): void {
		const run = this.run;
		if (!run) return;
		if (this.phase === "playing") {
			this.wantPlay = false;
			this.audio?.pause(); // the pause event sets the phase
		} else if (this.phase === "loading") {
			this.wantPlay = false;
			this.audio?.pause();
			this.setPhase("paused");
		} else if (this.phase === "paused") {
			this.wantPlay = true;
			this.setPhase("loading");
			if (this.srcPart === this.part) this.startAudio(run); // else the pending chunk switch starts it
		}
	}

	/** Jump to a position on the whole-message timeline (seconds at 1x). Keeps playing, or stays paused. */
	seekTo(seconds: number): void {
		const run = this.run;
		if (!run?.src || !Number.isFinite(seconds)) return;
		const durations = this.durations(run.src.entry);
		const { part, offset } = locateInParts(durations, Math.max(0, seconds));
		if (part === this.part) {
			if (this.loadedPart === part && this.audio) this.audio.currentTime = offset;
			else this.pendingSeek = offset;
			this.dispatchEvent(new Event("time"));
			return;
		}
		void this.playPart(run, part, offset);
	}

	/** Jump back (negative) or forward by this many seconds. */
	skip(seconds: number): void {
		this.seekTo(this.position() + seconds);
	}

	/** Playback speed, pitch kept. Applies at once and to every later chunk and message. */
	setRate(rate: number): void {
		const next = validRate(rate);
		if (next === this.rate) return;
		this.rate = next;
		this.applyRate();
		this.dispatchEvent(new Event("time"));
	}

	/** Diagnostic only (sitegeist_speak): play without sound, so playback can be checked in Tom's browser silently. */
	setMuted(muted: boolean): void {
		this.element().muted = muted;
	}

	/** Null when nothing is open (idle). */
	progress(): SpeakProgress | null {
		if (!this.run) return null;
		return { phase: this.phase, position: this.position(), total: this.total(), rate: this.rate };
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
			currentTime: a ? round2(a.currentTime) : 0,
			duration: a && Number.isFinite(a.duration) ? round2(a.duration) : 0,
			paused: a ? a.paused : true,
			muted: a ? a.muted : false,
			position: round2(this.position()),
			total: round2(this.total()),
			rate: this.rate,
			playbackRate: a ? a.playbackRate : this.rate,
			cachedMessages: this.entries.size,
			lastNote: this.trace.lastNote,
			lastError: this.trace.lastError,
			events: [...this.events],
		};
	}

	private setPhase(phase: SpeakPhase): void {
		this.phase = phase;
		this.dispatchEvent(new Event("change"));
	}

	/** Each chunk's length: 0 = nothing to read, real once rendered, else estimated from its text. */
	private durations(entry: Entry): number[] {
		return entry.chunks.map((chunk, i) =>
			entry.audio[i] === "skip" ? 0 : (entry.seconds[i] ?? chunk.length / ESTIMATED_CHARS_PER_SECOND),
		);
	}

	private total(): number {
		const entry = this.run?.src?.entry;
		return entry ? this.durations(entry).reduce((sum, d) => sum + d, 0) : 0;
	}

	private position(): number {
		const entry = this.run?.src?.entry;
		if (!entry) return 0;
		const before = this.durations(entry)
			.slice(0, this.part)
			.reduce((sum, d) => sum + d, 0);
		return before + (this.loadedPart === this.part && this.audio ? this.audio.currentTime : this.pendingSeek);
	}

	private applyRate(): void {
		const a = this.audio;
		if (!a) return;
		a.preservesPitch = true; // faster, not higher
		a.defaultPlaybackRate = this.rate;
		a.playbackRate = this.rate;
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
		// A new message is chunked for the speed it starts at; it keeps those chunks (and their audio) at any speed.
		const entry = this.entries.get(cacheKey) ?? {
			chunks: chunkMarkdown(text, targetsForRate(this.rate)),
			audio: [],
			urls: [],
			seconds: [],
		};
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
				(clip): Blob => {
					entry.audio[i] = clip.blob;
					if (clip.seconds !== null) entry.seconds[i] = clip.seconds;
					if (this.run === run) {
						this.trace.fetched.push(i);
						this.dispatchEvent(new Event("time")); // the timeline now has this clip's real length
					}
					return clip.blob;
				},
				(err: unknown): "skip" => {
					if (err instanceof SpeakError && err.kind === "empty") {
						entry.audio[i] = "skip";
						if (this.run === run) this.dispatchEvent(new Event("time"));
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

	/** The one audio element, with its listeners. They act on whatever run is current. */
	private element(): HTMLAudioElement {
		if (this.audio) return this.audio;
		const audio = new Audio();
		this.audio = audio;
		for (const type of [
			"loadstart",
			"loadedmetadata",
			"play",
			"playing",
			"pause",
			"seeked",
			"ended",
			"error",
			"abort",
		]) {
			audio.addEventListener(type, () => {
				this.events.push(`${type} ${this.part} @${audio.currentTime.toFixed(2)}`);
				if (this.events.length > 30) this.events.shift();
			});
		}
		audio.addEventListener("loadedmetadata", () => {
			const run = this.run;
			if (!run?.src || this.srcPart !== this.part) return;
			const seconds = run.src.entry.seconds;
			if (Number.isFinite(audio.duration) && seconds[this.part] === undefined) seconds[this.part] = audio.duration;
			if (this.pendingSeek > 0) {
				const end = Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.25) : this.pendingSeek;
				audio.currentTime = Math.min(this.pendingSeek, end);
			}
			this.pendingSeek = 0;
			this.loadedPart = this.part;
			this.applyRate(); // loading a new source resets playbackRate to the default
			this.dispatchEvent(new Event("time"));
		});
		audio.addEventListener("timeupdate", () => {
			if (this.run) this.dispatchEvent(new Event("time"));
		});
		audio.addEventListener("playing", () => {
			const run = this.run;
			if (!run) return;
			this.switching = false;
			if (this.startedPart !== this.part) {
				this.startedPart = this.part;
				this.trace.played.push(this.part);
				run.playedAny = true;
			}
			this.setPhase("playing");
		});
		audio.addEventListener("pause", () => {
			if (!this.run || this.switching || audio.ended) return;
			this.setPhase("paused");
		});
		audio.addEventListener("ended", () => {
			const run = this.run;
			if (run) void this.playPart(run, this.part + 1, 0);
		});
		audio.addEventListener("error", () => {
			const run = this.run;
			if (run && this.srcPart === this.part) {
				const detail = `${audio.error?.code ?? "?"} ${audio.error?.message ?? ""}`.trim().slice(0, 160);
				this.fail(run, new SpeakError(0, "error", `playback failed (media error ${detail})`));
			}
		});
		return audio;
	}

	private startAudio(run: Run): void {
		this.element()
			.play()
			.catch((err: unknown) => {
				if (this.run !== run) return;
				const name = err instanceof DOMException ? err.name : "";
				if (name === "AbortError") return; // interrupted by a pause or a chunk switch: not a failure
				this.fail(
					run,
					new SpeakError(
						0,
						"error",
						name === "NotAllowedError" ? "autoplay blocked" : `playback failed (play: ${name || "error"})`,
					),
				);
			});
	}

	/**
	 * Switch to a chunk and start it at `offset` (or leave it paused there). The current audio is silenced at once;
	 * the new chunk may still have to render. Chunks with nothing to read are passed over. Past the last chunk the
	 * message is finished.
	 */
	private async playPart(run: Run, part: number, offset: number): Promise<void> {
		const src = run.src;
		if (!src || this.run !== run) return;
		const seq = ++this.switchSeq;
		this.switching = true;
		this.audio?.pause();
		this.srcPart = -1;
		this.loadedPart = -1;
		this.startedPart = -1;
		let got: Blob | "skip" = "skip";
		let i = part;
		let at = offset;
		for (; ; i++, at = 0) {
			if (i >= src.entry.chunks.length) {
				if (run.playedAny) this.stop();
				else this.fail(run, new SpeakError(422, "empty", "nothing to read"));
				return;
			}
			this.part = i;
			this.pendingSeek = at;
			if (!src.entry.audio[i]) this.setPhase(this.wantPlay ? "loading" : "paused");
			this.dispatchEvent(new Event("time"));
			try {
				got = await this.chunkAudio(src.entry, src.cacheKey, run, src.url, src.voice, i);
			} catch (err) {
				if (this.run === run && seq === this.switchSeq) this.fail(run, err);
				return;
			}
			if (this.run !== run || seq !== this.switchSeq) return; // stopped, or a later seek took over
			if (got !== "skip") break;
		}
		this.fetchAhead(src.entry, src.cacheKey, run, src.url, src.voice, i);
		const url = src.entry.urls[i] ?? URL.createObjectURL(got);
		src.entry.urls[i] = url;
		const audio = this.element();
		audio.src = url;
		this.srcPart = i;
		this.trace.chunkIndex = i;
		this.applyRate();
		// Between two rendered chunks the phase stays "playing": no spinner flash at every chunk boundary.
		if (this.wantPlay) this.startAudio(run);
		else this.setPhase("paused");
	}

	private fail(run: Run, err: unknown): void {
		if (this.run !== run) return; // stopped, or another message started
		const e = err instanceof SpeakError ? err : new SpeakError(0, "error", err instanceof Error ? err.name : "error");
		console.warn("[speak] failed:", e.status, e.kind, e.message);
		this.stop();
		this.trace.lastError = `${e.status} ${e.kind}: ${e.message}`;
		this.showNote(
			run.key,
			e.message === "autoplay blocked" ? "click again to play (autoplay blocked)" : errorNote(e),
		);
	}

	private async start(text: string, key: string): Promise<void> {
		this.stop();
		const run: Run = { id: ++this.runSeq, key, failed: new Map(), src: undefined, playedAny: false };
		this.run = run;
		this.clearNote(key);
		this.trace = { chunkIndex: -1, chunkCount: 0, played: [], fetched: [], lastNote: null, lastError: null };
		this.part = 0;
		this.pendingSeek = 0;
		this.wantPlay = true;
		this.srcPart = -1;
		this.loadedPart = -1;
		this.startedPart = -1;
		this.setPhase("loading");
		try {
			const { url } = this.config();
			const voice = await this.voiceFor(url);
			if (this.run !== run) return;
			const cacheKey = `${voice}\u0000${key}`;
			const entry = this.entryFor(cacheKey, text);
			run.src = { entry, cacheKey, url, voice };
			this.trace.chunkCount = entry.chunks.length;
			this.trace.fetched = entry.audio.flatMap((a, n) => (a ? [n] : []));
			await this.playPart(run, 0, 0);
		} catch (err) {
			this.fail(run, err);
		}
	}
}
