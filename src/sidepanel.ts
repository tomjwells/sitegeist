import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getModel, getModels, type Model } from "@mariozechner/pi-ai";
import {
	ChatPanel,
	createExtractDocumentTool,
	createStreamFn,
	ModelSelector,
	ProxyTab,
	SettingsDialog,
	// PersistentStorageDialog,
	setAppStorage,
	setShowJsonMode,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { History, Minus, Plus, Settings } from "lucide";
import { SESSIONS_SIDEBAR_OPEN_SETTING, type SessionsSidebar } from "./components/SessionsSidebar.js";
import { AboutTab } from "./dialogs/AboutTab.js";
import { ApiKeyOrOAuthDialog } from "./dialogs/ApiKeyOrOAuthDialog.js";
import { ApiKeysOAuthTab } from "./dialogs/ApiKeysOAuthTab.js";
import { CostsTab } from "./dialogs/CostsTab.js";
import { InstructionsTab } from "./dialogs/InstructionsTab.js";
import { SessionCostDialog } from "./dialogs/SessionCostDialog.js";
import { catalogProviders, isCatalogProvider } from "./models-registry.js";
import "./components/SessionsSidebar.js";
import { SkillsTab } from "./dialogs/SkillsTab.js";
import { UpdateNotificationDialog } from "./dialogs/UpdateNotificationDialog.js";
import { UserScriptsPermissionDialog } from "./dialogs/UserScriptsPermissionDialog.js";
import { WelcomeSetupDialog } from "./dialogs/WelcomeSetupDialog.js";
import { browserMessageTransformer } from "./messages/message-transformer.js";
import {
	createNavigationMessage,
	type NavigationMessage,
	registerNavigationRenderer,
} from "./messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "./messages/UserMessageRenderer.js";
import { createWelcomeMessage, registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
import { registerModels } from "./models-registry.js";
import { isOAuthCredentials, resolveApiKey } from "./oauth/index.js";
import { PrimeModelPicker } from "./prime/PrimeModelPicker.js";
import {
	agentIdFromSessionId,
	isPrimeSessionId,
	MAIN_AGENT_ID,
	PrimeRemoteAgent,
	stripBrowserContext,
} from "./prime/prime-agent.js";
import { type PrimeAttachment, primeAgents } from "./prime/prime-client.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { SitegeistAppStorage } from "./storage/app-storage.js";
import { DebuggerTool } from "./tools/debugger.js";
import { ExtractImageTool, registerExtractImageRenderer } from "./tools/extract-image.js";
import { AskUserWhichElementTool, skillTool } from "./tools/index.js";
import { NativeInputEventsRuntimeProvider } from "./tools/NativeInputEventsRuntimeProvider.js";
import { isToolNavigating, NavigateTool } from "./tools/navigate.js";
import { createReplTool } from "./tools/repl/repl.js";
import {
	BrowserJsRuntimeProvider,
	FetchRuntimeProvider,
	NavigateRuntimeProvider,
} from "./tools/repl/runtime-providers.js";
import * as port from "./utils/port.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";
import { proxyToken, syncWithServer } from "./sync.js";
import { tutorials } from "./tutorials.js";

// Register custom message renderers
registerNavigationRenderer();
registerExtractImageRenderer();

// Listen for abort messages from REPL overlay
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log("[Sidepanel] Received message:", message, "from:", sender);
	if (message.type === "abort-repl") {
		console.log("[Sidepanel] Abort-repl message received, agent streaming:", agent?.state.isStreaming);
		if (agent?.state.isStreaming) {
			console.log("[Sidepanel] Aborting agent...");
			agent.abort();
			sendResponse({ success: true });
		} else {
			console.log("[Sidepanel] Agent not streaming, ignoring");
			sendResponse({ success: false, reason: "not-streaming" });
		}
		return true; // Keep channel open for async response
	}
});

// ============================================================================
// STORAGE SETUP
// ============================================================================
const storage = new SitegeistAppStorage();

export const CUSTOM_INSTRUCTIONS_SETTING = "customInstructions";

/** SYSTEM_PROMPT plus the user's custom instructions from Settings → Instructions, if any. */
const buildSystemPrompt = async (): Promise<string> => {
	const custom = (await storage.settings.get<string>(CUSTOM_INSTRUCTIONS_SETTING))?.trim();
	if (!custom) return SYSTEM_PROMPT;
	return `${SYSTEM_PROMPT}\n\n# User Instructions\nThe user set these standing instructions in Settings. Follow them in every session:\n${custom}`;
};

export const MODEL_CATALOG_URL_SETTING = "models.catalogUrl";
export const DEFAULT_MODEL_CATALOG_URL = "https://cors-proxy.tjw-private/models";

/**
 * Fetch { models: { provider: { id: Model } } } from the configured catalog URL and merge it into the
 * model registry (src/models-registry.ts). Best effort: a missing/failed catalog just leaves the
 * bundled list in place. Bounded to a few seconds so startup is never blocked for long.
 */
const refreshModelCatalog = async (): Promise<void> => {
	const stored = await storage.settings.get<string>(MODEL_CATALOG_URL_SETTING);
	const url = (stored ?? DEFAULT_MODEL_CATALOG_URL).trim();
	if (!url) return;
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = (await response.json()) as { version?: unknown; models?: unknown };
		const count = registerModels(body.models);
		console.info(`[Models] catalog ${String(body.version ?? "?")} from ${url}: ${count} models registered`);
	} catch (error) {
		console.warn(`[Models] catalog fetch failed (${url}), using bundled list:`, error);
	}
};
setAppStorage(storage);

