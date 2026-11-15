/** browser_page PDF fallback helpers (Quant Coach 12d1be2f). Run: node --experimental-strip-types --test tests/pdf-text.test.ts */
import assert from "node:assert/strict";
import test from "node:test";
import { joinTextItems, looksLikePdf } from "../src/utils/pdf-bytes.ts";

test("PDF magic is found in the first 1 KB only", () => {
	assert.equal(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n...")), true);
	assert.equal(looksLikePdf(new TextEncoder().encode("<html>%PDF- later</html>".padStart(2000, " "))), false);
	assert.equal(looksLikePdf(new TextEncoder().encode("<!doctype html>")), false);
});

test("text items join into lines", () => {
	assert.equal(joinTextItems([{ str: "Question 2 of 16", hasEOL: true }, { str: "You roll " }, { str: "two dice.", hasEOL: true }]), "Question 2 of 16\nYou roll two dice.");
});
