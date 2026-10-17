/**
 * Images on their way to a model are scaled to fit MODEL_IMAGE_MAX_SIDE (see src/utils/image-size.ts for why: one
 * oversized screenshot breaks every later turn of a chat once the chat holds many images). Browser side: decodes with
 * createImageBitmap, draws on an OffscreenCanvas, re-encodes (PNG stays PNG so text stays crisp, JPEG stays JPEG).
 * Images that already fit are returned as they are, without decoding (the size is read from the header). Every turn
 * re-sends the whole chat, so scaled results are cached by content hash.
 */
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";
import { fitSize, imageSizeFromBase64, MODEL_IMAGE_MAX_SIDE } from "./image-size.js";

export interface ImageFit {
	/** What the model gets: the original when it fits, else the scaled copy. */
	image: ImageContent;
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
	scaled: boolean;
}

const CACHE_MAX = 64;
const cache = new Map<string, Promise<ImageFit>>();

function base64Bytes(base64: string): Uint8Array<ArrayBuffer> {
	const comma = base64.startsWith("data:") ? base64.indexOf(",") : -1;
	const binary = atob(comma >= 0 ? base64.slice(comma + 1) : base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("");
}

const unchanged = (image: ImageContent, width: number, height: number): ImageFit => ({
	image,
	width,
	height,
	originalWidth: width,
	originalHeight: height,
	scaled: false,
});

async function scaleDown(image: ImageContent, bytes: Uint8Array<ArrayBuffer>): Promise<ImageFit> {
	const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }));
	try {
		const fit = fitSize(bitmap.width, bitmap.height);
		if (fit.scale >= 1) return unchanged(image, bitmap.width, bitmap.height);
		const canvas = new OffscreenCanvas(fit.width, fit.height);
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d canvas context");
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
		const jpeg = image.mimeType === "image/jpeg";
		const blob = await canvas.convertToBlob(jpeg ? { type: "image/jpeg", quality: 0.9 } : { type: "image/png" });
		return {
			image: {
				type: "image",
				data: bytesBase64(new Uint8Array(await blob.arrayBuffer())),
				mimeType: jpeg ? "image/jpeg" : "image/png",
			},
			width: fit.width,
			height: fit.height,
			originalWidth: bitmap.width,
			originalHeight: bitmap.height,
			scaled: true,
		};
	} finally {
		bitmap.close();
	}
}

/** The image as a model may get it: unchanged when it fits MODEL_IMAGE_MAX_SIDE, else a scaled copy. Never throws. */
export async function fitImageForModel(image: ImageContent): Promise<ImageFit> {
	const size = imageSizeFromBase64(image.data);
	if (size && Math.max(size.width, size.height) <= MODEL_IMAGE_MAX_SIDE)
		return unchanged(image, size.width, size.height);
	try {
		const bytes = base64Bytes(image.data);
		const key = `${image.mimeType}:${await sha256Hex(bytes)}`;
		const cached = cache.get(key);
		if (cached) return await cached;
		const pending = scaleDown(image, bytes);
		cache.set(key, pending);
		if (cache.size > CACHE_MAX) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		try {
			return await pending;
		} catch (err) {
			cache.delete(key);
			throw err;
		}
	} catch (err) {
		// An image the browser cannot decode goes as it is (the provider decides); never block the turn here.
		console.warn("[model-image] could not scale an image, sending it unchanged:", err);
		return unchanged(image, size?.width ?? 0, size?.height ?? 0);
	}
}

/** Content blocks with every image fitted (text blocks untouched; same array when nothing changes). */
export async function fitContentImages(
	content: (TextContent | ImageContent)[],
): Promise<(TextContent | ImageContent)[]> {
	if (!content.some((c) => c.type === "image")) return content;
	const fitted = await Promise.all(
		content.map(async (c) => (c.type === "image" ? (await fitImageForModel(c)).image : c)),
	);
	return fitted.every((c, i) => c === content[i]) ? content : fitted;
}

/** A message for the model with its images fitted: user messages and tool results carry images. */
export async function fitMessageImages(message: Message): Promise<Message> {
	if (message.role === "user" && Array.isArray(message.content)) {
		const content = await fitContentImages(message.content);
		return content === message.content ? message : { ...message, content };
	}
	if (message.role === "toolResult") {
		const content = await fitContentImages(message.content);
		return content === message.content ? message : { ...message, content };
	}
	return message;
}