// ============================================================================
// APP STATE
// ============================================================================
let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let sessionsSidebarOpen = false;
/** Header +/-: collapse every tool call to a one-line row, or expand them all (incl. their inner sections). */
let toolCallsCollapsed = false;
export const TOOL_CALLS_COLLAPSED_SETTING = "ui.toolCallsCollapsed";
let agent: Agent;
let chatPanel: ChatPanel;
/** Which brain drives the current session: the in-browser agent (default) or a relay agent id ("prime" = main-pi, or a worker). */
type AgentKind = string;
let agentKind: AgentKind = "browser";
let agentOptions: { value: string; label: string }[] = [
	{ value: "browser", label: "Browser agent" },
	{ value: MAIN_AGENT_ID, label: "prime-agent" },
];
const agentLabelFor = (id: string): string => agentOptions.find((o) => o.value === id)?.label ?? id;
/** Refresh the agent dropdown from the relay (main-pi + worker prime sidecars); keeps the static pair on failure. */
const refreshAgentOptions = async (): Promise<void> => {
	try {
		const list = await primeAgents();
		if (list.length === 0) return;
		agentOptions = [
			{ value: "browser", label: "Browser agent" },
			...list.map((a) => ({ value: a.id, label: a.ok ? a.label : `${a.label} (offline)` })),
		];
	} catch (err) {
		console.warn("[prime] agent list unavailable", err);
	}
};
const isPrimeAgent = (a: Agent | undefined): a is PrimeRemoteAgent => a instanceof PrimeRemoteAgent;
let agentUnsubscribe: (() => void) | undefined;
let currentWindowId: number;

// Track which skills we've shown in full (skillName -> lastUpdated timestamp)
// Reset when a new session/agent is created
const shownSkills = new Map<string, string>();

// Track which messages we've already recorded costs for (avoid duplicates)
// Use Set with message object identity (not cleared on session switch - persists in memory)
const recordedCostMessages = new Set<AgentMessage>();

// Cached auth type label for the current provider
let authLabel = "";

const DEFAULT_MODELS: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-sonnet-4-6",
	"azure-openai-responses": "gpt-5.2",
	cerebras: "zai-glm-4.6",
	"github-copilot": "gpt-4o",
	google: "gemini-2.5-flash",
	"google-antigravity": "gemini-3.1-pro-high",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-vertex": "gemini-3-pro-preview",
	groq: "openai/gpt-oss-20b",
	huggingface: "moonshotai/Kimi-K2.5",
	"kimi-coding": "kimi-k2-thinking",
	minimax: "MiniMax-M2.1",
	"minimax-cn": "MiniMax-M2.1",
	mistral: "devstral-medium-latest",
	openai: "gpt-4o-mini",
	"openai-codex": "gpt-5.1-codex-mini",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.6",
};

async function selectDefaultModelForAvailableProvider() {
	const providers = await getProvidersWithKeys();
	if (providers.length === 0 || !agent) return;

	// Try each provider with keys and find a default model
	for (const provider of providers) {
		const modelId = DEFAULT_MODELS[provider];
		if (modelId) {
			const model = getModel(provider as any, modelId);
			if (model) {
				agent.setModel(model);
				await storage.settings.set("lastUsedModel", model);
				await updateAuthLabel();
				renderApp();
				return;
			}
		}
	}

	// If no default found, try the first model for the first provider with a key
	for (const provider of providers) {
		const models = getModels(provider as any);
		if (models.length > 0) {
			agent.setModel(models[0]);
			await storage.settings.set("lastUsedModel", models[0]);
			await updateAuthLabel();
			renderApp();
			return;
		}
	}
}

/**
 * Providers the Browser agent can use: those served by the proxy catalog (callable with the shared proxy
 * token - the proxy injects the real credential, see /upstream on cors-proxy) plus any the user holds a
 * key/login for.
 */
async function getProvidersWithKeys(): Promise<string[]> {
	const result = new Set<string>();
	if (await proxyToken()) for (const provider of catalogProviders()) result.add(provider);
	for (const provider of await storage.providerKeys.list()) {
		const key = await storage.providerKeys.get(provider);
		if (key) result.add(provider);
	}
	return Array.from(result);
}

async function hasAnyApiKey(): Promise<boolean> {
	if ((await proxyToken()) && catalogProviders().length > 0) return true;
	const providers = await storage.providerKeys.list();
	return providers.length > 0;
}

function openApiKeysDialog(): Promise<void> {
	return new Promise((resolve) => {
		SettingsDialog.open(
			[
				new ApiKeysOAuthTab(),
				new InstructionsTab(),
				new CostsTab(),
				new SkillsTab(),
				new ProxyTab(),
				new AboutTab(),
			],
			resolve,
		);
	});
}

async function updateAuthLabel() {
	if (!agent) {
		authLabel = "";
		return;
	}
	const provider = agent.state.model.provider;
	const stored = await storage.providerKeys.get(provider);
	if (isCatalogProvider(provider) && (await proxyToken())) {
		authLabel = "via proxy";
	} else if (!stored) {
		authLabel = "";
	} else if (isOAuthCredentials(stored)) {
		authLabel = "subscription";
	} else {
		authLabel = "api key";
	}
}

// Export getter for message transformer
export function getShownSkills(): Map<string, string> {
	return shownSkills;
}

