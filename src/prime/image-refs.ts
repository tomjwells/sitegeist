/**
 * Pictures of an R730 chat by link (Tom, 2026-11-10: "have chats stored remotely and not loaded locally").
 *
 * The relay sends a chat's history as text. A picture in it is a block
 *   { type: "image", mimeType, data: "", ref: { hash, bytes, mimeType, width, height, path } }
 * and the panel fetches `<sync url><path>[?w=<edge>]` when it draws it (src/prime/remote-image.ts). So a chat with
 * four 4 MB screenshots is a small download and a small record in the browser, and every browser shows the pictures
 * Tom sent, not only the one that sent them.
 *
 * This file has no imports and no browser calls: it is unit-tested with node --test (tests/image-refs.test.ts).
 */

export interface ImageRef {
	/** First 32 hex chars of the sha256 of the picture's bytes. */
	hash: string;
	bytes: number;
	mimeType: string;
	/** The relay's route for this picture, relative to the sync url: /agents/<agent>/sessions/<chat>/images/<hash>. */
	path: string;
	width?: number;
	height?: number;
}

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);

// The path is fetched with the relay token, and the history is written by an agent that reads web pages: only the
// relay's picture route is accepted, and it must name the block's own hash.
const IMAGE_PATH_RE = /^\/agents\/[a-z0-9]+\/sessions\/[A-Za-z0-9_.:%-]{1,200}\/images\/([a-f0-9]{32})$/;

/** The link of an image block, when it has a valid one. */
export function imageRefOf(block: unknown): ImageRef | undefined {
	if (!isFields(block) || block.type !== "image") return undefined;
	const r = block.ref;
	if (!isFields(r)) return undefined;
	const { hash, bytes, mimeType, path, width, height } = r;
	if (typeof hash !== "string" || typeof path !== "string" || typeof bytes !== "number") return undefined;
	if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) return undefined;
	if (IMAGE_PATH_RE.exec(path)?.[1] !== hash) return undefined;
	const size =
		typeof width === "number" && typeof height === "number" && width > 0 && height > 0 ? { width, height } : {};
	return { hash, bytes, mimeType, path, ...size };
}

/** Edges the relay makes smaller copies for (server.ts IMAGE_EDGES). */
export const IMAGE_EDGES = [256, 512, 960, 1280, 2000] as const;

/** The smallest copy that is still sharp when drawn `cssPixels` high or wide on this screen. */
export function edgeFor(cssPixels: number, devicePixelRatio = 1): number {
	const need = Math.ceil(cssPixels * Math.max(1, devicePixelRatio));
	return IMAGE_EDGES.find((e) => e >= need) ?? 2000;
}

/** Where to fetch the picture. Without `edge`: the stored file, as the agent has it. */
export function imageUrl(syncUrl: string, ref: ImageRef, edge?: number): string {
	return `${syncUrl.replace(/\/$/, "")}${ref.path}${edge ? `?w=${edge}` : ""}`;
}

/**
 * A message's content as text for "is this the same message?", with every picture reduced to "a picture": the same
 * message can arrive with a picture inline, as a preview or as a link (history against live events, old relay
 * against new).
 */
export function contentKey(content: unknown): string {
	if (!Array.isArray(content)) return JSON.stringify(content);
	return JSON.stringify(content.map((c: unknown) => (isFields(c) && c.type === "image" ? { type: "image" } : c)));
}

/** A picture to draw in a message: by link, or inline (a small one, or one that arrived live in this panel). */
export type DrawnImage = { kind: "link"; ref: ImageRef } | { kind: "inline"; src: string };

/** The pictures of a message's content, in order. An image block with neither a link nor data draws nothing. */
export function drawnImages(content: unknown): DrawnImage[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((c: unknown): DrawnImage[] => {
		if (!isFields(c) || c.type !== "image") return [];
		const ref = imageRefOf(c);
		if (ref) return [{ kind: "link", ref }];
		if (typeof c.data === "string" && c.data.length > 0 && typeof c.mimeType === "string")
			return [{ kind: "inline", src: `data:${c.mimeType};base64,${c.data}` }];
		return [];
	});
}

/**
 * The size of the box a picture is drawn in, so the page does not move when the picture arrives:
 * no taller than `maxHeightPx`, never larger than the picture itself.
 */
export function boxFor(ref: ImageRef, maxHeightPx: number): { width: number; height: number } | undefined {
	if (!ref.width || !ref.height) return undefined;
	const height = Math.min(maxHeightPx, ref.height);
	return { width: Math.max(1, Math.round((ref.width * height) / ref.height)), height };
}
