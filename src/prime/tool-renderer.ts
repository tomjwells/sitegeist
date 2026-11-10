/**
 * Compact display for R730 tool calls (Tom, 2026-11-02: "Why does it look so different from when the browser agent
 * reads a page?"). The Browser agent's tools each have a renderer: a one-line title ("Reading the Reddit thread"),
 * details folded away. prime's tools (browser_*, ipython, agent_wiki_*, searxng_search, …) had none and fell through
 * to pi-web-ui's DefaultRenderer: the literal word "Tool Call", the raw JSON input and the whole output, always open.
 * This renderer gives them the same shape: icon + a title built from the tool and its arguments, the output's first
 * line underneath, input and full output (and any image, e.g. a screenshot) behind the chevron.
 *
 * Registered for every tool name that appears in a prime session (ensurePrimeToolRenderers) - the R730 side can add
 * tools without a panel release - except the panel's own tools, which keep their renderers.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import {
	getToolRenderer,
	registerToolRenderer,
	renderCollapsibleHeader,
	type ToolRenderResult,
} from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import {
	BookOpen,
	Bot,
	Camera,
	FileText,
	Globe,
	KeyRound,
	LayoutList,
	MousePointerClick,
	Paperclip,
	Search,
	Terminal,
	Wrench,
} from "lucide";
import { drawnImages } from "./image-refs.js";
import "./remote-image.js"; // <sg-remote-image>
import { isRecord, primeToolSubtitleText, primeToolTitle, str } from "./tool-summary.js";

type Icon = typeof Globe;

function iconFor(name: string): Icon {
	if (name === "browser_screenshot") return Camera;
	if (name === "browser_pick_element") return MousePointerClick;
	if (name === "browser_tabs" || name === "browser_tab_action") return LayoutList;
	if (name.startsWith("browser_")) return Globe;
	if (name === "ipython" || name === "bash") return Terminal;
	if (name.startsWith("agent_wiki_")) return BookOpen;
	if (name === "searxng_search" || name === "rotfetch_fetch" || name.startsWith("context7_")) return Search;
	if (name === "telegram_attach") return Paperclip;
	if (name.startsWith("komainu_")) return KeyRound;
	if (name === "docling_convert_document") return FileText;
	if (name === "agent_ask" || name === "agent_models") return Bot;
	return Wrench;
}

/** Language for the input block: code-carrying tools show their code, everything else its arguments as JSON. */
function inputBlock(name: string, params: unknown): TemplateResult | "" {
	const a: Record<string, unknown> = isRecord(params) ? params : {};
	const code = str(a.code);
	if (code && (name === "ipython" || name === "browser_eval" || name === "browser_download")) {
		const rest = Object.fromEntries(Object.entries(a).filter(([k]) => k !== "code"));
		return html`
			<code-block .code=${code} language="${name === "ipython" ? "python" : "javascript"}"></code-block>
			${Object.keys(rest).length > 0 ? html`<code-block .code=${JSON.stringify(rest, null, 2)} language="json"></code-block>` : ""}
		`;
	}
	if (Object.keys(a).length === 0) return "";
	return html`<code-block .code=${JSON.stringify(a, null, 2)} language="json"></code-block>`;
}

function textOf(result: ToolResultMessage<unknown>): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function imagesOf(result: ToolResultMessage<unknown>): TemplateResult[] {
	return drawnImages(result.content).map((d) =>
		d.kind === "link"
			? html`<div class="mt-2"><sg-remote-image .imageRef=${d.ref} .maxHeight=${256}></sg-remote-image></div>`
			: html`<img class="max-h-64 rounded border border-border mt-2" src=${d.src} alt="tool image" />`,
	);
}

/** The one line shown under the title when a result exists: the first line of the output (errors in red). */
export function primeToolSubtitle(result: ToolResultMessage<unknown>, name?: string): string {
	return primeToolSubtitleText(result.content, name);
}

