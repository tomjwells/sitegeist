import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { AgentInterface, ChatPanel, MessageEditor } from "@mariozechner/pi-web-ui";

export interface Snapshot {
	value: string;
	textareaValue: string;
	editorId: number;
	interfaceId: number | null;
	panelId: number | null;
	agentId: number | null;
	messages: string;
	connected: boolean;
	activeTag: string | null;
}
export interface DraftFixture {
	detach(): void;
	staleStorageEvent(windowId: number, sessionId: string, text: string): void;
	select(windowId: number, sessionId?: string): Promise<Snapshot>;
	fresh(windowId: number): Promise<Snapshot>;
	promote(windowId: number, sessionId: string): Snapshot;
	send(mode: "ok" | "reject" | "auth-cancel"): Promise<Snapshot>;
	startDelayed(stage: "prepare" | "prompt"): void;
	releaseDelayed(reject: boolean): Promise<Snapshot>;
	sendPhase(): string;
	streaming(value: boolean): Promise<Snapshot>;
	storageFailure(): void;
	warningCount(): number;
	mountEditor(): Promise<Snapshot>;
	mountChat(): Promise<Snapshot>;
	snapshot(): Snapshot;
	rerender(): Promise<Snapshot>;
	reconnect(): Promise<Snapshot>;
	replaceEditor(): Promise<Snapshot>;
	resetSameAgent(): Promise<Snapshot>;
	recreateChat(): Promise<Snapshot>;
	settle(): Promise<void>;
}
declare global {
	interface Window {
		draftFixture: DraftFixture;
	}
}

