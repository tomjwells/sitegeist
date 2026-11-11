/**
 * The panel's last-resort screen: what went wrong, the build, and a Reload button. Shared by the boot loader
 * (src/boot.ts: the main script never loaded) and initApp's catch (it loaded, then failed). Plain DOM, no lit, so it
 * draws even when the app bundle did not run (Tom 2026-11-11: a panel that failed to load stayed black with no text).
 */
export const BOOT_ROOT_ID = "sg-boot";

function version(): string {
	try {
		return chrome.runtime.getManifest().version;
	} catch {
		return "unknown";
	}
}

/** Replaces the whole panel with the error view. */
export function showBootError(title: string, err: unknown): void {
	const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	const root = document.createElement("div");
	root.id = BOOT_ROOT_ID;
	root.setAttribute("data-boot-error", "true");
	root.className = "w-full h-full flex flex-col items-center justify-center gap-3 p-6 bg-background text-foreground";
	const h = document.createElement("div");
	h.className = "text-base font-medium";
	h.textContent = title;
	const p = document.createElement("pre");
	p.className = "text-xs text-muted-foreground whitespace-pre-wrap break-words max-w-full";
	p.textContent = `${detail}\nsitegeist ${version()}`;
	const b = document.createElement("button");
	b.type = "button";
	b.className = "px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm";
	b.textContent = "Reload";
	b.addEventListener("click", () => window.location.reload());
	root.append(h, p, b);
	document.body.replaceChildren(root);
}

/** The boot loader's "Loading" text; the app removes it when it starts drawing. */
export function showBootLoading(text: string): void {
	let root = document.getElementById(BOOT_ROOT_ID);
	if (!root) {
		root = document.createElement("div");
		root.id = BOOT_ROOT_ID;
		root.className = "w-full h-full flex items-center justify-center bg-background text-muted-foreground";
		document.body.prepend(root);
	}
	root.textContent = text;
}

export function removeBootScreen(): void {
	document.getElementById(BOOT_ROOT_ID)?.remove();
}
