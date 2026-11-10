/**
 * What the panel keeps in the browser for an R730 chat. The R730 holds the chat; the browser copy only paints the
 * chat at once on open (before the R730 has answered) and keeps messages that never left the browser.
 *
 * 2026-11-09: Tom pasted four 4 MB screenshots into one Quant Coach chat. The stored record grew to 90 MB (each
 * screenshot three times: message content, attachment tile `content` and `preview`; every tool-result image twice),
 * and it was written again on every streamed event. His laptop's CPU went to 100 C, programs crashed, and Zen's
 * extension process crashed each time the chat was opened again. So:
 *  - an image over STORED_IMAGE_MAX_CHARS is not kept (a short note takes its place until the R730 copy loads);
 *  - attachment tiles that carry such data are not kept (their names are);
 *  - the second copy of a tool-result image (details.attachments[].data) is not kept.
 * A message the R730 does not have yet (sending, failed, queued) is kept whole: a retry needs its files. The caller
 * says which those are (`keepWhole`; the panel passes isUnsent/isQueued from send-state.ts), so this file has no
 * imports and is unit-tested with node --test (tests/stored-messages.test.ts).
 *
 * 2026-11-10 (stage 5 of "chats stored remotely"): the copy is the last screen of the chat, not the chat.
 *  - only the last STORED_MESSAGES_MAX messages are kept (plus every message that never left the browser); a short
 *    note stands first in their place;
 *  - artifact messages (files the agent sent) are kept up to STORED_ARTIFACT_MAX_CHARS of content in all, newest
 *    first: those are what the artifacts panel is rebuilt from at once; anything beyond comes back from the R730's
 *    copies on open (sidepanel.ts onArtifactsReconcile; the R730 keeps the last 40 per chat);
 *  - a tool result's text over STORED_TOOL_TEXT_MAX_CHARS is cut.
 * The R730's copy replaces all of this as soon as the chat has loaded.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Base64 chars, about 48 KiB of image bytes: icons and thumbnails stay, screenshots and photos do not. A chat with
 * a hundred tool screenshots (150-250 KiB each) would otherwise still be a 25 MB record.
 */
export const STORED_IMAGE_MAX_CHARS = 64_000;
/** Written into the chat's list entry (`sgStored`) by a save that used slimForStorage. */
export const STORED_FORMAT = 2;
/** Messages kept in the browser's copy of an R730 chat (the last ones), beyond those that never left the browser. */
export const STORED_MESSAGES_MAX = 80;
/** A tool result's text is cut here in the browser's copy (a long `ls`, a page read). */
export const STORED_TOOL_TEXT_MAX_CHARS = 20_000;
/** Artifact content kept in the browser's copy, in all (newest first); the R730's copies cover the rest. */
export const STORED_ARTIFACT_MAX_CHARS = 2 * 1024 * 1024;

/** Was this chat's record written in the slim form? A record without the mark may be very large: do not read it. */
export const isStoredSlim = (metadata: object): boolean =>
	"sgStored" in metadata && metadata.sgStored === STORED_FORMAT;

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const kib = (base64Chars: number): number => Math.max(1, Math.round((base64Chars * 0.75) / 1024));
const tooBig = (v: unknown): v is string => typeof v === "string" && v.length > STORED_IMAGE_MAX_CHARS;
const isImage = (c: unknown): c is Fields & { data: string } =>
	isFields(c) && c.type === "image" && typeof c.data === "string";