// ============================================================================
// HELPERS
// ============================================================================
const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg || firstUserMsg.role !== "user") return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c) => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: AgentMessage) => m.role === "user");
	const hasAssistantMsg = messages.some((m: AgentMessage) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Calculate cumulative usage from all assistant messages
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		for (const msg of state.messages) {
			if (msg.role === "assistant") {
				usage.input += msg.usage.input;
				usage.output += msg.usage.output;
				usage.cacheRead += msg.usage.cacheRead;
				usage.cacheWrite += msg.usage.cacheWrite;
				usage.totalTokens += msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				if (msg.usage.cost) {
					usage.cost.input += msg.usage.cost.input;
					usage.cost.output += msg.usage.cost.output;
					usage.cost.cacheRead += msg.usage.cost.cacheRead;
					usage.cost.cacheWrite += msg.usage.cost.cacheWrite;
					usage.cost.total += msg.usage.cost.total;
				}
			}
		}

		// Generate preview text (first 2KB of user + assistant text)
		let preview = "";
		for (const msg of state.messages) {
			if (preview.length >= 2048) break;
			if (msg.role === "user") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n") || "";
				preview += `${text}\n`;
			} else if (msg.role === "assistant") {
				const text = msg.content
					.filter((c) => c.type === "text" || c.type === "thinking")
					.map((c) => (c.type === "text" ? c.text : c.thinking))
					.join("\n");
				preview += `${text}\n`;
			}
		}
		preview = preview.substring(0, 2048);

		// Preserve createdAt if session already exists
		const existingMetadata = await storage.sessions.getMetadata(currentSessionId);
		const createdAt = existingMetadata?.createdAt || new Date().toISOString();

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt,
			lastModified: new Date().toISOString(),
			messageCount: state.messages.length,
			usage,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
			preview,
		};

		await storage.sessions.saveSession(currentSessionId, state, metadata, currentTitle);
		refreshSessionsSidebar();
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

