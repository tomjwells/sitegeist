# Changelog

## [Unreleased]

### Added

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
