import { ConsoleRuntimeProvider, RUNTIME_MESSAGE_ROUTER, type SandboxRuntimeProvider } from "@mariozechner/pi-web-ui";
import {
	BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION,
	FETCH_RUNTIME_PROVIDER_DESCRIPTION,
	NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION,
} from "../../prompts/prompts.js";
import { getSitegeistStorage } from "../../storage/app-storage.js";
import type { NavigateParams, NavigateTool } from "../navigate.js";
import { buildWrapperCode, checkUserScriptsAvailability } from "./userscripts-helpers.js";

/**
 * BrowserJsRuntimeProvider
 *
 * Provides the browserjs() helper to REPL scripts, which executes code
 * in the active browser tab's page context via userScripts API.
 *
 * Usage in REPL:
 *   const title = await browserjs(() => document.title);
 *   const count = await browserjs((sel) => document.querySelectorAll(sel).length, '.product');
 */
export class BrowserJsRuntimeProvider implements SandboxRuntimeProvider {
	private activeSandboxIds: Set<string> = new Set();
	private activeExecutions = new Map<
		string,
		{
			tabId: number;
			executionId: string;
			abortSignal?: AbortSignal;
		}
	>();
	private sandboxAbortSignals = new Map<string, AbortSignal>();

	constructor(private sharedProviders: SandboxRuntimeProvider[]) {}

	getData(): Record<string, any> {
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		// This function will be stringified and injected into the REPL iframe
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}

