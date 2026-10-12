/**
 * PDF artifacts in Chrome's own PDF viewer (Tom, 2026-10-12: the old viewer was "grainy"). pi-web-ui's PdfArtifact
 * paints every page with pdf.js into a canvas at a fixed 1.5x scale in CSS pixels, ignoring devicePixelRatio, and
 * then stretches the canvas to the column width, so text is soft on a HiDPI screen. This element puts the PDF bytes
 * in a blob: URL and shows it in an iframe, which Chrome renders with its built-in viewer: sharp at every zoom, with
 * page navigation, zoom, find, rotate, print and download in the viewer's toolbar. `#view=FitH&navpanes=0` opens
 * the document fitted to the column width without the thumbnail pane. scripts/build.mjs patches pi-web-ui's
 * ArtifactsPanel to construct this element for `.pdf` artifacts.
 *
 * Fallback: with Chrome's "Download PDFs" setting on (navigator.pdfViewerEnabled === false) the iframe would
 * download the file instead of showing it. Then the pages are drawn with pdf.js at column width x devicePixelRatio
 * (one canvas pixel per device pixel, so still sharp) and drawn again when the column width changes (maximize,
 * window resize).
 *
 * The blob: URL lives only while the element shows that content in the DOM: it is revoked when the content changes
 * (rewrite) and when the element leaves the DOM, and made again if the element comes back.
 */
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
// The package exports only its index, and the index re-exports ArtifactsPanel, which imports this file (through
// the build patch): importing ArtifactElement from the index would be an import cycle, evaluated in the wrong order.
import { ArtifactElement } from "../../node_modules/@mariozechner/pi-web-ui/dist/tools/artifacts/ArtifactElement.js";

/** Chrome PDF viewer open parameters: fit the page width, no thumbnail pane. */
export const PDF_VIEW_PARAMS = "#view=FitH&navpanes=0";

