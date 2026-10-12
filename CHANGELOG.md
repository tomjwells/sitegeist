# Changelog

## [Unreleased]

### Added

- **sitegeist next to the page** (Tom, 2026-10-12: "When I moved the overleaf agent UI from an extension to an independent webpage that I used in a split-tabs view in the browser it was instantly 10x more useful"). sitegeist can run as a normal browser tab beside the page you are reading, and keeps every browser power: it reads, drives and screenshots the page beside it.
  - Open it with the new **Open next to this page** button in the panel header (it moves the current chat, with its unsent text, into the tab and closes the side panel), with **Open sitegeist next to this page** in the toolbar icon's right-click menu, or with Alt+Shift+S. If a sitegeist tab already sits beside the page, the menu and the shortcut bring it to the front.
  - Chrome 155+ opens a real split view (Split View API, `tabs.create({ splitWithTabId })`), with sitegeist on the right. Zen, Firefox and older Chrome cannot be split by an extension: the tab opens right after the page with both tabs selected, and a one-time hint says how to join them (Zen: right-click → "Join 2 Tabs").
  - One rule decides which page sitegeist works on (`src/utils/target-tab.ts`), used by every tool that acted on "the active tab": prime's `browser_*` tools, the Browser agent's tools (`navigate`, `browserjs()`, native input, `extract_image`, `ask_user_which_element`, `debugger`, `skill`), the page context sent with each prompt, and page anchors. The side panel still uses the window's active tab. A panel tab uses the page beside it: the other half of a Chrome split view; in Zen (no split ids for extensions) the visible page next to it, or the page it was opened for. A tab the agent opens or switches to is the page until Tom's next prompt.
  - A page beside the panel is never brought to the front, because that would move the keyboard out of the chat. Screenshots of it use Firefox's `tabs.captureTab`. In Chrome the page comes forward for the capture, and the panel comes back right after it. `browser_navigate newTab` from a panel tab opens the new tab behind the split view. `browser_tabs` marks the page the tools use with `>` when it is not the tab in front.
  - Session locks and the open-panel bookkeeping are per panel (`w:<windowId>` for the side panel, `t:<tabId>` for a panel tab), so a panel tab and the side panel of the same window never open the same chat twice. Unsent drafts are kept per panel. The panel header of a panel tab shows the page it works on (⇆ title).
  - Tests: `npm run test:split:extension` (real Chrome 155, Chrome for Testing): the move, the split view, the moved draft and lock, and prime's `browser_eval` / `browser_page` / `browser_tabs` / `browser_screenshot` / `browser_navigate` over the relay socket working on the page while the chat keeps the focus, also after Tom clicks into the page or goes to another tab, an agent-opened tab until the next prompt, and no second panel tab from the menu. `npm run test:firefox:extension` adds the same in REAL Zen 1.23.2b: tab placement, the moved draft, then the tools after the two tabs are joined in Zen's split view.

- **Firefox / Zen build** from the same source (Tom, 2026-10-12: "Why can't I install sitegeist on Zen browser?"). `npm run build` now builds `dist-chrome/` and `dist-firefox/` (`scripts/build.mjs --target firefox`, manifest `static/manifest.firefox.json`: MV3, `sidebar_action`, background `scripts` with `type: module`, `userScripts` as an optional permission, gecko id `sitegeist-dev@tjw-private`, `strict_min_version` 154 for the manifest `sandbox` key). The Firefox version is `1.0.<commit count>`, so every published commit is a newer version for Firefox's update check. `publish-extension sitegeist` publishes both: the Chrome zip, plus `sitegeist-dev-firefox/<file>.xpi` and `updates.json` (self-hosted updates through the manifest `update_url`, so an installed copy updates itself).
  - The toolbar button toggles the extension sidebar (`sidebarAction`, synchronously in the click handler), and Cmd/Ctrl+Shift+S runs `_execute_sidebar_action`. Chrome keeps the side panel. Browser differences are detected in one place, `src/utils/browser-compat.ts`.
  - Firefox has no `chrome.debugger`. `nativeClick` / `nativeType` / `nativePress` / `nativeKeyDown` / `nativeKeyUp` fall back to page events through a user script (`src/tools/synthetic-input.ts`: pointer/mouse events, `execCommand("insertText")` so React inputs see the text, Enter submits forms). The runtime description tells the agent they are synthetic. The `debugger` tool's `eval` runs in the page's own world via `userScripts.execute({ world: "MAIN" })`.
  - The background script registers the user-script message relay again once the optional permission is granted. The stale "Firefox is currently not supported for browserjs()" error now tells the user how to enable page scripts.
  - Settings → Instructions → Proxy token has a **Copy** button (browsers block copying from password fields), so the token can be pasted into sitegeist in another browser. The welcome dialog mentions it.
  - Test: `npm run test:firefox:extension` runs the add-on in REAL Zen 1.23.2b (Firefox 157), headless, through geckodriver's WebDriver HTTP API. It covers: permanent unsigned install; the toolbar button closes/opens the sitegeist sidebar; "Grant Permission" grants `userScripts`; page scripts in the isolated and page worlds; `captureVisibleTab`; synthetic click/type/Enter on a real form; a PDF artifact in Firefox's own PDF viewer; an HTML artifact running its inline script in the extension sandbox. The test is skipped when Zen/geckodriver are not cached in `~/.cache/sitegeist-firefox-test/`.