const createAgent = async (
	initialState?: Partial<AgentState>,
	shouldSave = true,
	kind: AgentKind = "browser",
	primeSessionId?: string,
) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}
	if (isPrimeAgent(agent)) agent.detach();
	agentKind = kind;

	// Mark all loaded messages as already recorded (by object identity)
	for (const msg of initialState?.messages || []) {
		if (msg.role === "assistant" && msg.usage?.cost?.total > 0) {
			recordedCostMessages.add(msg);
		}
	}

	// Reset skill tracking for new session
	// When loading an old session, we intentionally don't reconstruct shownSkills
	// This ensures that new navigations in the continued session show the LATEST
	// version of skills, even if they were updated since the session was created
	shownSkills.clear();

	// Load debugger mode setting
	const stored = await chrome.storage.local.get("debuggerMode");
	const debuggerModeEnabled = stored.debuggerMode || false;

	// Always (re)apply the current system prompt + custom instructions, also to restored sessions
	const systemPrompt = await buildSystemPrompt();
	initialState = initialState ? { ...initialState, systemPrompt } : undefined;

	// Load CORS proxy settings for extract_document tool
	const corsProxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const corsProxyUrl = await storage.settings.get<string>("proxy.url");

	// Determine default model: saved > default for a provider with key > gemini flash fallback
	let defaultModel: Model<any> | undefined;
	if (!initialState?.model) {
		const savedModel = await storage.settings.get<Model<any>>("lastUsedModel");
		if (savedModel) {
			defaultModel = savedModel;
		} else {
			// Try to find a default model for a provider the user already has a key for
			const providersWithKeys = await getProvidersWithKeys();
			for (const provider of providersWithKeys) {
				const modelId = DEFAULT_MODELS[provider];
				if (modelId) {
					const model = getModel(provider as any, modelId);
					if (model) {
						defaultModel = model;
						break;
					}
				}
			}
		}
	}
	// Final fallback
	if (!defaultModel && !initialState?.model) {
		defaultModel = getModel("anthropic", "claude-sonnet-4-6");
	}

	if (kind !== "browser") {
		// Brain on the R730 (a prime bridge session: main-pi or a worker sidecar), hands in this browser. The bridge reports the real
		// model/thinking on create/hydrate; the placeholder only has to be a valid Model until then.
		const placeholder =
			initialState?.model ??
			getModels("anthropic").find((m) => m.id === "claude-opus-4-8") ??
			getModel("anthropic", "claude-sonnet-4-6") ??
			defaultModel;
		if (!placeholder) throw new Error("No model available for the prime placeholder");
		const prime: PrimeRemoteAgent = new PrimeRemoteAgent({
			agentId: kind,
			agentLabel: agentLabelFor(kind),
			sessionId: primeSessionId,
			model: placeholder,
			thinkingLevel: initialState?.thinkingLevel ?? "high",
			messages: initialState?.messages ?? [],
			windowId: currentWindowId,
			tabContext: async (): Promise<string> => {
				const [tab] = await chrome.tabs.query({ active: true, windowId: currentWindowId });
				const where =
					tab?.url && !tab.url.startsWith("chrome-extension://")
						? `Active tab: "${tab.title ?? ""}" ${tab.url}`
						: "Active tab: (none)";
				const matching = tab?.url ? await storage.skills.getSkillsForUrl(tab.url).catch(() => []) : [];
				const skillsLine =
					matching.length > 0
						? ` Sitegeist skills for this page (auto-injected into browser_eval; browser_skill get <name> for docs): ${matching.map((sk) => `${sk.name} — ${sk.shortDescription}`).join("; ")}.`
						: "";
				const first: boolean = prime.state.messages.length === 0;
				// Only main-pi owns the extension/relay code; workers get the same tools but not the "fix it yourself" pointer.
				const codeNote =
					kind === MAIN_AGENT_ID
						? " Site runbooks: before driving a site with browser_* tools, agent_wiki_read main-pi-agent → 'Site runbooks — how to drive specific sites from the sitegeist panel' (page 01a06f49-71c8-7c6a-9b17-ddd04df32bc1) and reuse its selectors/flow; after you work out a NEW site or task (selectors, flow, verification), append a dated section to that page in the same turn so next time it is one call. If a browser tool misbehaves, the code is local: extension fork /home/vscode/code/sitegeist (branch homelab-fixes; browser side src/prime/browser-tools.ts), prime side ~/.prime/agent/extensions/sitegeist-browser-tools.ts, relay in the cors-proxy stack (~/.pi/agent/tool-projects/cors-proxy/server.ts)."
						: " If a browser tool errors, say so plainly and carry on without it (main-pi owns the browser bridge).";
				return first
					? `[sitegeist browser context] Tom is driving this session from the sitegeist-dev side panel in his browser (not Telegram). ${where}. Browser tools available while the panel is open: browser_tabs, browser_screenshot (also saves a PNG path), browser_page, browser_eval, browser_navigate, browser_cookies, browser_upload_file (file from this host into a page), browser_pick_element (Tom clicks an element), browser_skill + browser_instructions (sitegeist's shared skills and custom instructions — first-class, synced; never edit ~/.pi/agent/sitegeist-sync by hand). Tab-acting tools bring their tab to the front so Tom can watch; pass background:true only if he asks you to work quietly. To give Tom a file (any type, incl. HTML apps that render), call telegram_attach with its path: in this browser session it lands in the side panel's artifacts panel, not Telegram.${codeNote} Reply in the chat; keep answers tight.${skillsLine} [/sitegeist browser context]`
					: `[sitegeist browser context] ${where}.${skillsLine} [/sitegeist browser context]`;
			},
		});
		prime.onStatusChange = () => renderApp();
		prime.onAttachments = async (items: PrimeAttachment[]) => {
			// telegram_attach in a browser session: the artifacts panel is the destination. Text-like files
			// are decoded, binaries stay base64 (what ImageArtifact/PdfArtifact/GenericArtifact expect).
			const panel = chatPanel.artifactsPanel;
			if (!panel) throw new Error("artifacts panel not ready");
			for (const item of items) {
				const bytes = Uint8Array.from(atob(item.dataBase64), (c) => c.charCodeAt(0));
				const textLike =
					/^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv))/.test(item.mime) ||
					/\.(html?|md|markdown|svg|txt|json|csv|tsv|js|ts|css|xml|ya?ml|log)$/i.test(item.filename);
				const content = textLike ? new TextDecoder().decode(bytes) : item.dataBase64;
				const command = panel.artifacts.has(item.filename) ? "rewrite" : "create";
				const result = await panel.tool.execute(`prime-attach-${item.id}`, {
					command,
					filename: item.filename,
					content,
				});
				const summary = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
				if (/^Error/.test(summary)) throw new Error(summary);
				// Record it the way pi-web-ui expects so the panel is rebuilt from history on reload
				prime.appendMessage({
					role: "artifact",
					action: command === "create" ? "create" : "update",
					filename: item.filename,
					content,
					title: item.caption || undefined,
					timestamp: new Date().toISOString(),
				});
			}
			renderApp();
		};
		agent = prime;
	} else {
		agent = new Agent({
			initialState: initialState || {
				systemPrompt,
				model: defaultModel,
				thinkingLevel: "medium",
				messages: [],
				tools: [],
			},
			convertToLlm: browserMessageTransformer,
			toolExecution: "sequential",
			streamFn: createStreamFn(async () => {
				const enabled = await storage.settings.get<boolean>("proxy.enabled");
				if (!enabled) return undefined;
				return (await storage.settings.get<string>("proxy.url")) || undefined;
			}),
			getApiKey: async (provider: string) => {
				// Catalog providers are called through the proxy (their baseUrl points at /upstream/<provider>);
				// the shared proxy token is the credential, the proxy swaps in the real one.
				if (isCatalogProvider(provider)) {
					const token = await proxyToken();
					if (token) return token;
				}
				const stored = await storage.providerKeys.get(provider);
				if (!stored) return undefined;
				const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
				const proxyUrl = proxyEnabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
				return resolveApiKey(stored, provider, storage.providerKeys, proxyUrl);
			},
		});
	}

	await updateAuthLabel();

	if (shouldSave) {
		agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
			const messages = agent.state.messages;

			if (!isPrimeAgent(agent)) {
				storage.settings
					.set("lastUsedModel", agent.state.model)
					.catch((err) => console.error("Failed to save lastUsedModel:", err));
			}

			// Update auth label when model changes
			updateAuthLabel().catch(() => {});

			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.usage?.cost?.total > 0
			) {
				if (!recordedCostMessages.has(event.message)) {
					recordedCostMessages.add(event.message);
					storage.costs
						.recordCost(agent.state.model.provider, agent.state.model.id, event.message.usage.cost.total)
						.catch((err) => console.error("Failed to record cost:", err));
				}
			}

			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}

			if (!currentSessionId && shouldSaveSession(messages)) {
				// prime sessions reuse the bridge session id, so the sidebar entry IS the native harness session
				currentSessionId = isPrimeAgent(agent) && agent.primeSessionId ? agent.primeSessionId : crypto.randomUUID();
				if (isPrimeAgent(agent) && currentTitle) void agent.rename(currentTitle);

				port
					.sendMessage({
						type: "acquireLock",
						sessionId: currentSessionId,
						windowId: currentWindowId,
					})
					.then((lockResponse) => {
						if (!lockResponse.success) {
							console.warn("Failed to acquire lock for newly created session", currentSessionId);
						}
					});
				updateUrl(currentSessionId);
			}

			if (currentSessionId) {
				saveSession();
			}

			renderApp();
		});
	}

	await chatPanel.setAgent(agent, {
		sandboxUrlProvider: () => {
			return chrome.runtime.getURL("sandbox.html");
		},
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyOrOAuthDialog.prompt(provider);
		},
		onModelSelect: async () => {
			if (isPrimeAgent(agent)) {
				const prime = agent;
				let models: Model<any>[] = [];
				let failure = "";
				try {
					models = await prime.availableModels();
				} catch (err) {
					failure = err instanceof Error ? err.message : String(err);
					console.warn("[prime] model list failed", err);
				}
				if (models.length === 0) {
					alert(`prime-agent model list unavailable${failure ? `: ${failure}` : ""}`);
					return;
				}
				PrimeModelPicker.open(models, prime.remoteModel, (model) => {
					prime.setModel(model);
					chatPanel.agentInterface?.requestUpdate();
					renderApp();
				});
				return;
			}
			const providers = await getProvidersWithKeys();
			if (providers.length === 0) {
				openApiKeysDialog();
				return;
			}
			ModelSelector.open(
				agent.state.model,
				(model) => {
					agent.setModel(model);
					chatPanel.agentInterface?.requestUpdate();
					updateAuthLabel().catch(() => {});
					renderApp();
				},
				providers,
			);
		},
		onBeforeSend: async () => {
			if (!agent || isPrimeAgent(agent)) return; // prime gets its page context inside the prompt itself

			// Get current tab info
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			if (!tab?.url || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("moz-extension://")) return;

			// Find most recent navigation (either nav message or nav tool result)
			let lastUrl: string | undefined;
			for (let i = agent.state.messages.length - 1; i >= 0; i--) {
				const msg = agent.state.messages[i];
				if (msg.role === "navigation") {
					lastUrl = (msg as NavigationMessage).url;
					break;
				}
				if (msg.role === "toolResult" && (msg as any).toolName === "navigate") {
					lastUrl = (msg as any).details?.finalUrl;
					break;
				}
			}

			// Only add if URL changed
			if (!lastUrl || lastUrl !== tab.url) {
				const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
				agent.appendMessage(navMessage);
			}
		},
		onCostClick: () => {
			if (!agent) return;
			SessionCostDialog.open(agent.state.messages);
		},
		toolsFactory: (agent, _agentInterface, artifactsPanel, runtimeProvidersFactory) => {
			if (isPrimeAgent(agent)) return []; // prime's tools run on the R730; browser hands are served over the relay socket
			const navigateTool = new NavigateTool();
			const selectElementTool = new AskUserWhichElementTool();

			// Create extract_document tool with CORS proxy from settings (loaded above)
			const extractDocumentTool = createExtractDocumentTool();
			if (corsProxyEnabled && corsProxyUrl) {
				extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
			}

			const replTool = createReplTool();
			replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");

			// Extend base providers with browser orchestration capabilities
			replTool.runtimeProvidersFactory = () => {
				// Providers that should be available in page context via browserjs()
				const pageProviders = [
					...runtimeProvidersFactory(), // attachments + artifacts from ChatPanel
					new NativeInputEventsRuntimeProvider(), // trusted browser events
				];

				return [
					...pageProviders, // Make them available in REPL context too
					new BrowserJsRuntimeProvider(pageProviders), // Pass to page context
					new NavigateRuntimeProvider(navigateTool),
					new FetchRuntimeProvider(), // fetch() relay for URLs the sandbox CSP blocks
				];
			};

			const extractImageTool = new ExtractImageTool();
			extractImageTool.windowId = currentWindowId;
			extractImageTool.artifactsPanel = artifactsPanel;
			extractImageTool.agent = agent;

			const tools: AgentTool<any, any>[] = [
				navigateTool,
				selectElementTool,
				replTool,
				skillTool,
				extractDocumentTool,
				extractImageTool,
			];

			// Conditionally add debugger tool if enabled
			if (debuggerModeEnabled) {
				const debuggerTool = new DebuggerTool();
				tools.push(debuggerTool);
			}

			return tools;
		},
	});

	if (isPrimeAgent(agent) && agent.primeSessionId) {
		try {
			await agent.attach();
		} catch (err) {
			console.error("[prime] attach failed", err);
		}
	}

	// Register custom message renderers after agentInterface is available
	if (chatPanel.agentInterface) {
		registerWelcomeRenderer(agent, chatPanel.agentInterface);

		// Only disable auto-scroll for new sessions with welcome message
		// Check if this is a fresh session (only has welcome message, no user messages)
		const hasUserMessage = agent.state.messages.some((m) => m.role === "user");
		if (!hasUserMessage) {
			chatPanel.agentInterface.setAutoScroll(false);

			// Re-enable auto-scroll on first user message
			let unsubscribe: (() => void) | undefined;
			unsubscribe = agent.subscribe(() => {
				const hasUserMsg = agent.state.messages.some((m) => m.role === "user");
				if (hasUserMsg && unsubscribe) {
					chatPanel.agentInterface?.setAutoScroll(true);
					unsubscribe();
				}
			});
		}
	}
};

