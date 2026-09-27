import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { piWebUiPatchPlugin } from "../scripts/build.mjs";
import type { Snapshot } from "./prompt-drafts.fixture.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const draft = "  Half-written question\nSecond line — café 日本語 🧪  ";

function retained(snapshot: Snapshot, expected = draft): void {
	assert.equal(snapshot.value, expected);
	assert.equal(snapshot.textareaValue, expected);
}

test("real Sitegeist composer draft lifecycle", { timeout: 60_000 }, async (t) => {
	const output = await mkdtemp(join(tmpdir(), "sitegeist-draft-test-"));
	await build({
		absWorkingDir: root,
		entryPoints: [join(root, "tests/prompt-drafts.fixture.ts")],
		outfile: join(output, "fixture.js"),
		bundle: true,
		format: "esm",
		platform: "browser",
		target: ["chrome120"],
		plugins: [piWebUiPatchPlugin],
		define: { "process.env.NODE_ENV": '"test"', global: "globalThis" },
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
	const context = await browser.newContext({ serviceWorkers: "block" });
	context.setDefaultTimeout(5_000);
	context.setDefaultNavigationTimeout(5_000);
	const pageErrors: string[] = [];
	const unexpectedRequests: string[] = [];
	await context.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin === "https://sitegeist-drafts.test" && url.pathname === "/fixture.js") {
			await route.fulfill({ contentType: "text/javascript", body: script });
		} else if (url.origin === "https://sitegeist-drafts.test" && url.pathname === "/") {
			await route.fulfill({
				contentType: "text/html",
				body: '<!doctype html><button id="outside">Elsewhere</button><div id="host" style="height:650px"></div><script type="module" src="/fixture.js"></script>',
			});
		} else {
			unexpectedRequests.push(route.request().url());
			await route.abort("blockedbyclient");
		}
	});
	const page = await context.newPage();
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const textBox = page.locator("message-editor textarea");
	const snapshot = () => page.evaluate(() => window.draftFixture.snapshot());
	const select = (windowId: number, sessionId?: string) =>
		page.evaluate(({ windowId, sessionId }) => window.draftFixture.select(windowId, sessionId), {
			windowId,
			sessionId,
		});
	try {
		await page.goto("https://sitegeist-drafts.test/");
		await select(1, "chat-a");
		await textBox.fill(draft);
		await t.test("blur, browser tab changes, rerender and reconnect keep the same draft", async () => {
			const before = await snapshot();
			await page.locator("#outside").click();
			const other = await context.newPage();
			await other.bringToFront();
			await page.bringToFront();
			await other.close();
			retained(await page.evaluate(() => window.draftFixture.rerender()));
			const after = await page.evaluate(() => window.draftFixture.reconnect());
			retained(after);
			assert.equal(after.editorId, before.editorId);
		});
		await t.test("streaming redraws and resize preserve the draft", async () => {
			retained(await page.evaluate(() => window.draftFixture.streaming(true)));
			await page.setViewportSize({ width: 700, height: 800 });
			retained(await page.evaluate(() => window.draftFixture.rerender()));
			retained(await page.evaluate(() => window.draftFixture.streaming(false)));
		});
		await t.test("a replacement editor and full chat reconstruction restore unsent text", async () => {
			const before = await snapshot();
			const changed = await page.evaluate(() => window.draftFixture.resetSameAgent());
			retained(changed);
			assert.notEqual(changed.editorId, before.editorId);
			const recreated = await page.evaluate(() => window.draftFixture.recreateChat());
			retained(recreated);
			assert.equal(recreated.messages, before.messages);
		});
		await t.test("immediate document reload retains the final keystroke without debounce", async () => {
			await textBox.fill(`${draft}Z`);
			await page.reload();
			retained(await select(1, "chat-a"), `${draft}Z`);
		});
		await t.test("chat/window draft keys do not leak into each other", async () => {
			retained(await select(1, "chat-b"), "");
			await textBox.fill("B draft");
			retained(await select(2, "chat-a"), "");
			retained(await select(1, "chat-a"), `${draft}Z`);
			retained(await select(1, "chat-b"), "B draft");
		});
		await t.test("new-chat promotion moves the draft and explicit New starts empty", async () => {
			await page.evaluate(() => window.draftFixture.fresh(1));
			await textBox.fill("new-chat text");
			await page.evaluate(() => window.draftFixture.promote(1, "assigned"));
			await page.reload();
			retained(await select(1, "assigned"), "new-chat text");
			retained(await page.evaluate(() => window.draftFixture.fresh(1)), "");
			retained(await select(1, "assigned"), "new-chat text");
		});
		await t.test("successful Send clears storage, so sent text does not return on reload", async () => {
			retained(await page.evaluate(() => window.draftFixture.send("ok")), "");
			await page.reload();
			retained(await select(1, "assigned"), "");
		});
		await t.test("auth cancellation and rejected Send preserve recoverable text", async () => {
			await textBox.fill(draft);
			retained(await page.evaluate(() => window.draftFixture.send("auth-cancel")));
			retained(await page.evaluate(() => window.draftFixture.send("reject")));
			await page.reload();
			retained(await select(1, "assigned"));
		});
		await t.test("async send preparation does not erase a newer draft", async () => {
			await page.evaluate(() => window.draftFixture.startDelayed("prepare"));
			await page.waitForFunction(() => window.draftFixture.sendPhase() === "prepare");
			await textBox.fill("newer while preparing");
			retained(await page.evaluate(() => window.draftFixture.releaseDelayed(false)), "newer while preparing");
		});
		await t.test("a rejected in-flight request does not overwrite newer text", async () => {
			await page.evaluate(() => window.draftFixture.startDelayed("prompt"));
			await page.waitForFunction(() => window.draftFixture.sendPhase() === "prompt");
			await textBox.fill("newer while sending");
			retained(await page.evaluate(() => window.draftFixture.releaseDelayed(true)), "newer while sending");
		});

		await t.test("two panel documents for one chat share the newest draft", async () => {
			await select(1, "multi-document");
			await textBox.fill("document one");
			const second = await context.newPage();
			await second.goto("https://sitegeist-drafts.test/");
			retained(await second.evaluate(() => window.draftFixture.select(1, "multi-document")), "document one");
			await textBox.fill("edited in first");
			await second.waitForFunction(() => window.draftFixture.snapshot().value === "edited in first");
			await second.locator("message-editor textarea").fill("edited in second");
			await page.waitForFunction(() => window.draftFixture.snapshot().value === "edited in second");
			await second.close();
		});

		await t.test("a delayed storage event cannot overwrite a newer local edit", async () => {
			await select(1, "storage-order");
			await textBox.fill("newest local edit");
			await page.evaluate(() => window.draftFixture.staleStorageEvent(1, "storage-order", "older queued event"));
			retained(await snapshot(), "newest local edit");
		});
		await t.test("a disconnected editor reconciles other-document edits when reconnected", async () => {
			await select(1, "detached");
			await textBox.fill("before disconnect");
			await page.evaluate(() => window.draftFixture.detach());
			const second = await context.newPage();
			await second.goto("https://sitegeist-drafts.test/");
			await second.evaluate(() => window.draftFixture.select(1, "detached"));
			await second.locator("message-editor textarea").fill("changed while detached");
			retained(await page.evaluate(() => window.draftFixture.reconnect()), "changed while detached");
			await second.close();
		});
		await t.test("storage failure warns and retains an in-memory draft", async () => {
			await page.evaluate(() => window.draftFixture.storageFailure());
			await textBox.fill("quota failure text");
			retained(await page.evaluate(() => window.draftFixture.recreateChat()), "quota failure text");
			assert.equal(await page.evaluate(() => window.draftFixture.warningCount()), 1);
		});
		assert.deepEqual(pageErrors, []);
		assert.deepEqual(unexpectedRequests, []);
	} finally {
		await browser.close();
		await rm(output, { recursive: true, force: true });
	}
});
