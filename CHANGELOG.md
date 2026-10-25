# Changelog

## [Unreleased]

### Added

- **Tab organizing: `browser_tab_action`** (Tom, 2026-10-24: "I want to organize my tabs ... into targeted windows"; 284 tabs in 15 windows, and prime's browser tools could only read tabs). New prime tool, handled in `src/prime/browser-tools.ts`:
  - `action: "close"` with `tabIds` closes the tabs; details list each closed tab's title, url and window. The R730 side (`~/.prime/agent/extensions/sitegeist-browser-tools.ts`) appends them to `~/.prime/agent/state/sitegeist-browser/closed-tabs.jsonl`, so any closed tab can be reopened.
  - `action: "move"` with `windowId` appends the tabs to that window; with `newWindow: true` they go into a new window opened in the background (`focused: false`), so Tom's focus stays.
  - Never touches the panel's own tab (`panelTab()`, `chrome.tabs.getCurrent()`) or extension pages; unknown ids are reported, not fatal. No new permission: `chrome.tabs.remove`/`move` and `chrome.windows.create` need none.
  - `browser_tabs` (R730 side) shows a `win` column with each tab's window id and has `windows: true` (one line per window: id, tab count, front tab). Its deadline is 30 s instead of 15 s: with 284 tabs the panel missed 15 s twice.
  - Test: `npm run test:tabs:extension` (real Chromium, stand-in relay): move two tabs into a new window and a third into it, `browser_tabs` reports the window, close two tabs plus an unknown id, the panel refuses to close itself, and a move without a target is refused.
- **Fullscreen artifacts** (Tom, 2026-10-17: "Can you add ability to fullscreen previews in the artifacts UI ... This could be a little icon next to the download icon in top right"). A fullscreen button sits right of the artifact's own buttons (download), for every artifact type (`src/components/artifacts-fullscreen.ts`).
  - sitegeist in a tab (split view, or sidepanel.html as a tab): the artifacts panel element itself goes fullscreen (Fullscreen API). The icon turns into "Exit fullscreen"; Esc or the button leaves.
  - Side panel / sidebar: browsers do not let a side panel go fullscreen. In Chrome 155 `requestFullscreen()` in a real side panel never settles; Firefox only lets the selected tab go fullscreen. So the button opens the artifacts in a new window created in fullscreen state (`chrome.windows.create({ type: "popup", state: "fullscreen" })`; maximized if a platform refuses). The window is `sidepanel.html?view=artifacts&token=…` in viewer mode (`src/components/artifacts-viewer.ts`): only pi-web-ui's ArtifactsPanel, with every artifact, starting on the one being viewed, rendered exactly as in the panel. It asks the panel for the artifacts over runtime messaging, because `storage.session` would cap them at 10 MB. Esc, the exit button or the close X close the window. A stale link shows a notice with a close button. A tab whose fullscreen request is refused falls back to the same window.
  - The maximize toggle (artifacts take the whole panel) now uses a hide-the-chat icon (PanelLeftClose/PanelLeftOpen), so it is not mistaken for fullscreen. It is hidden in the fullscreen window and while the panel is fullscreen. Esc while fullscreen never aborts a running agent.
  - Tests: `npm run test:fullscreen:extension` drives a real Chrome side panel (`chrome.sidePanel.open`) over raw CDP, because Playwright attaches to tabs only. It checks:
    - the button's place;
    - the window: popup, every artifact, the active one first, the image shown at 1600 px instead of the 360 px panel;
    - Esc and the exit button close the window;
    - the stale-link notice;
    - in a tab: element fullscreen, Esc to leave, no window.
  - The Zen test adds element fullscreen in a tab, and the window route with fullscreen refused (Zen reports the window state as "fullscreen").
  - Headless Chrome cannot show a fullscreen window; the window state there is not asserted.

- **sitegeist in a split of 3 or 4 pages** (Tom, 2026-10-13, testing a Zen split of Bulletin + week view + month view + sitegeist: "Any other tests I should run to see if it can use its joined tabs"):
  - The agent now knows every page on screen. Each prompt's page context lists the other panes of the split view with their tab ids ("Other pages on screen in the split view with the panel: [tab 28] "Bulletin" …"; from the side panel: "Also on screen (split view): …"). `browser_tabs` gains a mark column: `*` in front of its window, `+` another pane on screen, `>` the default page, with a legend. `pagesOnScreen()` in `src/utils/target-tab.ts`: Chrome reads `splitViewId`; Zen gives extensions no split ids, so recently used tabs are asked whether their page is visible.
  - The default page in such a split is the pane Tom clicked last. It always was; now the context says so.
  - From sitegeist as a tab, tools never switch tabs. Reading a tab outside the split (e.g. the todo list) used to bring that tab to the front, which in Zen hides the whole split and the chat. They now work on it where it is; `focus: true` (Tom asked to be shown the tab) still switches. `browser_pick_element` on a tab outside the split brings the tab forward for the pick, then returns to the chat. From the side panel nothing changes.
  - Tests: the Zen test now joins three pages with the panel and checks the marks, the prompt context, the default following the last-clicked pane, and that reading an off-split tab leaves Tom in the split. The Chrome split test checks the marks, the context and the off-split read.

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

- **A new R730 chat could vanish from the list** (Tom, 2026-10-25: a Jennifer chat about whey "has disappeared"). A main-pi or coach chat only went into the panel's list when its first reply arrived; the panel had left the chat about 30 s after sending, so only the R730 had it. Now a new chat is listed as soon as the R730 has its first message. And a chat the list does not have can be opened by id: paste its `sg-…` id into the sidebar search and press **Open it from the R730** - it opens with its history from the R730 and joins the list. An id the R730 does not have says so and creates nothing (relay `GET /sessions/:id/exists`, `PRIME_RELAY_VERSION=2026-10-25.1`, reads the log size only). Test: both, red before the fix.
- **A chat that another panel had open would not open, with no word why** (Tom, 2026-10-25: "why can't I select this conversation in Zen?"). The sidebar of another Zen window held the chat (it had auto-resumed it from a page anchor), so the click fell back to the landing page: Browser agent, `claude-sonnet-4-6`, "new session", nothing said. Now the panel says `"<chat>" is open in another window's panel.` (or `in a sitegeist tab`) with **Open here anyway**, which takes the chat over; the other panel is told and starts a new chat (its unsent draft stays with it). A lock whose panel no longer exists (window or tab gone; in Firefox / Zen also a sidebar document that is gone) is dropped on sight, so a dead panel can never hold a chat. Zen test: two windows, the second opens the first's chat, sees the notice, takes it over, the first lets go. Red before the fix (the landing page from Tom's screenshot), green after.
- **The Browser agent defaulted to `claude-sonnet-4-6`** (Tom, 2026-10-25: "why is it defaulting to sonnet?"). That was upstream's fallback; a fresh profile now starts the Browser agent on `claude-opus-5-5`, the same interactive default as a new main-pi or coach chat. A model you picked is still remembered as before.

