/**
 * In-page fixture for tests/model-image.test.ts: the real scaling code, and fitMessageImages, which the Browser agent's
 * message transformer applies to every message it sends (src/messages/message-transformer.ts).
 */
import type { ImageContent, Message } from "@mariozechner/pi-ai";
import { imageSizeFromBase64 } from "../src/utils/image-size.ts";
import { fitImageForModel, fitMessageImages } from "../src/utils/model-image.ts";

export interface FitReport {
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
	scaled: boolean;
	mimeType: string;
	/** Size read back from the returned bytes. */
	actual: { width: number; height: number } | null;
	unchangedData: boolean;
	ms: number;
}

async function fit(data: string, mimeType: string): Promise<FitReport> {
	const started = performance.now();
	const r = await fitImageForModel({ type: "image", data, mimeType });
	return {
		width: r.width,
		height: r.height,
		originalWidth: r.originalWidth,
		originalHeight: r.originalHeight,
		scaled: r.scaled,
		mimeType: r.image.mimeType,
		actual: imageSizeFromBase64(r.image.data) ?? null,
		unchangedData: r.image.data === data,
		ms: Math.round(performance.now() - started),
	};
}

/** A JPEG made by the browser itself (Node has no JPEG encoder). */
async function jpeg(width: number, height: number): Promise<string> {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	ctx.fillStyle = "#2563eb";
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = "#fff";
	ctx.font = "120px sans-serif";
	ctx.fillText("Retina screenshot", 100, 400);
	const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** Every image the model would get from these messages: its role and its real size. */
async function transform(
	big: string,
	small: string,
): Promise<Array<{ role: string; width: number; height: number; same: boolean }>> {
	const image = (data: string): ImageContent => ({ type: "image", data, mimeType: "image/png" });
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// What the transformer hands to fitMessageImages: pasted attachments arrive as a user message with image blocks.
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "What is wrong with this layout?" }, image(big)], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "Let me look at the page." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage,
			stopReason: "stop",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "extract_image",
			content: [image(big)],
			isError: false,
			timestamp: 3,
		},
		{ role: "user", content: [{ type: "text", text: "and this one" }, image(small)], timestamp: 4 },
	];
	const out = await Promise.all(messages.map((m) => fitMessageImages(m)));
	if (out[3] !== messages[3]) throw new Error("a message whose images already fit must be passed as it is");
	const images: Array<{ role: string; width: number; height: number; same: boolean }> = [];
	for (const m of out) {
		if (typeof m.content === "string") continue;
		for (const c of m.content) {
			if (c.type !== "image") continue;
			const size = imageSizeFromBase64(c.data);
			images.push({ role: m.role, width: size?.width ?? -1, height: size?.height ?? -1, same: c.data === small });
		}
	}
	return images;
}

declare global {
	interface Window {
		modelImageFixture: {
			fit: typeof fit;
			jpeg: typeof jpeg;
			transform: typeof transform;
		};
	}
}

window.modelImageFixture = { fit, jpeg, transform };
document.title = "ready";
