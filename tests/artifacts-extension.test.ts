import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { type BrowserContext, chromium, type Page } from "playwright";

/**
 * Real-extension check of the artifacts panel (Tom, 2026-10-12: "The pdf viewer here is kind of grainy" and "I want
 * to be able to expand it to full screen so it takes the whole sidebar"). The built dist-chrome is loaded into
 * Chromium at 1280x800 and devicePixelRatio 2, a local session with a PDF and an image artifact is seeded into the
 * extension's IndexedDB, and the side panel document is opened on it. Asserts:
 *  - the PDF is shown by Chrome's built-in PDF viewer in an iframe (blob: URL, fit to width), a rewrite swaps the
 *    document and revokes the old blob: URL, deleting the artifact revokes the current one, bad content shows an error;
 *  - the maximize toggle gives the artifacts the full width and hides the chat; it survives switching tabs (PDF to
 *    image, and the image grows but stays whole); the button and Escape restore 50/50 with the chat's scroll position
 *    kept; while the agent streams, Escape only restores the chat and the next Escape aborts;
 *  - with Chrome's "Download PDFs" setting on, the pdf.js fallback draws pages at column width x devicePixelRatio and
 *    redraws them when the column widens.
 * Optional: SITEGEIST_SHOTS_DIR=<dir> saves screenshots, SITEGEIST_PDF_FIXTURE=<file.pdf> shows a real PDF instead
 * of the generated one.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist-chrome");
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const SHOTS_DIR = process.env.SITEGEIST_SHOTS_DIR;
const PDF_FIXTURE = process.env.SITEGEIST_PDF_FIXTURE;
/** Chrome's PDF viewer (a component extension): its frame appears inside our iframe once it shows a PDF. */
const CHROME_PDF_VIEWER = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";
const VIEWPORT = { width: 1280, height: 800 };
const SESSION_ID = "s-artifacts";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