			// Inject browserjs() helper
			(window as any).browserjs = async (func: () => any, ...args: any[]): Promise<any> => {
				if (typeof func !== "function") {
					throw new Error("First argument to browserjs() must be a function");
				}

				const response = await sendRuntimeMessage({
					type: "browser-js",
					code: func.toString(),
					args: JSON.stringify(args),
				});

				// Log console output from browserjs() execution to REPL's console
				// BEFORE throwing errors, so console logs are visible even on failure
				if (response.console && Array.isArray(response.console)) {
					for (const log of response.console) {
						const method = log.type || "log";
						const message = `[browserjs] ${log.text}`;
						if (method === "error") {
							console.error(message);
						} else if (method === "warn") {
							console.warn(message);
						} else if (method === "info") {
							console.info(message);
						} else {
							console.log(message);
						}
					}
				}

				if (!response.success) {
					throw new Error(response.error || "browserjs() execution failed");
				}

				return response.result;
			};
		};
	}

	onExecutionStart(sandboxId: string, signal?: AbortSignal): void {
		if (signal) {
			this.sandboxAbortSignals.set(sandboxId, signal);
		}
	}

	onExecutionEnd(sandboxId: string): void {
		// Clean up the abort signal when REPL execution ends
		this.sandboxAbortSignals.delete(sandboxId);
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type !== "browser-js") {
			return;
		}

		console.log("[BrowserJsRuntimeProvider] Received message:", message);

		// Get the REPL sandbox's abort signal (if available)
		const replSandboxId = message.sandboxId;
		const abortSignal = replSandboxId ? this.sandboxAbortSignals.get(replSandboxId) : undefined;

		// Check if userScripts API is available
		const apiCheck = await checkUserScriptsAvailability();
		if (!apiCheck.available) {
			respond({
				success: false,
				error: apiCheck.message || "userScripts API not available",
			});
			return;
		}

		// Get current tab
		const [tab] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});

		if (!tab || !tab.id) {
			respond({
				success: false,
				error: "No active tab found",
			});
			return;
		}

		// Validate tab URL (reject chrome://, chrome-extension://, about: URLs)
		if (
			tab.url?.startsWith("chrome://") ||
			tab.url?.startsWith("chrome-extension://") ||
			tab.url?.startsWith("moz-extension://") ||
			tab.url?.startsWith("about:")
		) {
			respond({
				success: false,
				error: `Cannot execute scripts on ${tab.url}. Extension pages and internal URLs are protected.`,
			});
			return;
		}

		// Load skills for current tab URL
		const skillsRepo = getSitegeistStorage().skills;
		let skillLibrary = "";

		if (tab.url) {
			const matchingSkills = await skillsRepo.getSkillsForUrl(tab.url);
			if (matchingSkills.length > 0) {
				skillLibrary = `${matchingSkills.map((s) => s.library).join("\n\n")}\n\n`;
			}
		}

		// Generate unique sandbox ID for this execution
		const sandboxId = `browserjs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

		// Parse args (passed as JSON string)
		let parsedArgs: any[] = [];
		if (message.args) {
			try {
				parsedArgs = JSON.parse(message.args);
			} catch (e) {
				respond({
					success: false,
					error: `Failed to parse arguments: ${e}`,
				});
				return;
			}
		}

		// Track this sandbox for cleanup
		this.activeSandboxIds.add(sandboxId);

		// Create a dedicated ConsoleRuntimeProvider for this browserjs() execution
		const pageConsoleProvider = new ConsoleRuntimeProvider();

		// Build wrapper code with skills, providers (including dedicated console provider), and args
		const wrapperCode = buildWrapperCode(
			message.code,
			skillLibrary,
			false, // disable safeguards for now
			[pageConsoleProvider, ...this.sharedProviders],
			sandboxId,
			parsedArgs,
		);

		// Use fixed worldId for all executions
		const FIXED_WORLD_ID = "sitegeist-browser-script";

		// Check if terminate API is available (Chrome 138+)
		// @ts-expect-error - terminate is not yet in the type definitions
		const supportsTerminate = typeof chrome.userScripts?.terminate === "function";

		// Generate execution ID for cancellation support (only if terminate is available)
		const executionId = supportsTerminate ? crypto.randomUUID() : undefined;

		// Track this execution for potential cancellation
		if (executionId) {
			this.activeExecutions.set(sandboxId, {
				tabId: tab.id,
				executionId: executionId,
				abortSignal: abortSignal,
			});
		}

		// Set up abort handler if signal is available and terminate is supported
		const abortHandler = executionId
			? async () => {
					console.log(`[BrowserJsRuntimeProvider] Aborting execution ${executionId}`);
					try {
						// @ts-expect-error - terminate is not yet in the type definitions
						await chrome.userScripts.terminate(tab.id!, executionId);
						console.log(`[BrowserJsRuntimeProvider] Successfully terminated execution ${executionId}`);
					} catch (e) {
						console.error(`[BrowserJsRuntimeProvider] Failed to terminate execution:`, e);
					}
				}
			: undefined;

		if (abortSignal && abortHandler) {
			abortSignal.addEventListener("abort", abortHandler);
		}

		try {
			// Execute via userScripts API
			if (chrome.userScripts && typeof chrome.userScripts.execute === "function") {
				// Configure the fixed world with CSP
				try {
					await chrome.userScripts.configureWorld({
						worldId: FIXED_WORLD_ID,
						messaging: true,
						csp: "script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; font-src 'none'; object-src 'none'; default-src 'none';",
					});
				} catch (e) {
					console.warn("[BrowserJsRuntimeProvider] Failed to configure userScripts world:", e);
				}

				const injectionConfig: any = {
					js: [{ code: wrapperCode }],
					target: { tabId: tab.id, allFrames: false },
					world: "USER_SCRIPT",
					worldId: FIXED_WORLD_ID,
					injectImmediately: true,
				};

				// Only add executionId if terminate API is available
				if (executionId) {
					injectionConfig.executionId = executionId;
				}

				const results = await chrome.userScripts.execute(injectionConfig);

				const result = results[0]?.result as
					| {
							success: boolean;
							lastValue?: unknown;
							error?: string;
							stack?: string;
					  }
					| undefined;

				// Get console output from the dedicated ConsoleRuntimeProvider for this execution
				const consoleLogs = pageConsoleProvider.getLogs();

				if (!result) {
					respond({
						success: true,
						error: "No result returned from script execution",
						console: consoleLogs,
					});
					return;
				}

				if (!result.success) {
					respond({
						success: false,
						error: result.error,
						stack: result.stack,
						console: consoleLogs,
					});
					return;
				}

				respond({
					success: true,
					result: result.lastValue,
					console: consoleLogs,
				});
			} else {
				// Firefox fallback
				respond({
					success: false,
					error: 'Firefox is currently not supported for browserjs(). Use Chrome 138+ with "Allow User Scripts" enabled.',
				});
			}
		} catch (error: any) {
			console.error("[BrowserJsRuntimeProvider] Error:", error);

			// Check if this was a cancellation
			const wasCancelled = abortSignal?.aborted;

			respond({
				success: false,
				error: wasCancelled ? "Script execution was cancelled" : error.message || String(error),
				cancelled: wasCancelled,
			});
		} finally {
			// Cleanup abort handler
			if (abortSignal && abortHandler) {
				abortSignal.removeEventListener("abort", abortHandler);
			}

			// Cleanup execution tracking
			if (executionId) {
				this.activeExecutions.delete(sandboxId);
			}

			// Cleanup sandbox registration
			this.cleanup(sandboxId);
		}
	}

	getDescription(): string {
		return BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION;
	}

	/**
	 * Cleanup a specific sandbox registration
	 */
	private cleanup(sandboxId: string) {
		if (this.activeSandboxIds.has(sandboxId)) {
			RUNTIME_MESSAGE_ROUTER.unregisterSandbox(sandboxId);
			this.activeSandboxIds.delete(sandboxId);
		}
	}

	/**
	 * Cleanup all active sandboxes (call when provider is destroyed)
	 */
	public cleanupAll() {
		for (const sandboxId of this.activeSandboxIds) {
			RUNTIME_MESSAGE_ROUTER.unregisterSandbox(sandboxId);
		}
		this.activeSandboxIds.clear();
	}
}

/**
 * NavigateRuntimeProvider
 *
 * Provides the navigate() helper to REPL scripts, which wraps the NavigateTool.
 *
 * Usage in REPL:
 *   await navigate({ url: 'https://example.com' });
 *   await navigate({ history: 'back' });
 */
export class NavigateRuntimeProvider implements SandboxRuntimeProvider {
	constructor(private navigateTool: NavigateTool) {}

	getData(): Record<string, any> {
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		// This function will be stringified and injected into the REPL iframe
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}

			// Inject navigate() helper
			(window as any).navigate = async (args: any): Promise<any> => {
				const response = await sendRuntimeMessage({
					type: "navigate",
					args,
				});

				if (!response.success) {
					throw new Error(response.error || "navigate() execution failed");
				}

				return response.result;
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type !== "navigate") {
			return;
		}

		console.log("[NavigateRuntimeProvider] Received message:", message);

		try {
			// Call the navigate tool
			const result = await this.navigateTool.execute(`navigate_${Date.now()}`, message.args as NavigateParams);

			respond({
				success: true,
				result: {
					finalUrl: result.details.finalUrl,
					title: result.details.title,
					skills: result.details.skills,
				},
			});
		} catch (error: any) {
			console.error("[NavigateRuntimeProvider] Error:", error);
			respond({
				success: false,
				error: error.message || String(error),
			});
		}
	}

	getDescription(): string {
		return NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION;
	}
}

/**
 * FetchRuntimeProvider
 *
 * Makes fetch() usable in the REPL sandbox. The sandbox page's CSP only allows connect-src to a few
 * CDNs, so a plain fetch() to any other URL fails with "TypeError: Failed to fetch". This provider wraps
 * window.fetch: the native call is tried first and, if it throws, the request is relayed to the side
 * panel (which has host permissions, so no CORS/CSP issues) and rebuilt as a Response in the sandbox.
 *
 * Relayed requests are made from the extension context without cookies.
 */
export class FetchRuntimeProvider implements SandboxRuntimeProvider {
	private static readonly MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

	getData(): Record<string, any> {
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		// This function will be stringified and injected into the REPL iframe: keep it self-contained.
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}

			const nativeFetch = window.fetch.bind(window);
			const toBase64 = (buffer: ArrayBuffer): string => {
				const bytes = new Uint8Array(buffer);
				let binary = "";
				for (let i = 0; i < bytes.length; i += 0x8000) {
					binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
				}
				return btoa(binary);
			};

			window.fetch = async (input: any, init?: any): Promise<Response> => {
				try {
					return await nativeFetch(input, init);
				} catch (nativeError) {
					// Blocked by the sandbox CSP (or CORS): relay through the extension
					const url: string =
						typeof input === "string"
							? input
							: input instanceof URL
								? input.toString()
								: String(input?.url ?? "");
					if (!/^https?:/i.test(url)) throw nativeError;

					const headers: Record<string, string> = {};
					const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
					if (source) {
						new Headers(source).forEach((value, key) => {
							headers[key] = value;
						});
					}

					let body: string | undefined;
					let bodyEncoding: "text" | "base64" = "text";
					const raw = init?.body;
					if (raw !== undefined && raw !== null) {
						if (typeof raw === "string") {
							body = raw;
						} else if (raw instanceof URLSearchParams) {
							body = raw.toString();
							if (!headers["content-type"])
								headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
						} else if (raw instanceof ArrayBuffer) {
							body = toBase64(raw);
							bodyEncoding = "base64";
						} else if (ArrayBuffer.isView(raw)) {
							body = toBase64(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
							bodyEncoding = "base64";
						} else if (raw instanceof Blob) {
							body = toBase64(await raw.arrayBuffer());
							bodyEncoding = "base64";
							if (!headers["content-type"] && raw.type) headers["content-type"] = raw.type;
						} else {
							throw new Error(
								"fetch(): unsupported body type for a relayed request (use string, URLSearchParams, ArrayBuffer or Blob)",
							);
						}
					}

					const response = await sendRuntimeMessage({
						type: "fetch",
						args: {
							url,
							method: init?.method ?? (input instanceof Request ? input.method : "GET"),
							headers,
							body,
							bodyEncoding,
						},
					});
					if (!response.success) {
						throw new TypeError(response.error || "fetch() relay failed");
					}

					const result = response.result;
					const bytes = Uint8Array.from(atob(result.bodyBase64), (c) => c.charCodeAt(0));
					const nullBody =
						result.status === 204 || result.status === 205 || result.status === 304 || bytes.length === 0;
					return new Response(nullBody ? null : bytes, {
						status: result.status,
						statusText: result.statusText,
						headers: result.headers,
					});
				}
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type !== "fetch") {
			return;
		}

		try {
			const { url, method, headers, body, bodyEncoding } = message.args as {
				url: string;
				method: string;
				headers: Record<string, string>;
				body?: string;
				bodyEncoding: "text" | "base64";
			};
			if (!/^https?:/i.test(url)) {
				throw new Error("Only http(s) URLs can be fetched");
			}

			const requestBody =
				body === undefined
					? undefined
					: bodyEncoding === "base64"
						? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
						: body;
			const upstream = await fetch(url, { method, headers, body: requestBody, credentials: "omit" });

			const buffer = await upstream.arrayBuffer();
			if (buffer.byteLength > FetchRuntimeProvider.MAX_RESPONSE_BYTES) {
				throw new Error(`Response too large to relay (${buffer.byteLength} bytes)`);
			}
			const bodyBase64 = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(new Blob([buffer]));
			});

			const responseHeaders: [string, string][] = [];
			upstream.headers.forEach((value, key) => {
				// The body is already decoded; drop framing headers so Response() does not lie about it
				if (key === "content-encoding" || key === "content-length" || key === "transfer-encoding") return;
				responseHeaders.push([key, value]);
			});

			respond({
				success: true,
				result: { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders, bodyBase64 },
			});
		} catch (error: any) {
			console.error("[FetchRuntimeProvider] Error:", error);
			respond({
				success: false,
				error: error.message || String(error),
			});
		}
	}

	getDescription(): string {
		return FETCH_RUNTIME_PROVIDER_DESCRIPTION;
	}
}