/** Artifact content (base64, optionally a data: URL) to the PDF bytes. Throws a readable error for anything else. */
export function decodePdfContent(content: string): Uint8Array<ArrayBuffer> {
	const base64 = content.startsWith("data:") ? content.slice(content.indexOf(",") + 1) : content;
	let binary: string;
	try {
		binary = atob(base64);
	} catch {
		throw new Error("The artifact content is not base64-encoded PDF data.");
	}
	// Readers accept the %PDF- header anywhere in the first 1024 bytes.
	if (!binary.slice(0, 1024).includes("%PDF-")) {
		throw new Error("The artifact content is not a PDF file (no %PDF- header).");
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Chrome shows PDFs inline unless "Download PDFs" is on (then this is false). */
function chromeViewerEnabled(): boolean {
	return navigator.pdfViewerEnabled !== false;
}

@customElement("sg-pdf-artifact")
export class SitegeistPdfArtifact extends ArtifactElement {
	private _content = "";
	private bytes: Uint8Array<ArrayBuffer> | undefined;
	@state() private error: string | undefined;
	@state() private blobUrl: string | undefined;
	// pdf.js fallback state
	private drawRun = 0;
	private drawnWidth = 0;
	private drawTimer: ReturnType<typeof setTimeout> | undefined;
	private loadingTask: PDFDocumentLoadingTask | undefined;
	private resizeObserver: ResizeObserver | undefined;

	get content(): string {
		return this._content;
	}

	set content(value: string) {
		if (value === this._content && (this.bytes || this.error)) return;
		this._content = value;
		this.error = undefined;
		this.bytes = undefined;
		try {
			this.bytes = decodePdfContent(value);
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		}
		this.releaseBlobUrl();
		if (this.isConnected) this.ensureBlobUrl();
		this.drawnWidth = 0;
		if (this.isConnected && !chromeViewerEnabled()) this.scheduleDraw();
		this.requestUpdate();
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.height = "100%";
		this.ensureBlobUrl();
		if (!chromeViewerEnabled()) {
			this.resizeObserver ??= new ResizeObserver(() => this.scheduleDraw());
			this.resizeObserver.observe(this);
		}
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.releaseBlobUrl();
		this.resizeObserver?.disconnect();
		clearTimeout(this.drawTimer);
		this.drawRun++;
		this.drawnWidth = 0;
		void this.loadingTask?.destroy();
		this.loadingTask = undefined;
	}

	private ensureBlobUrl(): void {
		if (this.blobUrl || !this.bytes || !chromeViewerEnabled()) return;
		this.blobUrl = URL.createObjectURL(new Blob([this.bytes], { type: "application/pdf" }));
	}

	private releaseBlobUrl(): void {
		if (!this.blobUrl) return;
		URL.revokeObjectURL(this.blobUrl);
		this.blobUrl = undefined;
	}

	getHeaderButtons(): TemplateResult {
		return html`<div class="flex items-center gap-1">
			${this.bytes ? DownloadButton({ content: this.bytes, filename: this.filename, mimeType: "application/pdf" }) : ""}
		</div>`;
	}

	protected override render(): TemplateResult {
		if (this.error) {
			return html`<div class="h-full flex items-center justify-center bg-background p-4">
				<div class="sg-pdf-error bg-destructive/10 border border-destructive text-destructive p-4 rounded-lg max-w-2xl">
					<div class="font-medium mb-1">Error loading PDF</div>
					<div class="text-sm opacity-90">${this.error}</div>
				</div>
			</div>`;
		}
		if (!chromeViewerEnabled()) {
			return html`<div class="sg-pdf-pages h-full overflow-auto bg-muted/40 p-3 flex flex-col gap-3"></div>`;
		}
		if (!this.blobUrl) return html``;
		return html`<iframe
			class="sg-pdf-frame block w-full h-full border-0 bg-background"
			title=${this.filename}
			src=${this.blobUrl + PDF_VIEW_PARAMS}
		></iframe>`;
	}

	// ---- pdf.js fallback ("Download PDFs" on) ------------------------------------------------------

	private scheduleDraw(): void {
		clearTimeout(this.drawTimer);
		this.drawTimer = setTimeout(() => void this.drawPages(), 100);
	}

	private async drawPages(): Promise<void> {
		await this.updateComplete;
		const pages = this.querySelector(".sg-pdf-pages");
		const bytes = this.bytes;
		if (!(pages instanceof HTMLElement) || !bytes) return;
		const style = getComputedStyle(pages);
		const width = Math.floor(
			pages.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
		);
		// Hidden tab (width 0) or unchanged width: nothing to do. The ResizeObserver calls again when it gets a size.
		if (width <= 0 || width === this.drawnWidth) return;
		this.drawnWidth = width;
		const run = ++this.drawRun;
		void this.loadingTask?.destroy();
		if (!GlobalWorkerOptions.workerSrc) {
			GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdfjs-dist/build/pdf.worker.min.mjs");
		}
		// pdf.js takes ownership of (detaches) the buffer it is given; keep ours for the download button.
		const task = getDocument({ data: bytes.slice() });
		this.loadingTask = task;
		let pdf: PDFDocumentProxy | undefined;
		try {
			pdf = await task.promise;
			const dpr = window.devicePixelRatio || 1;
			for (let n = 1; n <= pdf.numPages; n++) {
				const page = await pdf.getPage(n);
				if (run !== this.drawRun) return;
				const scale = (width / page.getViewport({ scale: 1 }).width) * dpr;
				const viewport = page.getViewport({ scale });
				const canvas = document.createElement("canvas");
				canvas.width = Math.round(viewport.width);
				canvas.height = Math.round(viewport.height);
				// ring, not border: a border would take 2px from the content box and break the 1:1 pixel mapping
				canvas.className = "sg-pdf-page block w-full h-auto bg-white rounded shadow-sm ring-1 ring-border";
				await page.render({ canvas, viewport }).promise;
				if (run !== this.drawRun) return;
				// Replace page by page: the first draw shows pages as they come, a redraw never blanks the view.
				const old = pages.children.item(n - 1);
				if (old) old.replaceWith(canvas);
				else pages.append(canvas);
			}
			while (pages.children.length > pdf.numPages) pages.lastElementChild?.remove();
		} catch (err) {
			if (run !== this.drawRun) return;
			this.drawnWidth = 0;
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			if (this.loadingTask === task) this.loadingTask = undefined;
			void pdf?.destroy();
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"sg-pdf-artifact": SitegeistPdfArtifact;
	}
}
