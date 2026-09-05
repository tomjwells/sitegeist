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

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

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
		],
		replacements: [
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
		file: /@mariozechner[\\/]pi-web-ui[\\/]dist[\\/]components[\\/]AgentInterface\.js$/,
		imports: [],
		replacements: [
			{
				find: "if ((!input.trim() && attachments?.length === 0) || this.session?.state.isStreaming)\n            return;",
				replace:
					'if ((!input.trim() && attachments?.length === 0) || (this.session?.state.isStreaming && this.session?.state.model?.provider !== "prime"))\n            return;',
			},
		],
	},
];
const piWebUiPatchPlugin = {
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

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
