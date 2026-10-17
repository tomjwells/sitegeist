/** Test images without image libraries (zlib only). */
import { crc32, deflateSync } from "node:zlib";

/** A width x height RGB PNG with diagonal stripes, so it is visibly larger than the 50% column. */
export function makePng(width: number, height: number): Buffer {
	const stride = 1 + width * 3;
	const raw = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = y * stride + 1 + x * 3;
			const dark = Math.floor((x + y) / 60) % 2 === 1;
			raw[o] = dark ? 37 : 219;
			raw[o + 1] = dark ? 99 : 234;
			raw[o + 2] = dark ? 235 : 254;
		}
	}
	const chunk = (type: string, data: Buffer): Buffer => {
		const head = Buffer.alloc(4);
		head.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([head, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.writeUInt8(8, 8); // bit depth
	ihdr.writeUInt8(2, 9); // colour type: RGB
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
