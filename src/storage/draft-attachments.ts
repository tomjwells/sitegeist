/**
 * Unsent attachments stay with the draft (Tom, 2026-10-24: "If I try to attach things, then change the browser tab,
 * it reloads but loses the attachments" - switching to a page with its own chat reloads the panel onto that chat;
 * the typed text came back, the files did not). Same key as the text draft (panel scope + chat), but in IndexedDB:
 * a draft can hold 10 files of up to 20 MB, far beyond localStorage. Saved on every change of the editor's
 * attachment list, restored when the editor (re)connects, cleared when the message is sent or the draft is dropped.
 * Local to this browser profile, like the text; never synced.
 */
import type { Attachment } from "@mariozechner/pi-web-ui";
import type { DraftScope } from "./prompt-drafts.js";
import type { DraftAttachmentsStore } from "./stores/draft-attachments-store.js";

export type { DraftAttachmentsRecord } from "./stores/draft-attachments-store.js";

/**
 * The store is handed in by the side panel once storage exists (src/storage/app-storage.ts wires it). This module is
 * imported by the patched pi-web-ui MessageEditor, so it must not import app-storage.ts itself: that would load
 * pi-web-ui's AppStorage from inside pi-web-ui's own module graph before it is defined ("Class extends value undefined").
 */
let store: DraftAttachmentsStore | undefined;
export function setDraftAttachmentsStore(s: DraftAttachmentsStore): void {
	store = s;
}

const PREFIX = "sitegeist.prompt-draft.v1:";

interface DraftAttachmentsEditor {
	attachments: Attachment[];
}

const bindings = new WeakMap<DraftAttachmentsEditor, { key: string }>();
const connectedEditors = new Set<DraftAttachmentsEditor>();
let currentKey: string | undefined;
/** The last list written per key, so a restore never clobbers a newer in-memory list with an older read. */
const lastWritten = new Map<string, Attachment[]>();

const draftKey = (scope: DraftScope, sessionId?: string): string =>
	`${PREFIX}${scope}:${sessionId ? `session:${sessionId}` : "new"}`;

const sameList = (a: Attachment[], b: Attachment[]): boolean =>
	a.length === b.length && a.every((x, i) => x.id === b[i]?.id && x.content === b[i]?.content);

function isAttachment(v: unknown): v is Attachment {
	if (typeof v !== "object" || v === null) return false;
	const a = v as Record<string, unknown>;
	return (
		typeof a.id === "string" &&
		(a.type === "image" || a.type === "document") &&
		typeof a.fileName === "string" &&
		typeof a.mimeType === "string" &&
		typeof a.size === "number" &&
		typeof a.content === "string"
	);
}

async function readStored(key: string): Promise<Attachment[]> {
	if (!store) return [];
	try {
		const record = await store.get(key);
		return record?.attachments.filter(isAttachment) ?? [];
	} catch (err) {
		console.warn("[Drafts] attachment draft unavailable", err);
		return [];
	}
}

async function write(key: string, attachments: Attachment[]): Promise<void> {
	lastWritten.set(key, attachments);
	if (!store) return;
	try {
		if (attachments.length > 0) await store.put({ key, attachments, savedAt: Date.now() });
		else await store.remove(key);
	} catch (err) {
		console.warn("[Drafts] attachment draft not saved", err);
	}
}

/** Set before constructing the editor; same scope and chat as configurePromptDraft. */
export function configureDraftAttachments(scope: DraftScope, sessionId?: string): void {
	currentKey = draftKey(scope, sessionId);
}

/** The first exchange gives a fresh chat its session id: the files move with the text. */
export async function promoteDraftAttachments(scope: DraftScope, sessionId: string): Promise<void> {
	const previous = currentKey;
	const next = draftKey(scope, sessionId);
	if (!previous || previous === next || previous !== draftKey(scope)) return;
	currentKey = next;
	for (const editor of connectedEditors) {
		const binding = bindings.get(editor);
		if (binding?.key === previous) binding.key = next;
	}
	const list = lastWritten.get(previous) ?? (await readStored(previous));
	if (list.length > 0) await write(next, list);
	await write(previous, []);
}

export async function clearDraftAttachments(scope: DraftScope, sessionId?: string): Promise<void> {
	await write(draftKey(scope, sessionId), []);
}

/** A chat moved from another panel brings its files; they never replace files already kept here. */
export async function seedDraftAttachments(
	scope: DraftScope,
	sessionId: string | undefined,
	attachments: Attachment[],
): Promise<void> {
	const key = draftKey(scope, sessionId);
	if (attachments.length === 0 || (await readStored(key)).length > 0) return;
	await write(key, attachments);
	for (const editor of connectedEditors) {
		if (bindings.get(editor)?.key === key && editor.attachments.length === 0)
			editor.attachments = attachments.slice();
	}
}

/** The unsent files of the chat this panel shows. */
export async function currentDraftAttachments(): Promise<Attachment[]> {
	return currentKey ? readStored(currentKey) : [];
}

/** MessageEditor.connectedCallback (patched in scripts/build.mjs): bind, and bring the saved files back. */
export function connectDraftAttachments(editor: DraftAttachmentsEditor): void {
	connectedEditors.add(editor);
	if (!currentKey) return;
	const key = currentKey;
	const binding = bindings.get(editor);
	if (binding?.key !== key) bindings.set(editor, { key });
	if (editor.attachments.length > 0) {
		// Files already in the editor (Edge reconstructing the panel) are the newer truth.
		rememberDraftAttachments(editor, editor.attachments);
		return;
	}
	void readStored(key).then((stored) => {
		if (stored.length === 0 || !connectedEditors.has(editor) || bindings.get(editor)?.key !== key) return;
		if (editor.attachments.length === 0) editor.attachments = stored;
	});
}

export function disconnectDraftAttachments(editor: DraftAttachmentsEditor): void {
	connectedEditors.delete(editor);
}

/** MessageEditor's onFilesChange / removeFile / the send path (patched): every change of the list is saved at once. */
export function rememberDraftAttachments(editor: DraftAttachmentsEditor, attachments: Attachment[]): void {
	const binding = bindings.get(editor);
	if (!binding) return;
	const previous = lastWritten.get(binding.key);
	if (previous && sameList(previous, attachments)) return;
	void write(binding.key, attachments.slice());
}

/** "Open next to the page": the moving panel parks its files under the handoff key; the new tab claims them. */
export async function parkDraftAttachments(handoffKey: string, attachments: Attachment[]): Promise<void> {
	await write(`${PREFIX}handoff:${handoffKey}`, attachments);
}

export async function claimParkedDraftAttachments(handoffKey: string): Promise<Attachment[]> {
	const key = `${PREFIX}handoff:${handoffKey}`;
	// The moving panel parks the files without awaiting (it must close synchronously in Firefox / Zen), so the write
	// can land a moment after this tab has loaded: look a few times over ~1.5 s.
	for (let attempt = 0; attempt < 6; attempt++) {
		const parked = await readStored(key);
		if (parked.length > 0) {
			await write(key, []);
			return parked;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return [];
}
