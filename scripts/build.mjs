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

// The composer's thinking dropdown is hardcoded to Off..High inside pi-web-ui's MessageEditor; swap the
// array for src/thinking-options.ts so models with their own rungs (Fable: off/xhigh/max in prime-agent
// sessions) and XHigh-capable models get the right list. Fails the build loudly if upstream changes shape.
const thinkingOptionsPlugin = {
	name: "thinking-options",
	setup(build) {
		build.onLoad({ filter: /@mariozechner[\\/]pi-web-ui[\\/]dist[\\/]components[\\/]MessageEditor\.js$/ }, async (args) => {
			const { readFile } = await import("node:fs/promises");
			const source = await readFile(args.path, "utf8");
			const start = source.indexOf("options: [\n                    { value: \"off\"");
			const end = source.indexOf("],", start);
			if (start === -1 || end === -1) throw new Error("thinking-options: MessageEditor.js no longer matches the expected options array");
			const helper = join(packageRoot, "src/thinking-options.ts").replace(/\\/g, "/");
			const contents =
				`import { thinkingOptionsFor as __thinkingOptionsFor } from ${JSON.stringify(helper)};\n` +
				source.slice(0, start) +
				'options: __thinkingOptionsFor(this.currentModel, this.thinkingLevel).map((o) => ({ value: o.value, label: i18n(o.label), icon: icon(Brain, "sm") }))' +
				source.slice(end + 1);
			return { contents, loader: "js", resolveDir: dirname(args.path) };
		});
	},
};

const buildOptions = {
	absWorkingDir: packageRoot,
	plugins: [modelsRegistryPlugin, thinkingOptionsPlugin],
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
