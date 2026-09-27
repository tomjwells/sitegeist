/** Text-only drafts stay on this browser/device, never in the agent transcript or sync service.
 * Save synchronously on each change: a panel teardown can beat an async/debounced storage write.
 */
export const DRAFT_STORAGE_WARNING_EVENT = "sitegeist-draft-storage-warning";
const PREFIX = "sitegeist.prompt-draft.v1:";

interface DraftEditor {
	value: string;
}
interface DraftBinding {
	key: string;
}
interface DraftEntry {
	text: string;
	revision: number;
}
export interface PromptSubmission {
	binding: DraftBinding | undefined;
	text: string;
	clearedRevision: number | undefined;
}

const bindings = new WeakMap<DraftEditor, DraftBinding>();
const connectedEditors = new Set<DraftEditor>();
const cache = new Map<string, DraftEntry>();
const unsavedKeys = new Set<string>();
let currentKey: string | undefined;
let nextRevision = 0;
let warned = false;

const draftKey = (windowId: number, sessionId?: string): string =>
	`${PREFIX}${windowId}:${sessionId ? `session:${sessionId}` : "new"}`;

function warnStorageUnavailable(): void {
	if (warned) return;
	warned = true;
	console.warn("[Drafts] Local draft storage is unavailable; keeping text in memory only.");
	queueMicrotask(() => window.dispatchEvent(new Event(DRAFT_STORAGE_WARNING_EVENT)));
}

function readDraft(key: string, refresh = false): DraftEntry {
	const cached = cache.get(key);
	if (cached && (!refresh || unsavedKeys.has(key))) return cached;
	let text = "";
	try {
		// Storage's boundary is a raw string, not unvalidated parsed JSON or executable markup.
		text = localStorage.getItem(key) ?? "";
	} catch {
		warnStorageUnavailable();
		if (cached) return cached;
	}
	if (cached?.text === text) return cached;
	const entry = { text, revision: ++nextRevision };
	cache.set(key, entry);
	return entry;
}

function writeDraft(key: string, text: string, revision = ++nextRevision): DraftEntry {
	const entry = { text, revision };
	cache.set(key, entry);
	try {
		if (text) localStorage.setItem(key, text);
		else localStorage.removeItem(key);
		unsavedKeys.delete(key);
	} catch {
		unsavedKeys.add(key); // Never replace an unsaved in-memory edit with older disk contents.
		warnStorageUnavailable();
	}
	return entry;
}

/** Set before constructing the editor. Browser tab identity must never enter this key. */
export function configurePromptDraft(windowId: number, sessionId?: string): void {
	currentKey = draftKey(windowId, sessionId);
}

/** Move a fresh-chat draft when the first exchange gives the chat its persistent session id. */
export function promotePromptDraft(windowId: number, sessionId: string): void {
	const previous = currentKey;
	const next = draftKey(windowId, sessionId);
	if (!previous || previous === next) return;
	if (previous !== draftKey(windowId)) throw new Error("Cannot migrate a saved chat's draft to another chat");
	const entry = readDraft(previous, true);
	writeDraft(next, entry.text, entry.revision);
	writeDraft(previous, "");
	currentKey = next;
	for (const editor of connectedEditors) {
		const binding = bindings.get(editor);
		if (binding?.key === previous) binding.key = next;
	}
}

export function clearPromptDraft(windowId: number, sessionId?: string): void {
	writeDraft(draftKey(windowId, sessionId), "");
}

/** Called by MessageEditor.connectedCallback, including when Edge reconstructs the panel. */
export function connectPromptDraft(editor: DraftEditor): void {
	connectedEditors.add(editor);
	if (!currentKey) return;
	const binding = bindings.get(editor);
	if (binding?.key !== currentKey) bindings.set(editor, { key: currentKey });
	if (!binding && editor.value) rememberPromptDraft(editor, editor.value);
	else {
		// A disconnected node missed live view updates; reconcile even if its binding is unchanged.
		const text = readDraft(currentKey, true).text;
		if (editor.value !== text) editor.value = text;
	}
}

export function disconnectPromptDraft(editor: DraftEditor): void {
	connectedEditors.delete(editor);
}

/** Setter hook catches typing, paste, programmatic setInput and intentional clears. */
export function rememberPromptDraft(editor: DraftEditor, value: string): void {
	const binding = bindings.get(editor);
	if (binding && readDraft(binding.key).text !== value) writeDraft(binding.key, value);
}

/** Do not erase text typed while an async auth/onBeforeSend hook was in flight. */
export function beginPromptSubmission(editor: DraftEditor, text: string): PromptSubmission {
	const binding = bindings.get(editor);
	if (editor.value !== text) return { binding, text, clearedRevision: undefined };
	editor.value = "";
	return { binding, text, clearedRevision: binding ? readDraft(binding.key).revision : undefined };
}

/** A rejected send restores its text, but never overwrites a newer draft or another chat. */
export function restoreRejectedPrompt(submission: PromptSubmission): void {
	const { binding, text, clearedRevision } = submission;
	if (!binding || clearedRevision === undefined) return;
	const current = readDraft(binding.key);
	if (current.revision !== clearedRevision || current.text) return;
	writeDraft(binding.key, text);
	for (const editor of connectedEditors) {
		if (bindings.get(editor)?.key === binding.key && !editor.value) editor.value = text;
	}
}

// Edge can keep more than one panel document alive for the same window. Keep those
// views of one chat in sync; a stale hidden editor must not revive an older draft.
window.addEventListener("storage", (event: StorageEvent) => {
	if (!event.key?.startsWith(PREFIX)) return;
	// A queued event may describe an older write. Treat it as an invalidation, not a snapshot.
	const { text } = readDraft(event.key, true);
	cache.set(event.key, { text, revision: ++nextRevision });
	for (const editor of connectedEditors) {
		if (bindings.get(editor)?.key === event.key && editor.value !== text) editor.value = text;
	}
});
