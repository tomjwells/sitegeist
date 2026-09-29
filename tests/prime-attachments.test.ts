import assert from "node:assert/strict";
import test from "node:test";
import { buildAttachmentsSection, compactAttachmentsText, hasAttachmentsBlock } from "../src/prime/attachments-text.ts";

const cv = {
	fileName: "Tomos Wells - CV.pdf",
	mimeType: "application/pdf",
	size: 186_000,
	kind: "document" as const,
	extractedText: '<pdf filename="Tomos Wells - CV.pdf"><page number="1">Tomos Wells …</page></pdf>',
};
const shot = { fileName: "shot.png", mimeType: "image/png", size: 40_000, kind: "image" as const };
const path = "/home/vscode/inbox/telegram/sg-abc123/sg-turn1/Tomos-Wells---CV.pdf";

test("shipped files are named by host path, never text-dumped", () => {
	const section = buildAttachmentsSection([{ ...cv, path }, { ...shot, path: "/home/vscode/inbox/telegram/sg-abc123/sg-turn1/shot.png" }]);
	assert.ok(section.startsWith("[sitegeist attachments]\n"));
	assert.ok(section.endsWith("[/sitegeist attachments]"));
	assert.match(section, /^- 1\. "Tomos Wells - CV\.pdf" \(application\/pdf, 182 KiB\) saved on this host at \/home\/vscode\/inbox\/telegram\/sg-abc123\/sg-turn1\/Tomos-Wells---CV\.pdf$/m);
	assert.match(section, /^- 2\. "shot\.png" \(image\/png, 39 KiB\) saved on this host at .* \(also attached to this message as an image\)$/m);
	assert.match(section, /browser_upload_file/);
	assert.doesNotMatch(section, /<pdf filename=/, "extracted text must not be in the prompt when the file was shipped");
	assert.ok(hasAttachmentsBlock(section));
});

test("upload failure falls back to the browser-extracted text after the block", () => {
	const section = buildAttachmentsSection([{ ...cv, error: "prime relay POST /files: HTTP 502" }]);
	assert.match(section, /could NOT be saved on this host \(prime relay POST \/files: HTTP 502\); its browser-extracted text follows this block/);
	const close = section.indexOf("[/sitegeist attachments]");
	assert.ok(section.indexOf("[Document: Tomos Wells - CV.pdf]") > close, "fallback text sits after the block");
	assert.match(section, /<pdf filename=/);
});

test("transcript view: tiles hide the block, otherwise a one-line Attached summary", () => {
	const section = buildAttachmentsSection([{ ...cv, path }, { ...shot, path: "/x/shot.png" }]);
	const prompt = `Can you fill out the form for me?\n\n${section}`;
	assert.equal(compactAttachmentsText(prompt, true), "Can you fill out the form for me?");
	assert.equal(
		compactAttachmentsText(prompt, false),
		"Can you fill out the form for me?\n\nAttached: Tomos Wells - CV.pdf (182 KiB), shot.png (39 KiB)",
	);
	// Only an attachment, no typed text
	assert.equal(compactAttachmentsText(section, true), "");
	assert.equal(compactAttachmentsText(section, false), "\n\nAttached: Tomos Wells - CV.pdf (182 KiB), shot.png (39 KiB)");
	// Unrelated text is untouched
	assert.equal(compactAttachmentsText("plain question", false), "plain question");
	assert.equal(hasAttachmentsBlock("plain question"), false);
});
