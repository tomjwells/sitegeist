import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const isWatch = process.argv.includes("--watch");
const staticDir = join(packageRoot, "static");

// Chrome only
const targetBrowser = "chrome";
const outDir = join(packageRoot, "dist-chrome");

const entryPoints = {
	sidepanel: join(packageRoot, "src/sidepanel.ts"),
	debug: join(packageRoot, "src/debug.ts"),
	icons: join(packageRoot, "src/icons.ts"),
	background: join(packageRoot, "src/background.ts"),
};

// Swap pi-ai's static model registry for src/models-registry.ts (same API, mutable) so a fresh model
// catalog can be merged in at runtime. Catches pi-ai's own relative imports of ./models.js as well as
// the package entry point re-export.
const modelsRegistryPlugin = {
	name: "models-registry",
	setup(build) {
		build.onResolve({ filter: /^\.{1,2}\/models\.js$/ }, (args) => {
			if (!args.importer.includes(`${join("@mariozechner", "pi-ai", "dist")}`)) return null;
			return { path: join(packageRoot, "src/models-registry.ts") };
		});
	},
};

// Small, exact patches to pi-web-ui's compiled components (we cannot subclass what the ChatPanel
// instantiates). Each patch is an exact-string replace that fails the build loudly if upstream changes
// shape, so a bump of pi-web-ui never silently loses fork behaviour.
//  - MessageEditor: thinking dropdown follows the model (src/thinking-options.ts);
//    prime-agent sessions can send while streaming = steering (Enter or the extra send button).
//  - AgentInterface: lets prime-agent sessions prompt while streaming (PrimeRemoteAgent turns it into a steer).
const PRIME = 'this.currentModel?.provider === "prime"';
const piWebUiPatches = [
	{
		file: /@mariozechner[\\/]pi-web-ui[\\/]dist[\\/]components[\\/]MessageEditor\.js$/,
		imports: [
			`import { thinkingOptionsFor as __thinkingOptionsFor } from ${JSON.stringify(join(packageRoot, "src/thinking-options.ts").replace(/\\/g, "/"))};`,
			`import { connectPromptDraft, disconnectPromptDraft, rememberPromptDraft } from ${JSON.stringify(join(packageRoot, "src/storage/prompt-drafts.ts").replace(/\\/g, "/"))};`,
		],
		replacements: [
			{
				find: '        this._value = val;\n        this.requestUpdate("value", oldValue);',
				replace:
					'        this._value = val;\n        rememberPromptDraft(this, val);\n        this.requestUpdate("value", oldValue);',
			},
			{
				find: "    firstUpdated() {\n",
				replace:
					"    connectedCallback() {\n        super.connectedCallback();\n        connectPromptDraft(this);\n    }\n    disconnectedCallback() {\n        disconnectPromptDraft(this);\n        super.disconnectedCallback();\n    }\n    firstUpdated() {\n",
			},
			{
				find: /options: \[\n\s*\{ value: "off"[\s\S]*?\],/,
				replace:
					'options: __thinkingOptionsFor(this.currentModel, this.thinkingLevel).map((o) => ({ value: o.value, label: i18n(o.label), icon: icon(Brain, "sm") })),',
			},
			{
				// Reflect the chosen level at once: Agent.setThinkingLevel() only mutates state (no event), so the
				// editor would keep showing the old value until something else re-rendered it.
				find: "onChange: (value) => {\n                    this.onThinkingChange?.(value);\n                },",
				replace:
					"onChange: (value) => {\n                    this.thinkingLevel = value;\n                    this.onThinkingChange?.(value);\n                },",
			},
			{
				find: "if (!this.isStreaming && !this.processingFiles && (this.value.trim() || this.attachments.length > 0)) {",
				replace: `if ((!this.isStreaming || ${PRIME}) && !this.processingFiles && (this.value.trim() || this.attachments.length > 0)) {`,
			},
			{
				find: 'placeholder=${i18n("Type a message...")}',
				replace: `placeholder=\${this.isStreaming && ${PRIME} ? "Steer the agent… (Enter delivers mid-turn)" : i18n("Type a message...")}`,
			},
			{
				// streaming footer: prime sessions get a steer-send button next to the stop button
				find: '${this.isStreaming\n            ? html `\n\t\t\t\t\t\t\t\t\t${Button({\n                variant: "ghost",\n                size: "icon",\n                onClick: this.onAbort,',
				replace:
					"${this.isStreaming\n            ? html `\n\t\t\t\t\t\t\t\t\t${" +
					PRIME +
					' && (this.value.trim() || this.attachments.length > 0) ? Button({ variant: "ghost", size: "icon", onClick: this.handleSend, title: "Steer: deliver this now, mid-turn", children: html `<div style="transform: rotate(-45deg)">${icon(Send, "sm")}</div>`, className: "h-8 w-8" }) : ""}\n\t\t\t\t\t\t\t\t\t${Button({\n                variant: "ghost",\n                size: "icon",\n                onClick: this.onAbort,',
			},
		],
	},
	{
		// ToolMessage: a global "collapse all tool calls" mode (header +/- button, sidepanel.ts). Collapsed
		// cards render as one compact row (status dot, tool name, one-line summary of the arguments); clicking
		// a row expands that card, clicking the row above an expanded card collapses it again.
		// AssistantMessage: footer row = usage + a small "copy answer as Markdown" button (mini-lit copy-button,
		// text = the message's text parts joined, i.e. the Markdown the model wrote).
		file: /@mariozechner[\\/]pi-web-ui[\\/]dist[\\/]components[\\/]Messages\.js$/,
		imports: [],
		replacements: [
			{
				find: "        // Render content in the order it appears\n        const orderedParts = [];\n",
				replace:
					"        // Render content in the order it appears\n        const orderedParts = [];\n" +
					'        const sgMarkdown = this.message.content.filter((c) => c.type === "text" && c.text.trim() !== "").map((c) => c.text.trim()).join("\\n\\n");\n',
			},
			{
				find:
					"				${this.message.usage && !this.isStreaming\n" +
					"            ? this.onCostClick\n" +
					'                ? html ` <div class="px-4 mt-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${formatUsage(this.message.usage)}</div> `\n' +
					'                : html ` <div class="px-4 mt-2 text-xs text-muted-foreground">${formatUsage(this.message.usage)}</div> `\n' +
					'            : ""}\n',
				replace:
					"				${!this.isStreaming && (this.message.usage || sgMarkdown)\n" +
					'            ? html ` <div class="px-4 mt-1 text-xs text-muted-foreground flex items-center gap-1 min-h-6">' +
					'${this.message.usage ? (this.onCostClick ? html `<span class="cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${formatUsage(this.message.usage)}</span>` : html `<span>${formatUsage(this.message.usage)}</span>`) : ""}' +
					'${sgMarkdown ? html `<copy-button class="sg-copy-md [&>button]:!h-6 [&>button]:!w-6 [&>button]:!p-0 [&>button]:!bg-transparent [&>button]:hover:!bg-accent [&>button]:text-muted-foreground [&>button]:hover:text-foreground" .text=${sgMarkdown} title="Copy answer as Markdown"></copy-button>` : ""}' +
					"</div> `\n" +
					'            : ""}\n',
			},
			{
				find: "    render() {\n        const toolName = this.tool?.name || this.toolCall.name;\n",
				replace:
					"    sgSummary() {\n" +
					"        try {\n" +
					"            const a = typeof this.toolCall.arguments === 'string' ? JSON.parse(this.toolCall.arguments) : this.toolCall.arguments;\n" +
					"            if (!a || typeof a !== 'object') return '';\n" +
					"            for (const k of ['title', 'description', 'command', 'code', 'path', 'url', 'query', 'pattern', 'prompt', 'message', 'text', 'item', 'name', 'skill', 'selector', 'file']) {\n" +
					"                const v = a[k];\n" +
					"                if (typeof v !== 'string' || !v.trim()) continue;\n" +
					"                const lines = v.split('\\n').map((l) => l.trim()).filter(Boolean);\n" +
					"                return lines.find((l) => !l.startsWith('%%') && !l.startsWith('#') && !l.startsWith('//')) || lines[0] || '';\n" +
					"            }\n" +
					"            return Object.entries(a).filter(([, v]) => v != null && typeof v !== 'object' && String(v).trim()).map(([k, v]) => k + '=' + String(v).trim()).join('  ');\n" +
					"        } catch { return ''; }\n" +
					"    }\n" +
					"    sgRow(expanded) {\n" +
					"        const toolName = this.tool?.name || this.toolCall.name;\n" +
					"        const status = this.aborted ? 'aborted' : this.result ? (this.result.isError ? 'error' : 'done') : (this.isStreaming || this.pending) ? 'running' : 'done';\n" +
					"        const dot = status === 'error' || status === 'aborted' ? 'bg-destructive' : status === 'running' ? 'bg-yellow-500 animate-pulse' : 'bg-green-600';\n" +
					'        return html `<button class="sg-tool-collapsed w-full text-left px-2.5 py-1.5 border border-border rounded-md bg-card text-xs text-muted-foreground flex items-center gap-2 hover:text-foreground" title=${expanded ? \'Collapse this tool call\' : \'Expand this tool call\'} @click=${() => { this.sgForceExpanded = !expanded; this.requestUpdate(); }}><span class="inline-block w-2 h-2 rounded-full shrink-0 ${dot}"></span><span class="font-medium shrink-0">${toolName}</span><span class="truncate min-w-0 flex-1 font-mono opacity-80">${this.sgSummary()}</span><span class="shrink-0 w-3 text-center">${expanded ? \'\u2212\' : \'+\'}</span></button>`;\n' +
					"    }\n" +
					"    render() {\n" +
					"        if (globalThis.__sgToolCallsCollapsed !== true) return this.sgRenderFull();\n" +
					"        if (!this.sgForceExpanded) return this.sgRow(false);\n" +
					'        return html `<div class="space-y-1">${this.sgRow(true)}${this.sgRenderFull()}</div>`;\n' +
					"    }\n" +
					"    sgRenderFull() {\n        const toolName = this.tool?.name || this.toolCall.name;\n",
			},
		],
	},
	{
		file: /@mariozechner[\\/]pi-web-ui[\\/]dist[\\/]components[\\/]AgentInterface\.js$/,
		imports: [
			`import { beginPromptSubmission, restoreRejectedPrompt } from ${JSON.stringify(join(packageRoot, "src/storage/prompt-drafts.ts").replace(/\\/g, "/"))};`,
			`import { footerInfo as __sgFooterInfo } from ${JSON.stringify(join(packageRoot, "src/components/footer-info.ts").replace(/\\/g, "/"))};`,
		],
		replacements: [
			{
				// bottom-left of the prompt box: build + session id (src/components/footer-info.ts)
				find: "					${this.showThemeToggle ? html `<theme-toggle></theme-toggle>` : html ``}\n				</div>",
				replace:
					"					${this.showThemeToggle ? html `<theme-toggle></theme-toggle>` : html ``}\n					${__sgFooterInfo(() => this.requestUpdate())}\n				</div>",
			},
			{
				find: "if ((!input.trim() && attachments?.length === 0) || this.session?.state.isStreaming)\n            return;",
				replace:
					'if ((!input.trim() && attachments?.length === 0) || (this.session?.state.isStreaming && this.session?.state.model?.provider !== "prime"))\n            return;',
			},
			{
				find: '        this._messageEditor.value = "";\n        this._messageEditor.attachments = [];',
				replace:
					"        const draftSubmission = beginPromptSubmission(this._messageEditor, input);\n        if (this._messageEditor.attachments === attachments) this._messageEditor.attachments = [];",
			},
			{
				find: "        // Compose message with attachments if any\n",
				replace: "        try {\n        // Compose message with attachments if any\n",
			},
			{
				find: "            await this.session?.prompt(input);\n        }\n    }",
				replace:
					"            await this.session?.prompt(input);\n        }\n        } catch (error) {\n            restoreRejectedPrompt(draftSubmission);\n            if (attachments && this._messageEditor.attachments.length === 0) this._messageEditor.attachments = attachments;\n            throw error;\n        }\n    }",
			},
		],
	},
];
export const piWebUiPatchPlugin = {
	name: "pi-web-ui-patches",
	setup(build) {
		for (const patch of piWebUiPatches) {
			build.onLoad({ filter: patch.file }, async (args) => {
				const { readFile } = await import("node:fs/promises");
				let source = await readFile(args.path, "utf8");
				for (const { find, replace } of patch.replacements) {
					const hit = typeof find === "string" ? source.includes(find) : find.test(source);
					if (!hit)
						throw new Error(
							`pi-web-ui-patches: ${args.path} no longer contains the expected snippet: ${String(find).slice(0, 80)}`,
						);
					source = source.replace(find, replace);
				}
				return { contents: `${patch.imports.join("\n")}\n${source}`, loader: "js", resolveDir: dirname(args.path) };
			});
		}
	},
};

// Build identity shown bottom-left in the panel (src/components/footer-info.ts): the commit this build is from.
function buildIdentity() {
	const git = (args) => {
		try {
			return execFileSync("git", ["-C", packageRoot, ...args], { encoding: "utf8" }).trim();
		} catch {
			return "";
		}
	};
	const sha = git(["rev-parse", "--short", "HEAD"]) || "dev";
	const dirty = git(["status", "--porcelain", "--untracked-files=no"]).length > 0;
	return { sha, dirty, builtAt: new Date().toISOString() };
}

const buildOptions = {
	absWorkingDir: packageRoot,
	plugins: [modelsRegistryPlugin, piWebUiPatchPlugin],
	entryPoints,
	bundle: true,
	outdir: outDir,
	format: "esm",
	target: ["chrome120"],
	platform: "browser",
	sourcemap: isWatch ? "inline" : true,
	entryNames: "[name]",
	loader: {
		".ts": "ts",
		".tsx": "tsx",
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? (isWatch ? "development" : "production")),
		"process.env.TARGET_BROWSER": JSON.stringify(targetBrowser),
		__SITEGEIST_BUILD__: JSON.stringify(buildIdentity()),
		global: "globalThis",
	},
	inject: [join(packageRoot, "scripts/process-shim.js")],
	// Force all mini-lit and lit imports to resolve to sitegeist's node_modules
	alias: {
		process: join(packageRoot, "scripts/process-shim.js"),
		"@mariozechner/mini-lit": join(packageRoot, "node_modules/@mariozechner/mini-lit"),
		lit: join(packageRoot, "node_modules/lit"),
		"lit/decorators.js": join(packageRoot, "node_modules/lit/decorators.js"),
		"lit/directives/class-map.js": join(packageRoot, "node_modules/lit/directives/class-map.js"),
		"lit/directives/unsafe-html.js": join(packageRoot, "node_modules/lit/directives/unsafe-html.js"),
	},
};

