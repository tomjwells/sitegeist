/**
 * The server side of a WebSocket for tests (RFC 6455 text frames only), so a stand-in relay can talk to the panel's
 * PrimeSocket without a dependency. Browser frames are masked and, for the small JSON messages used here, unfragmented.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export interface MiniSocket {
	send(text: string): void;
	onMessage(handler: (text: string) => void): void;
	onClose(handler: () => void): void;
	close(): void;
}

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptWebSocket(req: IncomingMessage, socket: Duplex): MiniSocket {
	const key = req.headers["sec-websocket-key"];
	if (typeof key !== "string") throw new Error("not a WebSocket upgrade");
	const accept = createHash("sha1")
		.update(key + ACCEPT_GUID)
		.digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	const writeFrame = (payload: Buffer, opcode: number): void => {
		const length = payload.length;
		let header: Buffer;
		if (length < 126) header = Buffer.from([0x80 | opcode, length]);
		else if (length < 65_536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		socket.write(Buffer.concat([header, payload]));
	};
	const handlers: Array<(text: string) => void> = [];
	const closeHandlers: Array<() => void> = [];
	let closed = false;
	const markClosed = (): void => {
		if (closed) return;
		closed = true;
		for (const handler of closeHandlers) handler();
	};
	socket.on("close", markClosed);
	socket.on("end", markClosed);
	let buffer = Buffer.alloc(0);
	socket.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			if (buffer.length < 2) return;
			const opcode = (buffer[0] ?? 0) & 0x0f;
			const masked = ((buffer[1] ?? 0) & 0x80) !== 0;
			let length = (buffer[1] ?? 0) & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (buffer.length < 4) return;
				length = buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (buffer.length < 10) return;
				length = Number(buffer.readBigUInt64BE(2));
				offset = 10;
			}
			const maskLength = masked ? 4 : 0;
			if (buffer.length < offset + maskLength + length) return;
			const mask = buffer.subarray(offset, offset + maskLength);
			const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
			if (masked) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
			buffer = buffer.subarray(offset + maskLength + length);
			if (opcode === 0x8) {
				markClosed();
				socket.end();
				return;
			}
			if (opcode === 0x9)
				writeFrame(payload, 0xa); // ping -> pong
			else if (opcode === 0x1) for (const handler of handlers) handler(payload.toString("utf8"));
		}
	});
	socket.on("error", () => undefined); // the browser closing the tab mid-frame is fine in a test
	return {
		send: (text) => writeFrame(Buffer.from(text, "utf8"), 0x1),
		onMessage: (handler) => {
			handlers.push(handler);
		},
		onClose: (handler) => {
			closeHandlers.push(handler);
		},
		close: () => {
			markClosed();
			socket.end();
		},
	};
}
