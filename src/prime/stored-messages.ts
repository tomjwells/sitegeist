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
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Base64 chars, about 48 KiB of image bytes: icons and thumbnails stay, screenshots and photos do not. A chat with
 * a hundred tool screenshots (150-250 KiB each) would otherwise still be a 25 MB record.
 */
export const STORED_IMAGE_MAX_CHARS = 64_000;
/** Written into the chat's list entry (`sgStored`) by a save that used slimForStorage. */
export const STORED_FORMAT = 2;

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
	const out = messages.map((message) => {
		const slim = keepWhole(message) ? message : slimMessage(message);
		if (slim !== message) changed = true;
		return slim;
	});
	return changed ? out : messages;
}