/** A small valid PDF: US Letter pages of Helvetica text, with a correct xref table. */
function makePdf(title: string, pageCount: number): Buffer {
	const lines = [
		"The quick brown fox jumps over the lazy dog. 0123456789",
		"Sphinx of black quartz, judge my vow. Pack my box with five dozen liquor jugs.",
		"Small print stays readable: a sharp viewer draws text with device pixels.",
	];
	// object 1 catalog, 2 page tree, 3 font, then per page: page object, content stream
	const pageIds = Array.from({ length: pageCount }, (_, i) => 4 + i * 2);
	const bodies = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	pageIds.forEach((id, i) => {
		const text = [
			`BT /F1 26 Tf 72 700 Td (${title} - page ${i + 1} of ${pageCount}) Tj ET`,
			...lines.map((l, j) => `BT /F1 ${12 - j * 2} Tf 72 ${650 - j * 30} Td (${l}) Tj ET`),
		].join("\n");
		bodies.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
			`<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`,
		);
	});
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	bodies.forEach((body, i) => {
		offsets.push(Buffer.byteLength(out, "latin1"));
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out, "latin1");
	out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

/** A width x height RGB PNG with diagonal stripes, so it is visibly larger than the 50% column. */
function makePng(width: number, height: number): Buffer {
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

function artifactSession(artifacts: Array<{ filename: string; content: string }>) {
	const lastModified = "2026-10-12T09:00:00.000Z";
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// enough transcript to scroll, so the test can check that maximize keeps the chat's scroll position
	const filler = Array.from({ length: 14 }, (_, i) => [
		{
			role: "user",
			content: `Question ${i + 1} about the quarterly numbers?`,
			timestamp: Date.parse(lastModified) - 90_000 + i * 2,
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: `Answer ${i + 1}: revenue grew, costs fell, and the margin is in the report.` },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: Date.parse(lastModified) - 90_000 + i * 2 + 1,
		},
	]).flat();
	const messages = [
		...filler,
		{ role: "user", content: "Show me the report and the figure.", timestamp: Date.parse(lastModified) - 2000 },
		{
			role: "assistant",
			content: [{ type: "text", text: "Both are in the artifacts panel." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: Date.parse(lastModified) - 1000,
		},
		...artifacts.map((a) => ({ role: "artifact", action: "create", ...a, timestamp: lastModified })),
	];
	const title = "Report and figure";
	return {
		data: { id: SESSION_ID, title, model, thinkingLevel: "off", messages, createdAt: lastModified, lastModified },
		metadata: {
			id: SESSION_ID,
			title,
			createdAt: lastModified,
			lastModified,
			messageCount: messages.length,
			usage,
			modelId: model.id,
			thinkingLevel: "off",
			preview: title,
		},
	};
}

async function dismissPermissionDialog(page: Page): Promise<void> {
	// No userScripts API in a fresh test profile → initApp waits on the permission dialog; closing it continues.
	await page.waitForSelector("userscripts-permission-dialog", { timeout: 15_000, state: "attached" });
	await page.evaluate(() =>
		document.querySelector("userscripts-permission-dialog")?.dispatchEvent(new Event("close")),
	);
}

async function seedSession(page: Page, session: ReturnType<typeof artifactSession>): Promise<void> {
	await page.evaluate(async (item) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open("sitegeist-storage");
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(["sessions", "sessions-metadata"], "readwrite");
			tx.objectStore("sessions").put(item.data);
			tx.objectStore("sessions-metadata").put(item.metadata);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	}, session);
}

/** Polls fn until ok; evaluation errors (the panel navigating mid-evaluate) count as "not yet". */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, label: string): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T | undefined;
	while (Date.now() < deadline) {
		try {
			const v = await fn();
			last = v;
			if (ok(v)) return v;
		} catch {
			/* navigation in progress */
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`timed out waiting for ${label}; last = ${JSON.stringify(last)}`);
}

async function launch(userDataDir: string): Promise<{ context: BrowserContext; panelUrl: string }> {
	const context = await chromium.launchPersistentContext(userDataDir, {
		...(chromePath ? { executablePath: chromePath } : {}),
		headless: true,
		viewport: VIEWPORT,
		deviceScaleFactor: 2,
		args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
	});
	let [worker] = context.serviceWorkers();
	if (!worker) worker = await context.waitForEvent("serviceworker");
	return { context, panelUrl: `chrome-extension://${new URL(worker.url()).host}/sidepanel.html` };
}

/** Seeds the session through a first panel document (it creates the schema), then opens the panel on it. */
async function openSession(
	context: BrowserContext,
	panelUrl: string,
	session: ReturnType<typeof artifactSession>,
): Promise<Page> {
	const page = await context.newPage();
	await page.goto(`${panelUrl}?new=true`);
	await dismissPermissionDialog(page);
	await page.waitForSelector("sessions-sidebar", { timeout: 30_000, state: "attached" });
	await seedSession(page, session);
	await page.goto(`${panelUrl}?session=${SESSION_ID}`);
	await dismissPermissionDialog(page);
	// A session rebuilt from storage starts with the artifacts panel collapsed behind the "Artifacts N" pill.
	await page.waitForSelector('button[title="Show artifacts"]', { timeout: 30_000 });
	await page.click('button[title="Show artifacts"]');
	return page;
}

interface Layout {
	window: number;
	artifacts: number;
	chatVisible: boolean;
	toggle: string;
}

async function layout(page: Page): Promise<Layout> {
	return page.evaluate(() => {
		const column = document.querySelector(".sg-artifacts-column");
		const chat = document.querySelector("agent-interface");
		return {
			window: window.innerWidth,
			artifacts: column ? Math.round(column.getBoundingClientRect().width) : -1,
			chatVisible: chat ? chat.checkVisibility({ visibilityProperty: true }) : false,
			toggle: document.querySelector(".sg-artifacts-maximize")?.getAttribute("title") ?? "",
		};
	});
}

const isSideBySide = (l: Layout) => l.chatVisible && Math.abs(l.artifacts - l.window / 2) <= 2;
const isMaximized = (l: Layout) => !l.chatVisible && Math.abs(l.artifacts - l.window) <= 2;

async function shot(page: Page, name: string): Promise<void> {
	if (!SHOTS_DIR) return;
	await mkdir(SHOTS_DIR, { recursive: true });
	await page.screenshot({ path: join(SHOTS_DIR, name) });
}

async function pdfFrameSrc(page: Page): Promise<string> {
	return page.evaluate(() => document.querySelector("sg-pdf-artifact iframe")?.getAttribute("src") ?? "");
}

/** Whether a blob: URL still resolves (a revoked one makes fetch fail). */
async function blobAlive(page: Page, url: string): Promise<number> {
	return page.evaluate(async (u) => {
		try {
			return (await (await fetch(u)).arrayBuffer()).byteLength;
		} catch {
			return -1;
		}
	}, url);
}

/** Runs an artifacts tool command the way the agent (or a prime attachment) does. */
async function artifactsCommand(page: Page, params: Record<string, string>): Promise<string> {
	return page.evaluate(async (p) => {
		const panel = document.querySelector("artifacts-panel");
		const tool: unknown = panel ? Reflect.get(panel, "tool") : undefined;
		const execute: unknown = typeof tool === "object" && tool !== null ? Reflect.get(tool, "execute") : undefined;
		if (typeof execute !== "function") throw new Error("artifacts tool not found");
		const result: unknown = await execute("test-call", p);
		return JSON.stringify(result);
	}, params);
}

test(
	"built extension: PDF artifacts use Chrome's PDF viewer; maximize gives artifacts the whole panel",
	{ timeout: 180_000 },
	async () => {
		const pdf = PDF_FIXTURE ? await readFile(PDF_FIXTURE) : makePdf("Quarterly report", 2);
		const png = makePng(1600, 1000);
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-artifacts-"));
		const { context, panelUrl } = await launch(userDataDir);
		try {
			const page = await openSession(
				context,
				panelUrl,
				artifactSession([
					{ filename: "report.pdf", content: pdf.toString("base64") },
					{ filename: "figure.png", content: png.toString("base64") },
				]),
			);

			// 1. The PDF tab is an iframe on a blob: URL of the bytes, fitted to width, rendered by Chrome's viewer.
			const src = await until(
				() => pdfFrameSrc(page),
				(s) => s.startsWith("blob:"),
				20_000,
				"PDF iframe",
			);
			assert.ok(src.endsWith("#view=FitH&navpanes=0"), src);
			await until(
				() => Promise.resolve(page.frames().map((f) => f.url())),
				(urls) => urls.some((u) => u.startsWith(CHROME_PDF_VIEWER)),
				20_000,
				"Chrome PDF viewer frame",
			);
			assert.equal(await blobAlive(page, src.replace(/#.*$/, "")), pdf.length, "blob holds the PDF bytes");
			assert.equal(
				await page.evaluate(() => document.querySelectorAll("pdf-artifact, sg-pdf-artifact canvas").length),
				0,
				"no pdf.js canvases",
			);

			// 2. 50/50 by default; the maximize toggle sits in the tab bar.
			const sideBySide = await until(() => layout(page), isSideBySide, 10_000, "50/50 layout");
			assert.match(sideBySide.toggle, /^Maximize/);
			await page.waitForTimeout(1500); // let the viewer paint before the screenshot
			await shot(page, "1-pdf-50-50.png");

			// 3. Maximize: artifacts take the whole width, the chat is hidden (and keeps its scroll position, checked in 5).
			const chatScroll = () =>
				page.evaluate(() => {
					const s = document.querySelector("agent-interface .overflow-y-auto");
					return s ? { top: Math.round(s.scrollTop), max: s.scrollHeight - s.clientHeight } : { top: -1, max: -1 };
				});
			await page.evaluate(() => {
				const s = document.querySelector("agent-interface .overflow-y-auto");
				if (s) s.scrollTop = 120;
			});
			const scrolled = await until(chatScroll, (s) => s.max > 300 && s.top === 120, 5_000, "chat scrolled up");
			await page.click(".sg-artifacts-maximize");
			const maximized = await until(() => layout(page), isMaximized, 10_000, "maximized layout");
			assert.match(maximized.toggle, /^Restore/);
			await page.waitForTimeout(1500);
			await shot(page, "2-pdf-maximized.png");

			// 4. Switching to the image tab keeps maximize, and the image grows with the panel.
			await page.click('button[data-filename="figure.png"]');
			await until(
				() => page.evaluate(() => document.querySelector("image-artifact")?.checkVisibility() ?? false),
				(v) => v,
				10_000,
				"image tab shown",
			);
			assert.ok(isMaximized(await layout(page)), "still maximized after switching tabs");
			// The 1600x1000 image is shown whole (fits the panel's height and width) and much larger than at 50/50.
			const imageBox = () =>
				page.evaluate(() => {
					const img = document.querySelector("image-artifact img")?.getBoundingClientRect();
					const col = document.querySelector(".sg-artifacts-column")?.getBoundingClientRect();
					if (!img || !col) return { width: 0, inside: false };
					const inside =
						img.top >= col.top - 1 &&
						img.left >= col.left - 1 &&
						img.bottom <= col.bottom + 1 &&
						img.right <= col.right + 1;
					return { width: Math.round(img.width), inside };
				});
			const bigImage = await until(imageBox, (b) => b.width > 1000 && b.inside, 10_000, "image fills the panel");
			await shot(page, "3-image-maximized.png");

			// 5. Escape restores 50/50 (focus is on the tab button, not in a text field); the image shrinks to fit.
			await page.keyboard.press("Escape");
			await until(() => layout(page), isSideBySide, 10_000, "Escape restores 50/50");
			assert.deepEqual(await chatScroll(), scrolled, "the chat kept its scroll position");
			const smallImage = await until(
				imageBox,
				(b) => b.width > 0 && b.width < 640 && b.inside,
				10_000,
				"image fits",
			);
			assert.ok(
				bigImage.width > smallImage.width * 1.5,
				`image grows when maximized: ${smallImage.width} -> ${bigImage.width}`,
			);

			// 6. The toggle button restores too.
			await page.click(".sg-artifacts-maximize");
			await until(() => layout(page), isMaximized, 10_000, "maximized again");
			await page.click(".sg-artifacts-maximize");
			await until(() => layout(page), isSideBySide, 10_000, "button restores 50/50");

			// 7. While the agent streams, Escape in maximize only restores the chat; the next Escape aborts as before.
			//    (A local session cannot stream without a model; flip the flag the Escape handler reads and spy abort.)
			await page.click(".sg-artifacts-maximize");
			await until(() => layout(page), isMaximized, 10_000, "maximized before streaming check");
			await page.evaluate(() => {
				const chatPanel = document.querySelector("pi-chat-panel");
				const agent: unknown = chatPanel ? Reflect.get(chatPanel, "agent") : undefined;
				const state: unknown =
					typeof agent === "object" && agent !== null ? Reflect.get(agent, "state") : undefined;
				if (typeof agent !== "object" || agent === null || typeof state !== "object" || state === null)
					throw new Error("agent not found");
				Reflect.set(state, "isStreaming", true);
				Reflect.set(window, "__sgAborts", 0);
				Reflect.set(agent, "abort", () =>
					Reflect.set(window, "__sgAborts", Number(Reflect.get(window, "__sgAborts")) + 1),
				);
			});
			const aborts = () => page.evaluate(() => Number(Reflect.get(window, "__sgAborts")));
			await page.keyboard.press("Escape");
			await until(() => layout(page), isSideBySide, 10_000, "Escape restores while streaming");
			assert.equal(await aborts(), 0, "leaving maximize did not abort the agent");
			await page.keyboard.press("Escape");
			assert.equal(await aborts(), 1, "the next Escape aborts");
			await page.evaluate(() => {
				const chatPanel = document.querySelector("pi-chat-panel");
				const agent: unknown = chatPanel ? Reflect.get(chatPanel, "agent") : undefined;
				const state: unknown =
					typeof agent === "object" && agent !== null ? Reflect.get(agent, "state") : undefined;
				if (typeof state === "object" && state !== null) Reflect.set(state, "isStreaming", false);
			});

			// 8. Rewrite swaps the document and revokes the old blob: URL; delete revokes the current one.
			await page.click('button[data-filename="report.pdf"]');
			const oldUrl = (await pdfFrameSrc(page)).replace(/#.*$/, "");
			const revised = makePdf("Revised report", 3);
			await artifactsCommand(page, {
				command: "rewrite",
				filename: "report.pdf",
				content: revised.toString("base64"),
			});
			const newSrc = await until(
				() => pdfFrameSrc(page),
				(s) => s.startsWith("blob:") && !s.startsWith(oldUrl),
				10_000,
				"iframe follows the rewrite",
			);
			const newUrl = newSrc.replace(/#.*$/, "");
			assert.equal(await blobAlive(page, newUrl), revised.length, "new blob holds the new bytes");
			assert.equal(await blobAlive(page, oldUrl), -1, "old blob URL revoked");
			await artifactsCommand(page, { command: "delete", filename: "report.pdf" });
			await until(
				() => blobAlive(page, newUrl),
				(n) => n === -1,
				10_000,
				"blob URL revoked on delete",
			);

			// 9. Content that is not a PDF shows a visible error instead of a blank frame.
			await artifactsCommand(page, { command: "create", filename: "broken.pdf", content: "this is not a pdf" });
			const errorText = await until(
				() => page.evaluate(() => document.querySelector("sg-pdf-artifact .sg-pdf-error")?.textContent ?? ""),
				(t) => t.includes("Error loading PDF"),
				10_000,
				"error box",
			);
			assert.match(errorText, /not a PDF file|not base64/);
		} finally {
			await context.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);

test(
	'built extension: with "Download PDFs" on, the pdf.js fallback draws sharp pages and redraws on maximize',
	{ timeout: 120_000 },
	async () => {
		const userDataDir = await mkdtemp(join(tmpdir(), "sitegeist-artifacts-fallback-"));
		// Chrome setting "Download PDFs" (chrome://settings/content/pdfDocuments) → navigator.pdfViewerEnabled === false
		await mkdir(join(userDataDir, "Default"), { recursive: true });
		await writeFile(
			join(userDataDir, "Default", "Preferences"),
			JSON.stringify({ plugins: { always_open_pdf_externally: true } }),
		);
		const { context, panelUrl } = await launch(userDataDir);
		try {
			const pdf = makePdf("Fallback report", 2);
			const page = await openSession(
				context,
				panelUrl,
				artifactSession([{ filename: "report.pdf", content: pdf.toString("base64") }]),
			);
			assert.equal(await page.evaluate(() => navigator.pdfViewerEnabled), false);
			const pages = () =>
				page.evaluate(() =>
					Array.from(document.querySelectorAll("sg-pdf-artifact canvas.sg-pdf-page")).map((c) => ({
						backing: c instanceof HTMLCanvasElement ? c.width : 0,
						css: c.getBoundingClientRect().width,
					})),
				);
			// One canvas pixel per device pixel (devicePixelRatio 2): sharp, not a stretched 1.5x bitmap.
			const sharp = (list: Array<{ backing: number; css: number }>, minCss: number) =>
				list.length === 2 && list.every((p) => p.css > minCss && Math.abs(p.backing - p.css * 2) <= 2);
			const half = await until(pages, (l) => sharp(l, 500), 20_000, "pdf.js pages at 2x the column width");
			assert.equal(await page.evaluate(() => document.querySelectorAll("sg-pdf-artifact iframe").length), 0);
			await shot(page, "4-fallback-50-50.png");
			await page.click(".sg-artifacts-maximize");
			const full = await until(pages, (l) => sharp(l, 1100), 20_000, "pages redrawn for the maximized width");
			assert.ok((full[0]?.backing ?? 0) > (half[0]?.backing ?? 0) * 1.8, "redrawn at the new width");
		} finally {
			await context.close();
			await rm(userDataDir, { recursive: true, force: true });
		}
	},
);