function slimMessage(message: AgentMessage): AgentMessage {
	const m: Fields = Object.fromEntries(Object.entries(message));
	let changed = false;
	const notes: string[] = [];

	// Attachment tiles (kept from the bubble Tom sent): `content` and `preview` are the full file again.
	if (
		Array.isArray(m.attachments) &&
		m.attachments.some((a) => isFields(a) && (tooBig(a.content) || tooBig(a.preview)))
	) {
		const names = m.attachments
			.filter(isFields)
			.map(
				(a) =>
					`${typeof a.fileName === "string" ? a.fileName : "file"} (${typeof a.size === "number" ? Math.max(1, Math.round(a.size / 1024)) : "?"} KiB)`,
			);
		notes.push(`Attached: ${names.join(", ")}`);
		delete m.attachments;
		changed = true;
	}

	if (m.role === "toolResult" && Array.isArray(m.content)) {
		let cut = 0;
		m.content = m.content.map((c: unknown) => {
			if (
				!isFields(c) ||
				c.type !== "text" ||
				typeof c.text !== "string" ||
				c.text.length <= STORED_TOOL_TEXT_MAX_CHARS
			)
				return c;
			cut += c.text.length - STORED_TOOL_TEXT_MAX_CHARS;
			return {
				...c,
				text: `${c.text.slice(0, STORED_TOOL_TEXT_MAX_CHARS)}\n[… ${kib(c.text.length * (4 / 3))} KiB of output: shown when the chat has loaded from the R730]`,
			};
		});
		if (cut > 0) {
			changed = true;
			// The second copy of the output (details.stdout / details.output) is not kept either.
			if (isFields(m.details)) {
				const details = { ...m.details };
				for (const k of ["stdout", "output", "stderr"])
					if (typeof details[k] === "string" && details[k].length > STORED_TOOL_TEXT_MAX_CHARS)
						details[k] = `${details[k].slice(0, STORED_TOOL_TEXT_MAX_CHARS)}…`;
				m.details = details;
			}
		}
	}
	if (Array.isArray(m.content)) {
		const inContent = new Set(m.content.filter(isImage).map((c) => c.data));
		// Tool results carry each image a second time in details.attachments[].data (the same string).
		if (inContent.size > 0 && isFields(m.details) && Array.isArray(m.details.attachments)) {
			let dropped = false;
			const attachments = m.details.attachments.map((a: unknown) => {
				if (!isFields(a) || typeof a.data !== "string" || !inContent.has(a.data)) return a;
				dropped = true;
				return { ...Object.fromEntries(Object.entries(a).filter(([k]) => k !== "data")), dataInContent: true };
			});
			if (dropped) {
				m.details = { ...m.details, attachments };
				changed = true;
			}
		}
		if (m.content.some((c) => isImage(c) && tooBig(c.data))) {
			m.content = m.content.map((c: unknown) =>
				isImage(c) && tooBig(c.data)
					? {
							type: "text",
							text: `[image, ${kib(c.data.length)} KiB: shown when the chat has loaded from the R730]`,
						}
					: c,
			);
			changed = true;
		}
		if (notes.length > 0)
			m.content = [...(Array.isArray(m.content) ? m.content : []), { type: "text", text: notes.join("\n") }];
	} else if (notes.length > 0 && typeof m.content === "string") {
		m.content = `${m.content}\n\n${notes.join("\n")}`;
	}
	if (!changed) return message;
	return m as AgentMessage; // the same message: only oversized image data was replaced by short text
}

/** The messages as the browser keeps them (see the file comment). The same array when nothing had to change. */
export function slimForStorage(
	messages: AgentMessage[],
	keepWhole: (message: AgentMessage) => boolean,
): AgentMessage[] {
	let changed = false;
	// Artifacts are kept apart from the message window: up to STORED_ARTIFACT_MAX_CHARS of content, newest first.
	let artifactChars = 0;
	const keptArtifacts = new Set<AgentMessage>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "artifact") continue;
		const size =
			typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content.length : 0;
		if (artifactChars + size > STORED_ARTIFACT_MAX_CHARS && keptArtifacts.size > 0) break;
		artifactChars += size;
		keptArtifacts.add(m);
	}
	const artifactsTotal = messages.filter((m) => m.role === "artifact").length;
	if (keptArtifacts.size !== artifactsTotal) changed = true;
	// Of the rest, only the last STORED_MESSAGES_MAX, plus every message that never left the browser.
	const shared = messages.filter((m) => m.role !== "artifact");
	const limit = shared.length - STORED_MESSAGES_MAX;
	const keptShared = new Set<AgentMessage>(limit > 0 ? shared.filter((m, i) => i >= limit || keepWhole(m)) : shared);
	const dropped = shared.length - keptShared.size;
	const kept = messages.filter((m) => keptShared.has(m) || keptArtifacts.has(m));
	const out = kept.map((message) => {
		const slim = keepWhole(message) ? message : slimMessage(message);
		if (slim !== message) changed = true;
		return slim;
	});
	if (dropped > 0) {
		changed = true;
		out.unshift({
			role: "user",
			content: `[${dropped} earlier message${dropped === 1 ? "" : "s"}: shown when the chat has loaded from the R730]`,
			timestamp: 0,
		} as AgentMessage);
	}
	return changed ? out : messages;
}
