/**
 * Pure text for the compact R730 tool-call display (tool-renderer.ts): the title built from a tool name and its
 * arguments, and the one-line subtitle from a result. No DOM imports, so tests/prime-tool-summary.test.ts runs it
 * under plain node.
 */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string): string =>
	s
		.split("\n")
		.find((l) => l.trim() !== "")
		?.trim() ?? "";
const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() ?? p;
const hostPath = (u: string): string => {
	try {
		const x = new URL(u);
		return cut(`${x.host}${x.pathname === "/" ? "" : x.pathname}`, 70);
	} catch {
		return cut(u, 70);
	}
};
const tab = (a: Record<string, unknown>): string => (num(a.tabId) !== undefined ? ` · tab ${num(a.tabId)}` : "");
const quoted = (s: string, n = 50): string => `"${cut(s, n)}"`;

/** Title text for the header: what the tool is doing, in the Browser agent's style ("Reading the Reddit thread"). */
export function primeToolTitle(name: string, params: unknown): string {
	const a: Record<string, unknown> = isRecord(params) ? params : {};
	switch (name) {
		case "browser_page": {
			const find = str(a.find);
			const sel = str(a.selector);
			const mode = str(a.mode);
			const what = find ? ` · find ${quoted(find)}` : sel ? ` · ${cut(sel, 40)}` : "";
			return `Reading the page${tab(a)}${what}${mode && mode !== "markdown" ? ` · ${mode}` : ""}`;
		}
		case "browser_eval": {
			const urls = Array.isArray(a.urls) ? a.urls.length : 0;
			const code = str(a.code);
			const head =
				urls > 0
					? `Running JavaScript on ${urls} page${urls === 1 ? "" : "s"}`
					: `Running JavaScript in the page${tab(a)}`;
			return code ? `${head} · ${cut(firstLine(code), 60)}` : head;
		}
		case "browser_navigate": {
			const url = str(a.url);
			return `Opening ${url ? hostPath(url) : "a page"}${a.newTab === true ? " in a new tab" : ""}`;
		}
		case "browser_tabs": {
			const q = str(a.query);
			return a.windows === true ? "Listing windows" : q ? `Finding tabs matching ${quoted(q)}` : "Listing tabs";
		}
		case "browser_tab_action": {
			const n = Array.isArray(a.tabIds) ? a.tabIds.length : 0;
			const verb = a.action === "close" ? "Closing" : "Moving";
			return `${verb} ${n} tab${n === 1 ? "" : "s"}`;
		}
		case "browser_screenshot":
			return `Screenshot${tab(a)}`;
		case "browser_cookies":
			return `Exporting cookies for ${str(a.domain) ?? "a site"}`;
		case "browser_upload_file":
			return `Uploading ${basename(str(a.path) ?? "a file")}`;
		case "browser_download":
			return `Downloading ${str(a.filename) ?? (str(a.url) ? hostPath(str(a.url) ?? "") : "a file")}`;
		case "browser_pick_element":
			return "Asking Tom to click an element";
		case "browser_skill":
			return `Skill ${str(a.action) ?? ""} ${str(a.name) ?? (isRecord(a.data) ? (str(a.data.name) ?? "") : "")}`.trim();
		case "browser_instructions":
			return a.command === "set" ? "Updating the custom instructions" : "Reading the custom instructions";
		case "ipython": {
			const code = str(a.code);
			return code ? `Python · ${cut(firstLine(code), 70)}` : "Python";
		}
		case "telegram_attach": {
			const paths = Array.isArray(a.paths) ? a.paths.filter((p): p is string => typeof p === "string") : [];
			return paths.length > 0 ? `Sending ${cut(paths.map(basename).join(", "), 70)}` : "Sending a file";
		}
		case "agent_wiki_search":
			return `Searching the wiki for ${quoted(str(a.query) ?? "")}`;
		case "agent_wiki_read": {
			const title = str(a.title) ?? (str(a.uri) ? basename(str(a.uri) ?? "") : undefined);
			return `Reading the wiki${title ? ` · ${cut(title, 60)}` : ""}${str(a.heading) ? ` · ${cut(str(a.heading) ?? "", 40)}` : ""}`;
		}
		case "agent_wiki_find_pages":
		case "agent_wiki_list_pages":
		case "agent_wiki_get_page_by_title":
			return `Looking up wiki pages${str(a.query) ? ` matching ${quoted(str(a.query) ?? "")}` : str(a.title) ? ` · ${cut(str(a.title) ?? "", 60)}` : ""}`;
		case "agent_wiki_append_section":
		case "agent_wiki_edit_page":
		case "agent_wiki_update_page":
		case "agent_wiki_create_page":
		case "agent_wiki_create_skill":
		case "agent_wiki_write_skill_reference":
		case "agent_wiki_upload_image":
		case "agent_wiki_move_page":
		case "agent_wiki_archive_page": {
			const verb = name.replace("agent_wiki_", "").replace(/_/g, " ");
			const what = str(a.title) ?? str(a.skill) ?? str(a.under_heading) ?? "";
			return `Wiki: ${verb}${what ? ` · ${cut(what, 60)}` : ""}`;
		}
		case "searxng_search":
			return `Searching the web for ${quoted(str(a.query) ?? "")}`;
		case "rotfetch_fetch":
			return `Fetching ${str(a.url) ? hostPath(str(a.url) ?? "") : "a page"}`;
		case "context7_resolve_library_id":
			return `Finding docs for ${str(a.libraryName) ?? ""}`.trim();
		case "context7_query_docs":
			return `Reading docs · ${cut(str(a.query) ?? str(a.libraryId) ?? "", 60)}`;
		case "docling_convert_document":
			return `Converting ${basename(str(a.source) ?? "a document")}`;
		case "agent_ask":
			return `Asking ${str(a.target) ?? "another agent"}`;
		case "agent_models":
			return "Checking model availability";
		default: {
			if (name.startsWith("komainu_"))
				return `Credentials: ${name.replace("komainu_", "").replace(/_/g, " ")}${str(a.item) ? ` · ${cut(str(a.item) ?? "", 40)}` : ""}`;
			const firstString = Object.values(a).find((v): v is string => typeof v === "string" && v.trim() !== "");
			return `${name.replace(/_/g, " ")}${firstString ? ` · ${cut(firstLine(firstString), 60)}` : ""}`;
		}
	}
}

/**
 * The line under the title: the first non-empty output line, cut to fit; "image" when the result is only an image.
 * browser_tabs answers with a table, so its summary line ("Showing 3; 3 of 14 open tabs match …") is used instead.
 */
export function primeToolSubtitleText(parts: ReadonlyArray<{ type: string; text?: string }>, name?: string): string {
	const text = parts
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	let line = lines[0] ?? "";
	if (name === "browser_tabs")
		line = lines.find((l) => /^(Showing |No tabs match|id\t)/.test(l) && !l.startsWith("id\t")) ?? line;
	if (line === "" && parts.some((c) => c.type === "image")) return "image";
	return cut(line, 140);
}

export { cut, firstLine, isRecord, str };
