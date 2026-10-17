/**
 * Image sizes for what the models get (Tom, 2026-10-17: a main-pi chat got stuck on "At least one of the image
 * dimensions exceed max allowed size for many-image requests: 3000 pixels"). Anthropic accepts large images while a
 * request holds few of them, but caps every image once a request holds many (more than 20). Every turn re-sends the
 * whole chat, so one full-size Retina screenshot (3432 px wide) broke every later turn of that chat as soon as the
 * 21st image arrived. Images the models get are therefore scaled to fit MODEL_IMAGE_MAX_SIDE. The model API scales
 * images down to about 1568 px before the model sees them anyway, so this loses nothing the model would see.
 * Full-size originals stay where they are (attachments are also uploaded as files, the panel keeps them for display).
 * Pure functions, no browser APIs: unit-tested with node --test (tests/image-size.test.ts).
 */

/** Longest side of any image sent to a model: safe under the "many images" limits (2000 px in Anthropic's docs). */
export const MODEL_IMAGE_MAX_SIDE = 2000;

export interface ImageSize {
	width: number;
	height: number;
}

export interface FitSize extends ImageSize {
	/** 1 when the image already fits. */
	scale: number;
}

/** Size that fits `maxSide` on both sides (and `maxWidth` wide), keeping the aspect ratio; never enlarges. */
export function fitSize(width: number, height: number, maxSide = MODEL_IMAGE_MAX_SIDE, maxWidth = maxSide): FitSize {
	const scale = Math.min(1, maxWidth / width, maxSide / Math.max(width, height));
	if (scale >= 1) return { width, height, scale: 1 };
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** Header bytes needed: JPEG files can carry tens of KB of EXIF/ICC data before the frame header. */
const HEADER_BASE64_CHARS = 262_144;

function headerBytes(base64: string): Uint8Array {
	const comma = base64.startsWith("data:") ? base64.indexOf(",") : -1;
	const body = comma >= 0 ? base64.slice(comma + 1) : base64;
	const prefix = body.slice(0, HEADER_BASE64_CHARS);
	const usable = prefix.slice(0, prefix.length - (prefix.length % 4));
	try {
		const binary = atob(usable);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return new Uint8Array(0);
	}
}

const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number): number => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number): number => u16be(b, i) * 65_536 + u16be(b, i + 2);
const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));

/** JPEG start-of-frame markers (they carry the image size); not DHT (C4), JPG (C8) or DAC (CC). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Uint8Array): ImageSize | undefined {
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) return undefined;
		const marker = b[i + 1] ?? 0;
		if (marker === 0xff) {
			i++; // fill byte
			continue;
		}
		if (SOF.has(marker)) return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			i += 2; // markers without a length
			continue;
		}
		i += 2 + u16be(b, i + 2);
	}
	return undefined;
}

/**
 * Pixel size of a base64 image (or data: URL) read from its header: PNG, JPEG, GIF, WebP. Undefined when the format is
 * not one of those or the header is cut off (then decode the image to know).
 */
export function imageSizeFromBase64(base64: string): ImageSize | undefined {
	const b = headerBytes(base64);
	if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && ascii(b, 12, 16) === "IHDR")
		return { width: u32be(b, 16), height: u32be(b, 20) };
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
	if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a"))
		return { width: u16le(b, 6), height: u16le(b, 8) };
	if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
		const chunk = ascii(b, 12, 16);
		if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
		if (chunk === "VP8L" && b[20] === 0x2f) {
			const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
			return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
		}
		if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
	}
	return undefined;
}