// Get all files from static directory
const getStaticFiles = () => {
	return readdirSync(staticDir).map((file) => join("static", file));
};

const copyStatic = () => {
	// Use browser-specific manifest
	const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
	const manifestDest = join(outDir, "manifest.json");
	copyFileSync(manifestSource, manifestDest);

	// Copy all files from static/ directory (except manifest files)
	const staticFiles = getStaticFiles();
	for (const relative of staticFiles) {
		const filename = relative.replace("static/", "");
		// Skip manifest files - we already copied the correct one above
		if (filename.startsWith("manifest.")) continue;

		const source = join(packageRoot, relative);
		const destination = join(outDir, filename);
		copyFileSync(source, destination);
	}

	// Copy PDF.js worker from node_modules (check both local and monorepo root)
	let pdfWorkerSource = join(packageRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	if (!existsSync(pdfWorkerSource)) {
		pdfWorkerSource = join(packageRoot, "../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	}
	const pdfWorkerDestDir = join(outDir, "pdfjs-dist/build");
	mkdirSync(pdfWorkerDestDir, { recursive: true });
	const pdfWorkerDest = join(pdfWorkerDestDir, "pdf.worker.min.mjs");
	copyFileSync(pdfWorkerSource, pdfWorkerDest);

	console.log(`Built for ${targetBrowser} in ${outDir}`);
};

const run = async () => {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	if (isWatch) {
		const ctx = await context(buildOptions);
		await ctx.watch();
		copyStatic();

		// Watch the entire static directory
		watch(staticDir, { recursive: true }, (eventType) => {
			if (eventType === "change") {
				console.log(`\nStatic files changed, copying...`);
				copyStatic();
			}
		});

		// Watch the manifest file for the target browser
		const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
		watch(manifestSource, (eventType) => {
			if (eventType === "change") {
				console.log(`\nManifest changed, copying...`);
				copyStatic();
			}
		});

		process.stdout.write("Watching for changes...\n");
	} else {
		await build(buildOptions);
		copyStatic();
	}
};

if (process.argv[1] === __filename) {
	run().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