### Fixed

- Image artifacts taller than the panel are shown whole (fitted). The image pushed past the bottom of the panel and was cut off, because the flex row's `min-height: auto` defeated `max-h-full`. Maximize made this happen for landscape images too.

- prime-agent sessions: artifacts the agent sends (`telegram_attach` → artifacts panel) are now saved with the session the moment they arrive. Before, they were only saved with the next agent event; a figure that landed after the turn's end (the usual case) was shown but not saved, and vanished when the panel was closed or reloaded. The R730 relay now also keeps a copy of every file it delivers (per session, newest 40), and on resume the panel restores any artifact it does not have ("Restored N artifacts from the R730"). Deleting a session drops the R730 copies. Covered by `npm run test:prime-model:extension`.

### Changed

- PDF artifacts open in Chrome's built-in PDF viewer (an iframe on a blob: URL of the bytes, fitted to the panel width, no thumbnail pane): text is sharp at every zoom, and the viewer's toolbar has page navigation, zoom, find, rotate, print and download. pi-web-ui's viewer drew every page into a canvas at a fixed 1.5x scale in CSS pixels and stretched it to the panel width, so text was blurry on a Retina screen. If Chrome is set to download PDFs instead of opening them (`navigator.pdfViewerEnabled` is false), the pages are drawn with pdf.js at panel width x devicePixelRatio (sharp) and drawn again when the panel width changes. Content that is not a PDF shows an error. A rewrite of the artifact shows the new document; blob: URLs are revoked when the content changes or the artifact goes away. The viewer's own title and download button name the file after the blob id; the panel's Download button keeps the artifact filename.

- Agents are told to draw when it helps: the prime-session browser context (main-pi and every coach) and the Browser agent's system prompt now say that when a concept is geometric or spatial, or is best explained with typeset LaTeX, a picture, a chart, a diagram or another graphic, the agent should make one and show it in the artifacts panel (prime: `telegram_attach`; Browser agent: an HTML/SVG artifact).

### Fixed

- prime-agent sessions: a model or thinking level chosen before the first message is now applied to the new bridge session before the prompt is sent. Before, the session was created on the first send with the bridge's automation default (claude-sonnet-5-5 / high), the choice was dropped, and the label silently flipped. New main-pi sessions now default to claude-opus-5-5 (the router's interactive default) and actually run it. After applying, the panel reads the running model/level back; if the bridge refused or clamped something, a toast says so. Test: `npm run test:prime-model:extension`.

### Added

- Artifacts panel: a maximize button (top right, left of the close X) gives the artifacts the whole side panel width, for every artifact type (PDF, images, HTML, Markdown, SVG, text, ...). The chat is hidden but keeps its scroll position and unsent text. Press the button again, or Escape, to bring the chat back. Maximize stays on when you switch artifact tabs, and ends when the panel is closed or reloaded. While maximized, Escape only restores the chat and never aborts a running agent (the next Escape does; a held-down Escape never aborts). Escape cannot reach the panel while keyboard focus is inside the PDF viewer or an HTML artifact; use the button there. Below 800 px wide the panel is already a full-screen overlay, so the button is not shown. Test: `npm run test:artifacts:extension`.

- prime-agent sessions: notices from the R730 bridge (`bridge_notice` journal events, e.g. its dead-call watchdog aborting a model call that sent nothing back for 30 s or was still waiting at a model switch) show as a toast. They were dropped with the other non-agent events. Notices older than 2 minutes (replayed on attach/reconnect) and repeats are not shown. Unit test: `npm run test:bridge-notice`.

- Footer, bottom left under the prompt box: `v<version> · <build sha> · <session id>` in light grey, so the build and session are visible and appear in screenshots. Click the id to copy it; it pastes straight into the sidebar search.