const loadSession = (sessionId: string) => {
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
};

const newSession = (kind: AgentKind = "browser") => {
	// Navigation will disconnect port and auto-release locks. New sessions default to the browser agent (Tom, 2026-09-05).
	const url = new URL(window.location.href);
	url.search = kind !== "browser" ? `?new=true&agent=${encodeURIComponent(kind)}` : "?new=true";
	window.location.href = url.toString();
};

/** Per-session agent choice: swap in place while the session is still empty, otherwise start a fresh one. */
const switchAgentKind = async (kind: AgentKind) => {
	if (kind === agentKind) return;
	const hasUserMessage = agent?.state.messages.some((m) => m.role === "user");
	if (hasUserMessage || currentSessionId) {
		newSession(kind);
		return;
	}
	await createAgent(undefined, true, kind);
	if (kind === "browser" && agent) agent.appendMessage(createWelcomeMessage(tutorials));
	renderApp();
};

// ============================================================================
// RENDER
// ============================================================================
const renderApp = () => {
	const appHtml = html`
		<div class="w-full h-full flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-3 py-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => toggleSessionsSidebar(!sessionsSidebarOpen),
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: () => newSession(),
						title: "New Session",
					})}
					${
						// Agent is a choice for a brand-new session only (Tom, 2026-09-05): once anything has been sent the
						// session is bound to its harness, so the control disappears (the model label still says prime/local).
						!currentSessionId && !agent?.state.messages.some((m) => m.role === "user")
							? Select({
									value: agentKind,
									options: agentOptions,
									onChange: (value: string) => void switchAgentKind(value),
									size: "sm",
									variant: "ghost",
									fitContent: true,
									className: "text-xs",
								})
							: ""
					}
					${
						isPrimeAgent(agent)
							? html`<span
									class="inline-block w-2 h-2 rounded-full ${agent.status === "open" ? "bg-green-500" : agent.status === "error" || agent.status === "closed" ? "bg-red-500" : agent.status === "idle" ? "bg-muted-foreground/40" : "bg-yellow-500"}"
									title="prime-agent: ${agent.status}${agent.statusDetail ? ` (${agent.statusDetail})` : ""}${agent.primeSessionId ? ` · ${agent.primeSessionId}` : " · session starts with the first message"}"
								></span>`
							: ""
					}

					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-48",
										/*
										TODO need to add this in Input in mini-lit
										onBlur: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},*/
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-xs text-foreground hover:bg-secondary rounded transition-colors truncate max-w-[150px]"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = document.body.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: html``
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${
						isPrimeAgent(agent)
							? html`<span class="text-[10px] text-muted-foreground truncate max-w-[160px]" title="${agent.agentLabel} · ${agent.remoteModel?.provider ?? ""}/${agent.state.model.id} on the R730">${agent.agentLabel} · ${agent.state.model.id}</span>`
							: agent
								? html`<span class="text-[10px] text-muted-foreground truncate max-w-[120px]" title="${agent.state.model.provider}/${agent.state.model.id}${authLabel ? ` (${authLabel})` : ""}">${agent.state.model.provider}${authLabel ? html` <span class="text-[9px] opacity-70">${authLabel}</span>` : ""}</span>`
								: ""
					}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(toolCallsCollapsed ? Plus : Minus, "sm"),
						onClick: () => applyToolCallsCollapsed(!toolCallsCollapsed),
						title: toolCallsCollapsed ? "Expand all tool calls" : "Collapse all tool calls",
					})}
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () =>
							SettingsDialog.open([
								new ApiKeysOAuthTab(),
								new InstructionsTab(),
								new CostsTab(),
								new SkillsTab(),
								new ProxyTab(),
								new AboutTab(),
							]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel + sessions sidebar overlay -->
			<div class="relative flex-1 min-h-0 flex flex-col">
				${chatPanel}
				<sessions-sidebar
					.open=${sessionsSidebarOpen}
					.currentSessionId=${currentSessionId}
					.onSelect=${(sessionId: string) => loadSession(sessionId)}
					.onNew=${() => newSession()}
					.onDeleted=${(deletedSessionId: string) => {
						// Only reload if the current session was deleted
						if (deletedSessionId === currentSessionId) newSession();
					}}
					.onToggle=${(open: boolean) => toggleSessionsSidebar(open)}
				></sessions-sidebar>
			</div>
		</div>
	`;

	render(appHtml, document.body);
};

