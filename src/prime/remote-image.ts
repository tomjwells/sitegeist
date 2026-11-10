/**
 * <sg-remote-image>: one picture of an R730 chat, fetched by its link when it comes near the screen (image-refs.ts).
 * It is drawn at the size the history gives for it, so the page does not move when the picture arrives. A click
 * opens the stored file at full size.
 */
import { AttachmentOverlay } from "@mariozechner/pi-web-ui";
import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { boxFor, edgeFor, type ImageRef } from "./image-refs.js";
import { primeImage } from "./prime-client.js";

/** Loaded pictures, most recently used last: "<hash>:<edge>" -> object URL. */
const kept = new Map<string, string>();
const loading = new Map<string, Promise<string>>();
const MAX_KEPT = 150;

/** An object URL for the picture at this edge; one fetch however many elements ask. */
export function remoteImageSrc(ref: ImageRef, edge: number): Promise<string> {
	const key = `${ref.hash}:${edge}`;
	const have = kept.get(key);
	if (have !== undefined) {
		kept.delete(key);
		kept.set(key, have);
		return Promise.resolve(have);
	}
	let run = loading.get(key);
	if (!run) {
		run = primeImage(ref, edge)
			.then((blob) => {
				const url = URL.createObjectURL(blob);
				kept.set(key, url);
				if (kept.size > MAX_KEPT) {
					const oldest = kept.entries().next().value;
					if (oldest) {
						kept.delete(oldest[0]);
						URL.revokeObjectURL(oldest[1]);
					}
				}
				return url;
			})
			.finally(() => loading.delete(key));
		loading.set(key, run);
	}
	return run;
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("the picture could not be read"));
		reader.onload = () => {
			const url = typeof reader.result === "string" ? reader.result : "";
			resolve(url.slice(url.indexOf(",") + 1));
		};
		reader.readAsDataURL(blob);
	});
}

const kib = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("en-GB")} KiB`;

@customElement("sg-remote-image")
export class RemoteImage extends LitElement {
	@property({ attribute: false }) imageRef: ImageRef | undefined;
	/** The picture is drawn no taller than this (CSS px). */
	@property({ type: Number }) maxHeight = 256;
	@state() private src = "";
	@state() private problem = "";
	@state() private opening = false;
	private observer: IntersectionObserver | undefined;
	private near = false;
	/** The picture this element stands for. */
	private hash = "";
	/** "<hash>:<edge>" being loaded or shown. */
	private wanted = "";
	private reloaded = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "inline-block";
		this.style.maxWidth = "100%";
		// A folded tool card clips its pictures (overflow hidden), so they are fetched when the card is opened.
		// The root is the chat's scroller: a margin around the viewport does nothing for content a scroller clips.
		this.observer = new IntersectionObserver(
			(entries) => {
				this.near = entries.some((e) => e.isIntersecting);
				if (this.near) this.load();
			},
			{ root: this.scroller(), rootMargin: "600px 0px" },
		);
		this.observer.observe(this);
	}

	private scroller(): Element | null {
		for (let el = this.parentElement; el; el = el.parentElement) {
			const overflow = getComputedStyle(el).overflowY;
			if (overflow === "auto" || overflow === "scroll") return el;
		}
		return null;
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.observer?.disconnect();
		this.observer = undefined;
		this.near = false;
	}

	protected override willUpdate(changed: PropertyValues): void {
		if (!changed.has("imageRef")) return;
		// Every render of the chat hands over a new object for the same picture: only another picture resets this.
		const hash = this.imageRef?.hash ?? "";
		if (hash === this.hash) return;
		this.hash = hash;
		this.src = "";
		this.problem = "";
		this.wanted = "";
		this.reloaded = false;
		if (this.near) this.load();
	}

	private load(): void {
		const ref = this.imageRef;
		if (!ref) return;
		const box = boxFor(ref, this.maxHeight);
		const edge = edgeFor(box ? Math.max(box.width, box.height) : this.maxHeight * 2, window.devicePixelRatio);
		const key = `${ref.hash}:${edge}`;
		if (this.wanted === key) return;
		this.wanted = key;
		this.problem = "";
		remoteImageSrc(ref, edge).then(
			(src) => {
				if (this.wanted === key) this.src = src;
			},
			(err: unknown) => {
				if (this.wanted !== key) return;
				this.wanted = "";
				this.problem = err instanceof Error ? err.message : String(err);
			},
		);
	}

	/** The object URL was dropped to make room (or the browser lost it): fetch the picture once more. */
	private onImageError(): void {
		const key = this.wanted;
		this.src = "";
		this.wanted = "";
		if (key) kept.delete(key);
		if (this.reloaded) {
			this.problem = "the picture could not be drawn";
			return;
		}
		this.reloaded = true;
		this.load();
	}

	private async openFull(): Promise<void> {
		const ref = this.imageRef;
		if (!ref || this.opening) return;
		this.opening = true;
		try {
			const blob = await primeImage(ref);
			const content = await blobToBase64(blob);
			const mimeType = blob.type || ref.mimeType;
			AttachmentOverlay.open({
				id: ref.hash,
				type: "image",
				fileName: `picture-${ref.hash.slice(0, 8)}.${mimeType.split("/")[1] ?? "png"}`,
				mimeType,
				size: blob.size,
				content,
				preview: content,
			});
		} catch (err) {
			console.warn("[prime] full-size picture failed", err);
		} finally {
			this.opening = false;
		}
	}

	override render() {
		const ref = this.imageRef;
		if (!ref) return nothing;
		const box = boxFor(ref, this.maxHeight);
		const shape = box
			? `width:${box.width}px;height:auto;aspect-ratio:${box.width}/${box.height};max-width:100%`
			: `max-height:${this.maxHeight}px;max-width:100%`;
		if (this.src)
			return html`<img
				class="sg-remote-image block rounded border border-border"
				style="${shape};cursor:zoom-in;${this.opening ? "opacity:0.6" : ""}"
				src=${this.src}
				alt="picture"
				title="Open at full size (${kib(ref.bytes)})"
				data-hash=${ref.hash}
				@click=${() => void this.openFull()}
				@error=${() => this.onImageError()}
			/>`;
		return html`<div
			class="sg-remote-image-wait flex items-center justify-center rounded border border-border text-xs text-muted-foreground"
			style="${box ? shape : "width:160px;height:96px"}"
			data-hash=${ref.hash}
			data-state=${this.problem ? "failed" : "waiting"}
		>
			${
				this.problem
					? html`<button type="button" class="underline hover:no-underline px-2" title=${this.problem} @click=${() => this.load()}>
							Picture not loaded. Retry
						</button>`
					: html`<span class="px-2">Picture · ${kib(ref.bytes)}</span>`
			}
		</div>`;
	}
}
