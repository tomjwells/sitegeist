/** Type only: the flag src/boot/app-started.ts sets (no code; boot.ts must not set it itself). */
declare global {
	var __sitegeistAppStarted: boolean | undefined;
}
export {};