const applyToolCallsCollapsed = (collapsed: boolean) => {
	toolCallsCollapsed = collapsed;
	globalThis.__sgToolCallsCollapsed = collapsed;
	void storage.settings.set(TOOL_CALLS_COLLAPSED_SETTING, collapsed);
	for (const el of document.querySelectorAll("tool-message")) {
		const card = el as HTMLElement & { sgForceExpanded?: boolean; requestUpdate?: () => void };
		card.sgForceExpanded = false;
		card.requestUpdate?.();
	}
	if (!collapsed) {
		// Expand all = also open every card's own collapsible section (renderCollapsibleHeader pattern + expandable-section)
		requestAnimationFrame(() => {
			for (const content of document.querySelectorAll("tool-message div.overflow-hidden.transition-all")) {
				if (!content.classList.contains("max-h-0")) continue;
				content.classList.remove("max-h-0");
				content.classList.add("max-h-[2000px]", "mt-3");
				const header = content.previousElementSibling;
				header?.querySelector(".chevron-up")?.classList.remove("hidden");
				header?.querySelector(".chevrons-up-down")?.classList.add("hidden");
			}
			for (const section of document.querySelectorAll("expandable-section"))
				(section as HTMLElement & { expanded?: boolean }).expanded = true;
		});
	}
	renderApp();
};

