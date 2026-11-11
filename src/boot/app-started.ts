/**
 * Imported first by sidepanel.ts, so it is the first code of the bundle to run: from here on the boot loader must not
 * retry a failure (the bundle would run twice). See src/boot.ts.
 */
import "./app-started-type.js";

globalThis.__sitegeistAppStarted = true;
