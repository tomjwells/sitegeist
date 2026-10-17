/**
 * Images on their way to a model fit 2000 px (Tom, 2026-10-17: a chat got stuck on "At least one of the image
 * dimensions exceed max allowed size for many-image requests: 3000 pixels" because a pasted 3432 px screenshot rode
 * along in every turn). Runs the real scaling code (src/utils/model-image.ts) in Chromium, including fitMessageImages,
 * which the Browser agent's message transformer applies to every message: big PNG and JPEG scaled (PNG stays PNG, JPEG stays JPEG), small images untouched, the cache
 * answers the next turn, images in attachments and tool results scaled, a broken image passed through.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { piWebUiPatchPlugin } from "../scripts/build.mjs";
import { makePng } from "./png.fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test(
	"images for the model fit 2000 px; small ones and the chat's originals are untouched",
	{ timeout: 120_000 },
	async () => {
		const output = await mkdtemp(join(tmpdir(), "sitegeist-model-image-"));
		await build({
			absWorkingDir: root,
			entryPoints: [join(root, "tests/model-image.fixture.ts")],
			outfile: join(output, "fixture.js"),
			bundle: true,
			format: "esm",
			platform: "browser",
			target: ["chrome120"],
			plugins: [piWebUiPatchPlugin],
			define: {
				"process.env.NODE_ENV": '"test"',
				global: "globalThis",
				__SITEGEIST_BUILD__: JSON.stringify({ sha: "test", dirty: false, builtAt: "" }),
			},
			inject: [join(root, "scripts/process-shim.js")],
			alias: {
				process: join(root, "scripts/process-shim.js"),
				"@mariozechner/mini-lit": join(root, "node_modules/@mariozechner/mini-lit"),
				lit: join(root, "node_modules/lit"),
			},
		});
		const script = await readFile(join(output, "fixture.js"));
		const browser = await chromium.launch({
			headless: true,
			timeout: 15_000,
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
		});
		try {
			const page = await browser.newPage();
			await page.route("**/*", async (route) => {
				const url = new URL(route.request().url());
				if (url.pathname === "/fixture.js") await route.fulfill({ contentType: "text/javascript", body: script });
				else
					await route.fulfill({
						contentType: "text/html",
						body: '<!doctype html><script type="module" src="/fixture.js"></script>',
					});
			});
			await page.goto("https://sitegeist-model-image.test/");
			await page.waitForFunction(() => document.title === "ready", undefined, { timeout: 30_000 });

			const big = makePng(3432, 2006).toString("base64"); // Tom's screenshot size
			const small = makePng(1200, 750).toString("base64");
			const tall = makePng(1126, 3998).toString("base64");

			const first = await page.evaluate((d) => window.modelImageFixture.fit(d, "image/png"), big);
			assert.deepEqual(
				{ ...first, ms: 0 },
				{
					width: 2000,
					height: 1169,
					originalWidth: 3432,
					originalHeight: 2006,
					scaled: true,
					mimeType: "image/png",
					actual: { width: 2000, height: 1169 },
					unchangedData: false,
					ms: 0,
				},
			);
			const again = await page.evaluate((d) => window.modelImageFixture.fit(d, "image/png"), big);
			assert.equal(again.actual?.width, 2000);
			assert.ok(again.ms <= first.ms, `the next turn is served from the cache (${again.ms} ms vs ${first.ms} ms)`);

			const untouched = await page.evaluate((d) => window.modelImageFixture.fit(d, "image/png"), small);
			assert.equal(untouched.scaled, false);
			assert.equal(untouched.unchangedData, true, "an image that fits is passed as it is");

			const tallFit = await page.evaluate((d) => window.modelImageFixture.fit(d, "image/png"), tall);
			assert.deepEqual(tallFit.actual, { width: 563, height: 2000 });

			const jpegFit = await page.evaluate(async () => {
				const data = await window.modelImageFixture.jpeg(2644, 1970);
				return window.modelImageFixture.fit(data, "image/jpeg");
			});
			assert.equal(jpegFit.mimeType, "image/jpeg", "JPEG stays JPEG");
			assert.deepEqual(jpegFit.actual, { width: 2000, height: 1490 });

			const broken = await page.evaluate(() =>
				window.modelImageFixture.fit(btoa("definitely not a png"), "image/png"),
			);
			assert.equal(broken.unchangedData, true, "an image the browser cannot decode goes as it is");

			// What the Browser agent sends: pasted images and tool-result screenshots scaled, small images untouched.
			const images = await page.evaluate(([b, s]) => window.modelImageFixture.transform(b, s), [
				big,
				small,
			] as const);
			assert.deepEqual(images, [
				{ role: "user", width: 2000, height: 1169, same: false },
				{ role: "toolResult", width: 2000, height: 1169, same: false },
				{ role: "user", width: 1200, height: 750, same: true },
			]);
		} finally {
			await browser.close();
			await rm(output, { recursive: true, force: true });
		}
	},
);
