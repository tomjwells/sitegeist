/** Pure helpers for the browser_page PDF fallback (src/utils/pdf-text.ts); no pdfjs import, so they test in node. */
/** True when the bytes are a PDF (magic "%PDF-" within the first 1 KB, as browsers check). */
export function looksLikePdf(bytes: Uint8Array): boolean {
	const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
	return head.includes("%PDF-");
}

/** One page's text items joined into lines (pdfjs marks line ends with hasEOL). */
export function joinTextItems(items: ReadonlyArray<{ str?: string; hasEOL?: boolean }>): string {
	let out = "";
	for (const item of items) {
		out += item.str ?? "";
		if (item.hasEOL) out += "\n";
	}
	return out.replace(/[ \t]+\n/g, "\n").trim();
}

