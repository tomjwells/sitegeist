import assert from "node:assert/strict";
import test from "node:test";
import { fitSize, imageSizeFromBase64, MODEL_IMAGE_MAX_SIDE } from "../src/utils/image-size.ts";
import { makePng } from "./png.fixture.ts";

const b64 = (bytes: number[] | Buffer): string => Buffer.from(bytes).toString("base64");

test("fitSize: fits 2000 px on both sides, keeps the aspect ratio, never enlarges", () => {
	assert.equal(MODEL_IMAGE_MAX_SIDE, 2000);
	assert.deepEqual(fitSize(3432, 2006), { width: 2000, height: 1169, scale: 2000 / 3432 }); // Tom's screenshot
	assert.deepEqual(fitSize(2644, 1970), { width: 2000, height: 1490, scale: 2000 / 2644 });
	assert.deepEqual(fitSize(1126, 3998), { width: 563, height: 2000, scale: 2000 / 3998 }); // tall page
	assert.deepEqual(fitSize(1200, 750), { width: 1200, height: 750, scale: 1 });
	assert.deepEqual(fitSize(2000, 2000), { width: 2000, height: 2000, scale: 1 });
	// browser_screenshot: the requested width and the height limit both apply
	assert.deepEqual(fitSize(2880, 1800, 2000, 1280), { width: 1280, height: 800, scale: 1280 / 2880 });
	assert.deepEqual(fitSize(1400, 4000, 2000, 1280), { width: 700, height: 2000, scale: 0.5 });
	assert.equal(fitSize(5000, 1).height, 1, "never 0 px");
});

test("imageSizeFromBase64 reads PNG, JPEG, GIF and WebP headers", () => {
	const png = makePng(3432, 20);
	assert.deepEqual(imageSizeFromBase64(png.toString("base64")), { width: 3432, height: 20 });
	assert.deepEqual(imageSizeFromBase64(`data:image/png;base64,${png.toString("base64")}`), {
		width: 3432,
		height: 20,
	});
	// JPEG: SOI, an APP1 segment (EXIF) to skip, a fill byte, then SOF2 (progressive) with height 2006, width 3432
	const app1 = [0xff, 0xe1, 0x00, 0x10, ...new Array(14).fill(0x45)];
	const sof2 = [
		0xff, 0xc2, 0x00, 0x11, 0x08, 0x07, 0xd6, 0x0d, 0x68, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
	];
	assert.deepEqual(imageSizeFromBase64(b64([0xff, 0xd8, ...app1, 0xff, ...sof2])), { width: 3432, height: 2006 });
	// DHT (C4) is not a frame header: the size comes from the SOF0 after it
	const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
	const sof0 = [
		0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
	];
	assert.deepEqual(imageSizeFromBase64(b64([0xff, 0xd8, ...dht, ...sof0])), { width: 32, height: 16 });
	// GIF: little-endian 640 x 480
	assert.deepEqual(imageSizeFromBase64(b64([...Buffer.from("GIF89a"), 0x80, 0x02, 0xe0, 0x01, 0, 0, 0, 0])), {
		width: 640,
		height: 480,
	});
	const riff = (chunk: string, body: number[]) => [
		...Buffer.from("RIFF"),
		0,
		0,
		0,
		0,
		...Buffer.from("WEBP"),
		...Buffer.from(chunk),
		0,
		0,
		0,
		0,
		...body,
	];
	// VP8X: 24-bit (width - 1), (height - 1): 3432 x 2006
	assert.deepEqual(imageSizeFromBase64(b64(riff("VP8X", [0, 0, 0, 0, 0x67, 0x0d, 0x00, 0xd5, 0x07, 0x00]))), {
		width: 3432,
		height: 2006,
	});
	// VP8L: signature 0x2f, then 14 bits (width - 1) and 14 bits (height - 1): 100 x 50
	const bits = (100 - 1) | ((50 - 1) << 14);
	assert.deepEqual(
		imageSizeFromBase64(
			b64(
				riff("VP8L", [
					0x2f,
					bits & 0xff,
					(bits >> 8) & 0xff,
					(bits >> 16) & 0xff,
					(bits >> 24) & 0xff,
					0,
					0,
					0,
					0,
					0,
				]),
			),
		),
		{ width: 100, height: 50 },
	);
	// VP8 (lossy): frame tag + start code, then 14-bit width / height: 1200 x 750
	assert.deepEqual(imageSizeFromBase64(b64(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0xb0, 0x04, 0xee, 0x02]))), {
		width: 1200,
		height: 750,
	});
});

test("imageSizeFromBase64: unknown or cut-off data gives undefined (decode to know)", () => {
	assert.equal(imageSizeFromBase64(b64([...Buffer.from("not an image at all, just text")])), undefined);
	assert.equal(imageSizeFromBase64(makePng(10, 10).toString("base64").slice(0, 12)), undefined, "header cut off");
	assert.equal(
		imageSizeFromBase64(b64([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10])),
		undefined,
		"JPEG without a frame header",
	);
	assert.equal(imageSizeFromBase64("%%% not base64 %%%"), undefined);
});
