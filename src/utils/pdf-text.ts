/**
 * Text of a PDF tab for browser_page (Quant Coach request 12d1be2f, 2026-11-15). The browser's own PDF viewer
 * (pdf.js in Zen/Firefox, the PDF plugin in Chrome) cannot be scripted by any extension, so the reader script
 * failed with "Missing host permission for the tab" even though the add-on has <all_urls>. The panel instead
 * fetches the tab's URL with the browser's cookies (same login as the tab) and extracts the text with pdfjs.
 */
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import { joinTextItems, looksLikePdf } from "./pdf-bytes.js";

export const MAX_PDF_BYTES = 60 * 1024 * 1024;

export interface PdfText {
	text: string;
	pages: number;
	bytes: number;
}

/** Fetch `url` with the browser's cookies; returns undefined when it is not a PDF. */
export async function fetchPdfText(url: string, signal?: AbortSignal): Promise<PdfText | undefined> {
	if (!/^https?:/i.test(url)) return undefined;
	const response = await fetch(url, { credentials: "include", ...(signal ? { signal } : {}) });
	if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > MAX_PDF_BYTES) throw new Error(`PDF is ${declared} bytes; limit ${MAX_PDF_BYTES}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (!looksLikePdf(bytes)) return undefined;
	if (!GlobalWorkerOptions.workerSrc) GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdfjs-dist/build/pdf.worker.min.mjs");
	const doc = await getDocument({ data: bytes }).promise;
	try {
		const pages: string[] = [];
		for (let n = 1; n <= doc.numPages; n += 1) {
			const page = await doc.getPage(n);
			const content = await page.getTextContent();
			// pdfjs types items as TextItem | TextMarkedContent; only TextItem carries str/hasEOL, which joinTextItems reads optionally.
			pages.push(`--- page ${n} ---\n${joinTextItems(content.items as ReadonlyArray<{ str?: string; hasEOL?: boolean }>)}`);
		}
		return { text: pages.join("\n\n"), pages: doc.numPages, bytes: bytes.length };
	} finally {
		await doc.destroy();
	}
}