const toggleSessionsSidebar = (open: boolean) => {
	sessionsSidebarOpen = open;
	void storage.settings.set(SESSIONS_SIDEBAR_OPEN_SETTING, open);
	renderApp();
};

const isSessionsSidebar = (el: Element | null): el is SessionsSidebar =>
	el !== null && el.tagName.toLowerCase() === "sessions-sidebar";

const refreshSessionsSidebar = () => {
	const el = document.querySelector("sessions-sidebar");
	if (isSessionsSidebar(el) && sessionsSidebarOpen) void el.refresh();
};

// ============================================================================
// TAB NAVIGATION TRACKING
// ============================================================================

// Listen for tab updates and insert navigation messages only when agent is running
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
	// Only care about URL changes on the active tab while agent is working
	// Ignore chrome-extension:// URLs (extension internal pages)
	// Ignore tool-initiated navigations (handled by the navigate tool itself)
	// Ignore tabs from other windows
	if (
		changeInfo.url &&
		tab.active &&
		tab.url &&
		tab.windowId === currentWindowId &&
		agent?.state.isStreaming &&
		!tab.url.startsWith("chrome-extension://") &&
		!tab.url.startsWith("moz-extension://") &&
		!isToolNavigating()
	) {
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.steer(navMessage);
		console.log("Queued navigation message for tab switch to", tab.url);
	}
});

// Listen for tab activation (user switches tabs) only when agent is running
chrome.tabs.onActivated.addListener(async (activeInfo) => {
	// Ignore tab activations from other windows
	if (activeInfo.windowId !== currentWindowId) return;

	const tab = await chrome.tabs.get(activeInfo.tabId);
	// Ignore chrome-extension:// URLs (extension internal pages)
	// Ignore tool-initiated navigations (handled by the navigate tool itself)
	if (
		tab.url &&
		agent?.state.isStreaming &&
		!tab.url.startsWith("chrome-extension://") &&
		!tab.url.startsWith("moz-extension://") &&
		!isToolNavigating()
	) {
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.steer(navMessage);
		console.log("Queued navigation message for tab switch to", tab.url);
	}
});

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
window.addEventListener(
	"keydown",
	(e) => {
		// Escape key to abort streaming - works globally in sidepanel
		// Use capturing phase to intercept before MessageEditor handles it
		if (e.key === "Escape" && agent?.state.isStreaming) {
			e.preventDefault();
			e.stopPropagation();
			agent.abort();
		}

		// Cmd+U (Mac) or Ctrl+U (Windows/Linux) to open debug page
		if ((e.metaKey || e.ctrlKey) && e.key === "u") {
			e.preventDefault();
			window.location.href = "./debug.html";
		}

		// Cmd+Shift+K (Mac) or Ctrl+Shift+K (Windows/Linux) to show session costs
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
			e.preventDefault();
			if (agent?.state.messages && agent.state.messages.length > 0) {
				SessionCostDialog.open(agent.state.messages);
			}
		}
	},
	true,
); // Use capture phase to intercept Escape before it reaches MessageEditor

// ============================================================================
// TEST STEPS FROM DEBUGGER.TS
// ============================================================================
async function testSteps(): Promise<boolean> {
	const urlParams = new URLSearchParams(window.location.search);
	const testStepsParam = urlParams.get("teststeps");
	const testProvider = urlParams.get("provider");
	const testModel = urlParams.get("model");

	if (!testStepsParam) return false;

	// Handle test prompts - create temporary session without saving
	try {
		const testSteps = JSON.parse(decodeURIComponent(testStepsParam)) as string[];

		// Set model if specified
		let initialState: Partial<AgentState> | undefined;
		if (testProvider && testModel) {
			const model = getModel(testProvider as any, testModel);
			if (model) {
				initialState = {
					systemPrompt: SYSTEM_PROMPT,
					model,
				};
			}
		}

		await createAgent(initialState, false);
		renderApp();

		// Wait for UI to render
		await new Promise((resolve) => requestAnimationFrame(resolve));

		// Submit prompts sequentially
		for (let i = 0; i < testSteps.length; i++) {
			const step = testSteps[i];
			if (!chatPanel?.agentInterface) break;

			// Send the prompt
			await chatPanel.agentInterface.sendMessage(step);

			// Wait for agent to finish (not streaming anymore)
			if (i < testSteps.length - 1) {
				// Wait for response to complete before sending next step
				await new Promise<void>((resolve) => {
					const checkComplete = () => {
						if (!chatPanel.agent?.state.isStreaming) {
							resolve();
						} else {
							setTimeout(checkComplete, 100);
						}
					};
					checkComplete();
				});
			}
		}
		return true;
	} catch (err) {
		console.error("Failed to run test steps:", err);
		return false;
	}
}

// ============================================================================
// UPDATE CHECK
// ============================================================================
function isNewerVersion(latest: string, current: string): boolean {
	const latestParts = latest.split(".").map(Number);
	const currentParts = current.split(".").map(Number);

	for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
		const l = latestParts[i] || 0;
		const c = currentParts[i] || 0;
		if (l > c) return true;
		if (l < c) return false;
	}
	return false;
}