- Sidebar search: a prime session's harness UUID (what session-finder and Telegram's `/session_resume` show) finds the sitegeist session right away — the sidebar loads the relay's `GET …/native-ids` map (main-pi `sg-…` → UUIDs) on open, instead of only knowing a UUID after the panel had opened that session. A UUID that belongs to another browser's session, or to a Telegram/CLI session, gets a specific explanation. `"Quoted phrases"` match as one term (like session-finder).

- Sessions sidebar search is full-text: every session's whole transcript (user/assistant text, thinking, tool output, visited page titles/URLs, attachment and artifact names) plus its bound pages is indexed in a new `sessions-search` IndexedDB store (schema v4; older sessions are indexed lazily when the sidebar opens, with an "Indexing N sessions…" note). Matching is exact and case-insensitive, every word must occur, ranked by hit count (title hits weighted) then recency, each row showing a highlighted snippet and `×N`. Pasting a session id — `sg-…`, a UUID, a session-finder line, a `/session_resume …` command or a jsonl path — lists the session with that id; prime sessions are also found by their R730 UUID/jsonl path once the panel has opened them. Replaces the fuzzy title+preview search (Fuse, threshold 0.4) that returned twenty near-misses and buried the real hit. Tests: `npm run test:search`; covered in `test:anchors:extension`.

- Page anchors: a session is bound to the pages it was used on (canonical page URL, page level; YouTube watch/shorts/youtu.be forms, Amazon dp, eBay items and Google searches collapse to one key; tracking params ignored). Every prompt binds the active tab to the session (up to 12 auto anchors per session, oldest dropped); the header link button attaches/detaches the current page by hand (pinned, never dropped). Opening the panel on a bound page resumes that session; switching to a bound tab while the panel is idle switches to its session, with an Undo toast. Undo / picking another session / New on a page stops auto-resume for that page until the panel is reopened or the page is bound again. Sessions sidebar gets a "This page" section (with detach) and per-session page counts; the toolbar icon shows a badge + "Resume in sitegeist: …" tooltip on bound tabs, so a closed panel (browser restart) is one click from the session. Stored per browser profile in `chrome.storage.local`. Tests: `npm run test:anchors` (pure logic) and `npm run test:anchors:extension` (built extension in Chromium).

### Changed

- prime-agent sessions: files attached in the composer (PDF, DOCX, images, ...) are shipped to the agent's host as files (relay `/sessions/:id/files` -> bridge `/files`) and the prompt names their saved paths in a `[sitegeist attachments]` block, instead of pasting the document's extracted text into the prompt. The agent can read the file itself or `browser_upload_file` it into a page (e.g. a CV into a job-application form). The chat bubble shows the attachment tiles (or a one-line "Attached: ..." after a reload); a failed upload falls back to the extracted text. Unit tests: `npm run test:attachments`.

### Fixed

- Preserve unfinished prompt text locally per window and chat when the side panel is recreated or reloaded; browser-tab switches never change the draft key.
- Restore prompt text after a rejected send, and do not erase a newer draft typed while send preparation was pending.

## [1.0.0] - 2026-03-15

### Added

- Browser-based OAuth login for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), GitHub Copilot, and Google Gemini CLI
- Combined "API Keys & OAuth" settings tab with subscription login and API key entry
- Welcome setup dialog on first launch when no providers are configured
- Auto-select default model for the first provider with a key
- Provider and auth type indicator in the header bar
- Image extraction tool (`extract_image`) with selector and screenshot modes
- Subsequence-based fuzzy search in the model selector
- CORS proxy warning in OAuth sections (orange when enabled, red when disabled)
- GitHub Actions workflow for tagged releases
- `release.sh` script for version bumping and tagged releases

### Changed

- Default model changed to `claude-sonnet-4-6` with `medium` thinking level
- CORS proxy enabled by default
- Model selector only shows models from providers with configured keys
- API key prompt dialog now shows both OAuth login and API key entry for supported providers
- Tool execution set to sequential mode (parallel caused rendering issues in sidebar)
- Site converted to static (removed backend, admin, waitlist signups)
- Download links point to GitHub Releases
- License changed from MIT to AGPL-3.0

### Fixed

- Settings dialog tabs not responding to clicks (upstream `pi-web-ui` built with `tsgo` broke Lit decorator reactivity)
- CORS proxy toggle not updating (same root cause)
- Proxy not applied to API requests (esbuild bundled duplicate `streamSimple` references, breaking identity check)
- Model selector button not updating after picking a model (added `state_change` event to Agent)
- Duplicate tool component rendering during streaming (cleared streaming container on `message_end`)
- Screenshot tool capturing sidepanel instead of the webpage