import {
	AppStorage,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import {
	clearPromptDraft,
	configurePromptDraft,
	DRAFT_STORAGE_WARNING_EVENT,
	promotePromptDraft,
} from "../src/storage/prompt-drafts.js";

const settings = new SettingsStore();
const sessions = new SessionsStore();
const providerKeys = new ProviderKeysStore();
const customProviders = new CustomProvidersStore();
const backend = new IndexedDBStorageBackend({
	dbName: "draft-fixture",
	version: 1,
	stores: [
		settings.getConfig(),
		sessions.getConfig(),
		SessionsStore.getMetadataConfig(),
		providerKeys.getConfig(),
		customProviders.getConfig(),
	],
});
for (const store of [settings, sessions, providerKeys, customProviders]) store.setBackend(backend);
setAppStorage(new AppStorage(settings, providerKeys, sessions, customProviders, backend));
let warnings = 0;
window.addEventListener(DRAFT_STORAGE_WARNING_EVENT, () => {
	warnings++;
});
let release: ((reject: boolean) => void) | undefined;
let pending: Promise<void> | undefined;
let phase = "idle";
const host = document.getElementById("host");
if (!(host instanceof HTMLElement)) throw new Error("Missing fixture host");
const hostElement = host;
const ids = new WeakMap<object, number>();
let sequence = 0;
let panel: ChatPanel | undefined;
let agent: Agent | undefined;
let editor: MessageEditor | undefined;

function objectId(object: object | undefined): number | null {
	if (!object) return null;
	const previous = ids.get(object);
	if (previous !== undefined) return previous;
	const next = ++sequence;
	ids.set(object, next);
	return next;
}
function currentEditor(): MessageEditor {
	const element = hostElement.querySelector("message-editor");
	if (!(element instanceof MessageEditor)) throw new Error("No real MessageEditor mounted");
	return element;
}
async function settle(): Promise<void> {
	if (panel) await panel.updateComplete;
	if (panel?.agentInterface) await panel.agentInterface.updateComplete;
	const current = hostElement.querySelector("message-editor");
	if (current instanceof MessageEditor) await current.updateComplete;
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
function snapshot(): Snapshot {
	const current = currentEditor();
	const textarea = current.querySelector("textarea");
	if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Missing textarea");
	const editorId = objectId(current);
	if (editorId === null) throw new Error("Missing editor ID");
	const owner = hostElement.querySelector("agent-interface");
	return {
		value: current.value,
		textareaValue: textarea.value,
		editorId,
		interfaceId: owner instanceof AgentInterface ? objectId(owner) : null,
		panelId: objectId(panel),
		agentId: objectId(agent),
		messages: JSON.stringify(agent?.state.messages ?? []),
		connected: current.isConnected,
		activeTag: document.activeElement?.tagName ?? null,
	};
}
function makeAgent(messages?: AgentMessage[]): Agent {
	return new Agent({
		initialState: {
			messages: messages ?? [{ role: "user", content: "Previously saved session message", timestamp: 1 }],
			thinkingLevel: "off",
		},
		streamFn: () => {
			throw new Error("Model inference forbidden in this fixture");
		},
		getApiKey: () => undefined,
	});
}
async function mountWithAgent(nextAgent: Agent): Promise<Snapshot> {
	agent = nextAgent;
	panel = new ChatPanel();
	hostElement.replaceChildren(panel);
	await panel.setAgent(agent, { onApiKeyRequired: async () => true });
	agent.prompt = async () => {};
	await settle();
	editor = currentEditor();
	return snapshot();
}
window.draftFixture = {
	detach() {
		const node = panel ?? editor;
		if (!node) throw new Error("Nothing mounted");
		node.remove();
	},
	staleStorageEvent(windowId, sessionId, text) {
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: `sitegeist.prompt-draft.v1:${windowId}:session:${sessionId}`,
				newValue: text,
				storageArea: localStorage,
			}),
		);
	},
	async select(windowId, sessionId) {
		configurePromptDraft(windowId, sessionId);
		return mountWithAgent(makeAgent());
	},
	async fresh(windowId) {
		clearPromptDraft(windowId);
		configurePromptDraft(windowId);
		return mountWithAgent(makeAgent());
	},
	promote(windowId, sessionId) {
		promotePromptDraft(windowId, sessionId);
		return snapshot();
	},
	async send(mode) {
		if (!agent || !panel?.agentInterface) throw new Error("No mounted chat");
		panel.agentInterface.onApiKeyRequired = async () => mode !== "auth-cancel";
		agent.prompt = async () => {
			if (mode === "reject") throw new Error("Expected rejected send");
		};
		try {
			await panel.agentInterface.sendMessage(currentEditor().value, currentEditor().attachments);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Expected rejected send") throw error;
		}
		await settle();
		return snapshot();
	},
	startDelayed(stage) {
		if (!agent || !panel?.agentInterface) throw new Error("No mounted chat");
		const gate = async () => {
			phase = stage;
			await new Promise<void>((resolve, reject) => {
				release = (fail) => (fail ? reject(new Error("Expected delayed rejection")) : resolve());
			});
		};
		panel.agentInterface.onApiKeyRequired = async () => true;
		panel.agentInterface.onBeforeSend = stage === "prepare" ? gate : undefined;
		agent.prompt = stage === "prompt" ? gate : async () => {};
		pending = panel.agentInterface
			.sendMessage(currentEditor().value, currentEditor().attachments)
			.catch((error: unknown) => {
				if (!(error instanceof Error) || error.message !== "Expected delayed rejection") throw error;
			});
	},
	async releaseDelayed(reject) {
		if (!release || !pending) throw new Error("No pending send");
		release(reject);
		await pending;
		release = undefined;
		pending = undefined;
		phase = "idle";
		await settle();
		return snapshot();
	},
	sendPhase: () => phase,
	async streaming(value) {
		if (!agent || !panel?.agentInterface) throw new Error("No mounted chat");
		agent.state.isStreaming = value;
		panel.agentInterface.requestUpdate();
		await settle();
		return snapshot();
	},
	storageFailure() {
		Storage.prototype.setItem = () => {
			throw new DOMException("Quota exceeded", "QuotaExceededError");
		};
	},
	warningCount: () => warnings,
	async mountEditor() {
		panel = undefined;
		agent = undefined;
		editor = new MessageEditor();
		hostElement.replaceChildren(editor);
		await settle();
		return snapshot();
	},
	mountChat: () => mountWithAgent(makeAgent()),
	snapshot,
	async rerender() {
		editor?.requestUpdate();
		panel?.agentInterface?.requestUpdate();
		panel?.requestUpdate();
		await settle();
		return snapshot();
	},
	async reconnect() {
		const node = panel ?? editor;
		if (!node) throw new Error("Nothing mounted");
		node.remove();
		hostElement.append(node);
		await settle();
		return snapshot();
	},
	async replaceEditor() {
		const previous = currentEditor();
		editor = new MessageEditor();
		previous.replaceWith(editor);
		await settle();
		return snapshot();
	},
	async resetSameAgent() {
		if (!panel || !agent) throw new Error("No chat mounted");
		await panel.setAgent(agent);
		await settle();
		editor = currentEditor();
		return snapshot();
	},
	async recreateChat() {
		if (!agent) throw new Error("No chat mounted");
		return mountWithAgent(makeAgent(agent.state.messages));
	},
	settle,
};