async function checkForUpdates() {
	try {
		const currentVersion = chrome.runtime.getManifest().version;

		// Fetch latest version
		const response = await fetch("https://sitegeist.ai/uploads/version.json", {
			cache: "no-cache",
		});
		const data = await response.json();
		const latestVersion = data.version;

		// Show dialog only if server version is newer than current version
		if (isNewerVersion(latestVersion, currentVersion)) {
			// Show update dialog - blocks until extension is updated and restarted
			await UpdateNotificationDialog.show(latestVersion);
		}
	} catch (err) {
		console.warn("[Sidepanel] Failed to check for updates:", err);
		// Silently fail - don't block startup
	}
}

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	// Show loading
	render(
		html`
			<div class="w-full h-full flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		document.body,
	);

	// Load showJsonMode setting
	const stored = await chrome.storage.local.get("showJsonMode");
	const showJsonModeEnabled = (stored.showJsonMode as boolean) || false;
	setShowJsonMode(showJsonModeEnabled);

	// Get current window ID for filtering tab events
	const currentWindow = await chrome.windows.getCurrent();
	if (!currentWindow.id) {
		throw new Error("Failed to get current window ID");
	}
	currentWindowId = currentWindow.id;

	// Initialize port communication system
	port.initialize(currentWindowId);

	// TODO reenable Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// Request userScripts permission if not available
	if (!chrome.userScripts) {
		await UserScriptsPermissionDialog.request();
	}

	// TODO: re-enable update check when publishing to users
	// await checkForUpdates();

	// Initialize default skills
	const { initializeDefaultSkills } = await import("./tools/skill.js");
	await initializeDefaultSkills();

	// Proxy disabled — CORS is handled locally via declarativeNetRequest rules
	await storage.settings.set("proxy.enabled", false);

	// Merge a fresh model catalog into the registry (bundled pi-ai list goes stale quickly)
	await refreshModelCatalog();

	// Reconcile skills + custom instructions with the sync server (re-hydrates after a reinstall)
	await syncWithServer();

	sessionsSidebarOpen = (await storage.settings.get<boolean>(SESSIONS_SIDEBAR_OPEN_SETTING)) === true;
	toolCallsCollapsed = (await storage.settings.get<boolean>(TOOL_CALLS_COLLAPSED_SETTING)) === true;
	globalThis.__sgToolCallsCollapsed = toolCallsCollapsed;

	// Agent dropdown: main-pi + worker prime sidecars the relay knows about
	await refreshAgentOptions();

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Handle test steps
	if (await testSteps()) {
		return;
	}

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	const isNewSession = urlParams.get("new") === "true";
	const requestedAgent = urlParams.get("agent");
	const requestedKind: AgentKind = requestedAgent && /^[a-z0-9]+$/.test(requestedAgent) ? requestedAgent : "browser";

	// If no session in URL and not explicitly creating new, try to load the most recent session
	if (!sessionIdFromUrl && !isNewSession && storage.sessions) {
		const latestSessionId = await storage.sessions.getLatestSessionId();
		if (latestSessionId) {
			// Try to acquire lock for latest session
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: latestSessionId,
				windowId: currentWindowId,
			});

			if (lockResponse.success) {
				sessionIdFromUrl = latestSessionId;
				// Update URL to include the latest session
				updateUrl(latestSessionId);
			}
			// If lock fails, fall through to create new session
		}
	}

	if (sessionIdFromUrl && storage.sessions) {
		const sessionData = await storage.sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			// Try to acquire lock if we don't already have it (in case user navigated directly via URL)
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: sessionIdFromUrl,
				windowId: currentWindowId,
			});

			if (!lockResponse.success) {
				// Session is locked in another window - show landing page instead
				await createAgent();
				if (agent) {
					const welcomeMessage = createWelcomeMessage(tutorials);
					agent.appendMessage(welcomeMessage);
				}
				renderApp();
				return;
			}

			currentSessionId = sessionIdFromUrl;
			const metadata = await storage.sessions.getMetadata(sessionIdFromUrl);
			currentTitle = metadata?.title || "";
			if (currentTitle.startsWith("[sitegeist browser context]")) {
				// titles saved before the context prefix was stripped from prime user messages
				currentTitle = generateTitle(stripBrowserContext(sessionData.messages));
				if (currentTitle) void storage.sessions.updateTitle(sessionIdFromUrl, currentTitle);
			}

			await createAgent(
				{
					systemPrompt: SYSTEM_PROMPT,
					model: sessionData.model,
					thinkingLevel: sessionData.thinkingLevel,
					messages: sessionData.messages,
					tools: [],
				},
				true,
				isPrimeSessionId(sessionIdFromUrl) ? agentIdFromSessionId(sessionIdFromUrl) : "browser",
				isPrimeSessionId(sessionIdFromUrl) ? sessionIdFromUrl : undefined,
			);

			renderApp();
			return;
		} else {
			// Session doesn't exist, redirect to new session
			newSession();
			return;
		}
	}

	// No session - create new agent with welcome message
	await createAgent(undefined, true, requestedKind);

	// Add welcome message for new sessions (the browser agent's tutorial card; prime has no use for it)
	if (agent && !isPrimeAgent(agent)) {
		const welcomeMessage = createWelcomeMessage(tutorials);
		agent.appendMessage(welcomeMessage);
	}

	renderApp();

	// If no API keys configured, show welcome dialog, open settings, then auto-select model
	if (!(await hasAnyApiKey())) {
		await WelcomeSetupDialog.show();
		await openApiKeysDialog();
		await selectDefaultModelForAvailableProvider();
		renderApp();
	}
}

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

initApp();
