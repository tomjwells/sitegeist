/**
 * Firefox / Zen have no debugger API, so nativeClick / nativeType / nativePress cannot send real (trusted) input
 * there. This sends the same actions as page events through a user script instead (2026-10-12). They are synthetic
 * (isTrusted false): most sites accept them, a few (Google Sheets, some anti-bot checks) ignore them. Typing uses
 * document.execCommand("insertText"), which fires a real input event, so React/Vue inputs see it.
 */

export interface SyntheticKey {
	key: string;
	code: string;
	keyCode: number;
}

export type SyntheticAction = "click" | "type" | "press" | "keyDown" | "keyUp";

export interface SyntheticInputParams {
	action: SyntheticAction;
	selector?: string;
	text?: string;
	key?: SyntheticKey;
	alt: boolean;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
}

export interface SyntheticInputResult {
	ok: boolean;
	error?: string;
}

const SYNTHETIC_WORLD = "sitegeist-synthetic-input";

export const isSyntheticAction = (v: unknown): v is SyntheticAction =>
	v === "click" || v === "type" || v === "press" || v === "keyDown" || v === "keyUp";

function isSyntheticInputResult(v: unknown): v is SyntheticInputResult {
	return (
		typeof v === "object" &&
		v !== null &&
		"ok" in v &&
		typeof v.ok === "boolean" &&
		(!("error" in v) || v.error === undefined || typeof v.error === "string")
	);
}

/**
 * Runs IN THE PAGE (stringified into a user script): it must not reference anything outside its own body.
 */
export function syntheticInputInPage(p: SyntheticInputParams): SyntheticInputResult {
	try {
		const mods = { altKey: p.alt, ctrlKey: p.ctrl, metaKey: p.meta, shiftKey: p.shift };
		const fireKey = (target: EventTarget, type: string, k: SyntheticKey): boolean =>
			target.dispatchEvent(
				new KeyboardEvent(type, {
					key: k.key,
					code: k.code,
					keyCode: k.keyCode,
					which: k.keyCode,
					bubbles: true,
					cancelable: true,
					composed: true,
					...mods,
				}),
			);
		const find = (selector: string | undefined): Element => {
			const el = selector ? document.querySelector(selector) : null;
			if (!el) throw new Error(`Selector not found: ${selector ?? "(none)"}`);
			return el;
		};
		const insertText = (el: Element, text: string): void => {
			if (document.execCommand("insertText", false, text)) return;
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
				Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, el.value + text);
				el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
			} else if (el instanceof HTMLElement && el.isContentEditable) {
				el.append(text);
				el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
			}
		};

		if (p.action === "click") {
			const el = find(p.selector);
			el.scrollIntoView({ block: "center", inline: "center" });
			const r = el.getBoundingClientRect();
			const init = {
				bubbles: true,
				cancelable: true,
				composed: true,
				clientX: r.left + r.width / 2,
				clientY: r.top + r.height / 2,
				button: 0,
				...mods,
			};
			const pointer = { ...init, pointerId: 1, isPrimary: true, pointerType: "mouse" };
			el.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
			el.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
			if (el instanceof HTMLElement) el.focus({ preventScroll: true });
			el.dispatchEvent(new PointerEvent("pointerup", pointer));
			el.dispatchEvent(new MouseEvent("mouseup", init));
			el.dispatchEvent(new MouseEvent("click", { ...init, detail: 1 }));
			return { ok: true };
		}

		if (p.action === "type") {
			const el = find(p.selector);
			if (el instanceof HTMLElement) el.focus();
			for (const ch of p.text ?? "") {
				const k = {
					key: ch,
					code: /^[a-z]$/i.test(ch) ? `Key${ch.toUpperCase()}` : /^[0-9]$/.test(ch) ? `Digit${ch}` : "",
					keyCode: ch.toUpperCase().charCodeAt(0),
				};
				if (fireKey(el, "keydown", k) && fireKey(el, "keypress", k)) insertText(el, ch);
				fireKey(el, "keyup", k);
			}
			el.dispatchEvent(new Event("change", { bubbles: true }));
			return { ok: true };
		}

		const k = p.key;
		if (!k) return { ok: false, error: "key required" };
		const target: Element = document.activeElement ?? document.body;
		if (p.action === "keyDown") {
			fireKey(target, "keydown", k);
			return { ok: true };
		}
		if (p.action === "keyUp") {
			fireKey(target, "keyup", k);
			return { ok: true };
		}
		// press: keydown, then the key's default action (a synthetic event has none of its own), then keyup
		if (fireKey(target, "keydown", k)) {
			if (k.key.length === 1) {
				if (fireKey(target, "keypress", k)) insertText(target, k.key);
			} else if (k.key === "Enter") {
				fireKey(target, "keypress", k);
				if (target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) {
					document.execCommand("insertLineBreak");
				} else if (target instanceof HTMLInputElement && target.form) {
					target.form.requestSubmit();
				} else if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) {
					target.click();
				}
			} else if (k.key === "Backspace") {
				document.execCommand("delete");
			} else if (k.key === "Delete") {
				document.execCommand("forwardDelete");
			}
		}
		fireKey(target, "keyup", k);
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Injects syntheticInputInPage into the tab and returns its result. */
export async function runSyntheticInput(tabId: number, params: SyntheticInputParams): Promise<SyntheticInputResult> {
	if (typeof chrome.userScripts?.execute !== "function") {
		return { ok: false, error: 'Page scripts are not enabled for sitegeist: click "Grant Permission" in the panel.' };
	}
	const results = await chrome.userScripts.execute({
		js: [{ code: `(${syntheticInputInPage.toString()})(${JSON.stringify(params)})` }],
		target: { tabId, allFrames: false },
		world: "USER_SCRIPT",
		worldId: SYNTHETIC_WORLD,
		injectImmediately: true,
	});
	const first: unknown = Array.isArray(results) ? results[0]?.result : undefined;
	return isSyntheticInputResult(first) ? first : { ok: false, error: "the page returned no result" };
}