export function renderPrimeTool(
	name: string,
	params: unknown,
	result: ToolResultMessage<unknown> | undefined,
	isStreaming?: boolean,
): ToolRenderResult {
	const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
	const icon = iconFor(name);
	const title = primeToolTitle(name, params);
	const contentRef = createRef<HTMLDivElement>();
	const chevronRef = createRef<HTMLSpanElement>();
	const subtitle = result ? primeToolSubtitle(result, name) : "";
	const failed = result?.isError === true || /^browser tool .* failed:|^Error\b/i.test(subtitle);
	const output = result ? textOf(result) : "";
	return {
		content: html`
			<div>
				${renderCollapsibleHeader(state, icon, title, contentRef, chevronRef, false)}
				${
					subtitle
						? html`<div class="text-xs mt-1 truncate ${failed ? "text-destructive" : "text-muted-foreground"}" title=${subtitle}>${subtitle}</div>`
						: ""
				}
				<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">
					${inputBlock(name, params)}
					${output ? html`<console-block .content=${output} .variant=${failed ? "error" : "default"}></console-block>` : ""}
					${result ? imagesOf(result) : ""}
				</div>
			</div>
		`,
		isCustom: false,
	};
}

/** The panel's own tools keep their renderers (and pi-web-ui's bash/calculate/get_current_time theirs). */
const PANEL_TOOLS = new Set([
	"repl",
	"navigate",
	"skill",
	"ask_user_which_element",
	"extract_image",
	"extract_document",
	"debugger",
	"artifacts",
	"bash",
	"calculate",
	"get_current_time",
]);

const registered = new Set<string>();

/** Register the compact renderer for one prime tool name (idempotent; never replaces an existing renderer). */
export function ensurePrimeToolRenderer(name: string): void {
	if (registered.has(name) || PANEL_TOOLS.has(name)) return;
	registered.add(name);
	if (getToolRenderer(name)) return;
	registerToolRenderer(name, {
		render: (params: unknown, result: ToolResultMessage<unknown> | undefined, isStreaming?: boolean) =>
			renderPrimeTool(name, params, result, isStreaming),
	});
}

/** Register for every tool call in these messages (hydrated history, streamed assistant messages). */
export function ensurePrimeToolRenderers(messages: readonly AgentMessage[]): void {
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content) {
			if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string")
				ensurePrimeToolRenderer(block.name);
		}
	}
}

/** Known prime tools, registered up front so the first paint of a hydrated session is already compact. */
export const KNOWN_PRIME_TOOLS = [
	"browser_tabs",
	"browser_tab_action",
	"browser_screenshot",
	"browser_page",
	"browser_eval",
	"browser_navigate",
	"browser_cookies",
	"browser_upload_file",
	"browser_download",
	"browser_pick_element",
	"browser_skill",
	"browser_instructions",
	"ipython",
	"telegram_attach",
	"agent_wiki_search",
	"agent_wiki_read",
	"agent_wiki_find_pages",
	"agent_wiki_list_pages",
	"agent_wiki_get_page_by_title",
	"agent_wiki_append_section",
	"agent_wiki_edit_page",
	"agent_wiki_update_page",
	"agent_wiki_create_page",
	"agent_wiki_create_skill",
	"agent_wiki_write_skill_reference",
	"agent_wiki_upload_image",
	"agent_wiki_move_page",
	"agent_wiki_archive_page",
	"searxng_search",
	"rotfetch_fetch",
	"context7_resolve_library_id",
	"context7_query_docs",
	"docling_convert_document",
	"agent_ask",
	"agent_models",
	"komainu_status",
	"komainu_search",
	"komainu_item_info",
	"komainu_materialize",
	"komainu_env_exec",
	"komainu_stdin_exec",
	"komainu_put_note",
];
for (const name of KNOWN_PRIME_TOOLS) ensurePrimeToolRenderer(name);