- **Attachments on an unsent message were lost when switching tabs** (Tom, 2026-10-24: "If I try to attach things, then change the browser tab, it reloads but loses the attachments" - as he was typing, not sent yet). Switching to a page that has its own chat reloads the panel onto that chat. The typed text came back (it is saved as a draft on every keystroke); the files were not part of the draft. Now they are: the editor's attachment list is saved on every change (add, paste, drop, remove) under the same key as the text, in IndexedDB (`draft-attachments` store, DB v5; a draft can hold 10 files of 20 MB), restored when the editor comes back, moved with a new chat's first message, cleared when the message is sent, dropped with a discarded draft, and carried along by "Open next to this page". Local to the browser profile, like the text. `test:anchors:extension` now attaches a file, types, switches to a page with another chat (that chat's draft is empty), switches back (text and file are back), removes the file, switches twice more (it stays removed).

- **A message that did not reach the R730 looked sent, and a resend could run the task twice** (Tom, 2026-10-18, on a train: his "Sources page" message to Sed Coach showed twice in the chat; the R730 had it once and Sed Coach had built the page, but the panel's connection was down, so the reply never arrived and the second copy never left the browser).
  - A user message is now shown at once and marked: "Sending…" while the POST is in flight; "Not sent (reason). It goes out when the connection is back." with **Retry now** and **Discard** when it failed (no connection, timeout, relay error). The header shows "N unsent". A failed send never leaves the chat looking busy. (`src/prime/send-state.ts`, `UserMessageRenderer`)
  - Failed messages go out by themselves, oldest first, when the live connection is back (socket reopened, or the browser's `online` event). A new chat whose first message failed retries on a timer. A failed message survives a panel reload, still marked and retryable.
  - **Never twice:** every send carries a `clientMessageId`. The relay (cors-proxy `2026-10-18.1`) prompts the bridge once per id and answers a repeat with `duplicate:true`; accepted ids are kept on disk per chat (`/data/sitegeist/sent-prompts/`), so a relay restart does not forget them. The panel treats `duplicate:true` as "sent" and does not add a second bubble; a repeat of a prompt accepted before the chat was loaded is dropped, because the history already shows it.
  - **The status light tells the truth.** It is a live WebSocket, not a poll. The panel now expects a pong to its 20 s pings and drops a connection that stops answering within 45 s, instead of waiting a minute for the browser to notice; the browser's offline/online events cut the backoff short. The tooltip says "connected (live events, pinged every 20 s)", "lost — connection lost; retrying in 4 s (attempt 3)", "error — no connection; retrying in 10 s", and the unsent count. A chat opened while offline keeps trying (5 s, 10 s, 20 s, 40 s) instead of dying.
  - A prompt POST now times out after 45 s (was 90 s); a retry is safe.
  - Test: `npm run test:send-retry:extension` replays the train in Chromium against the stand-in relay (`tests/prime-relay.fixture.ts` can go offline, lose a prompt's answer, and echoes accepted prompts like the bridge): lost light; two messages fail and are retried in order, once each, with distinct ids; a prompt whose answer was lost resolves as a duplicate with no second prompt and no second bubble; Discard; a failed message survives a reload and goes out when the connection is back.

- **A new coach chat ran on a different model than its label** (Tom, 2026-10-18: a Shredded Coach chat showed claude-opus-5-5, and on send the label flipped to claude-sonnet-5-5; three tries in four minutes). A new chat shows the interactive default, claude-opus-5-5. That is also what the Telegram router gives every new human chat, coach topics included. The panel applied it only to main-pi, so a coach chat started on the coach body's automation default (`PI_AGENT_DEFAULT_MODEL`, claude-sonnet-5-5). The label then showed what was really running. Now every agent's new chat applies the shown model before the first prompt (`applyInitialModel` in `src/sidepanel.ts`). A model picked mid-chat already worked. `test:prime-model:extension` now also opens a new Shredded Coach chat without touching the picker, and asserts `set_model=claude-opus-5-5` before the prompt and that the label stays opus.

- **A chat could get stuck on "At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels"** (Tom, 2026-10-17, main-pi chat sg-7a480633fce6). Pasted screenshots went to the model at full size (a Retina screenshot: 3432 px wide). Anthropic accepts that while a request holds few images, but caps every image once a request holds more than 20. Every turn re-sends the whole chat, so when the 21st image arrived (the agent's own screenshot), every later turn failed, Tom's "?" included.
  - Images now reach the model scaled to fit 2000 px on both sides (`src/utils/image-size.ts`, `src/utils/model-image.ts`), with PNG kept as PNG and JPEG as JPEG. The model API scales images down to about 1568 px before the model sees them, so nothing visible is lost.
    - prime sessions: pasted images, in `PrimeRemoteAgent.prompt`. The upload to the R730 stays the full-size original, and the attachments block says so: "scaled to 2000x1169 from 3432x2006; the file is full size".
    - The Browser agent: every user and tool-result image, in the message transformer (cached by content hash, because every turn re-sends them).
    - `browser_screenshot`: `maxWidth` at most 2000, and a tall window also fits 2000 px high.
  - The chat itself keeps the originals for display.
  - The stuck chat was repaired on the R730 by scaling its two oversized screenshots and switching the live session to the repaired copy. No messages were lost.
  - Tests:
    - `npm run test:image-size`: sizes from PNG/JPEG/GIF/WebP headers, plus the fit rules.
    - `npm run test:model-image`: the real scaling code in Chromium.
    - `test:prime-model:extension` now attaches a 3432x2006 screenshot in the real panel. The relay receives it at 2000x1169, the uploaded file stays 3432x2006, and the prompt notes the scaling.
    - `tests/prime-attachments.test.ts` covers the note.

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
