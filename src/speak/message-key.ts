/** FNV-1a over the text (53-bit), plus its length: a stable id for a message without keeping its text around twice. */
export function messageKey(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
	}
	return `${text.length.toString(36)}-${h1.toString(36)}${(h2 & 0x1fffff).toString(36)}`;
}
