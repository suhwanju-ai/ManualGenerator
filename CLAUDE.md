# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Extension (Manifest V3) that records user interactions on any webpage and uses the Claude Vision API to automatically generate a self-contained HTML manual. No build system or external dependencies — pure browser extension code.

## Development Workflow

**Loading the extension for testing:**
1. Open `chrome://extensions` in Chrome
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `manual-capture-extension/` folder
4. After editing any file, click the refresh icon on the extension card

**Packaging a new `.crx`:**
- Use Chrome DevTools → Extensions → Pack extension (provide `manual-capture-extension.pem` as the private key)
- Update `version` in `manifest.json` before packing

No npm, no build step, no test runner.

## Architecture

The extension is split into three isolated JS contexts that communicate via `chrome.runtime.sendMessage` and `chrome.storage.local`:

| File | Context | Responsibility |
|---|---|---|
| `content.js` | Injected page script | Detects click/input events, highlights elements (red box), collects metadata (CSS selector, label, action, URL), sends step to background |
| `background.js` | Service worker | Receives steps, throttles `captureVisibleTab` (650 ms min interval), takes screenshots, serializes all storage writes via a Promise queue |
| `sidepanel.js` | Side panel page | Renders steps, calls Claude API (max 3 concurrent) with exponential backoff, manages edits, exports HTML |
| `sidepanel.html` | Side panel page | Markup + CSS; uses CSS custom properties for the design system |

**Data flow:** user action → `content.js` → message → `background.js` (screenshot + storage write) → `chrome.storage.onChanged` → `sidepanel.js` re-renders.

### Key implementation details

- **Promise queue** in both `background.js` and `sidepanel.js` prevents race conditions on concurrent storage writes.
- **Sensitive input filtering** — fields matching `password`, `email`, `tel`, `hidden`, and custom regex patterns are never logged and their screenshots are skipped entirely.
- **Three API providers**, selectable in settings: Claude direct (`api.anthropic.com` with the `anthropic-dangerous-direct-browser-access: true` header), OpenRouter, or any OpenAI-compatible custom endpoint (user-supplied base URL + `/chat/completions` — works with Ollama, LM Studio, vLLM, etc.). OpenRouter and custom share one code path (`describeViaOpenAICompat`); screenshots are sent as `image_url` data URLs. Keys/models are stored per provider in `chrome.storage.local` (`apiKey`, `openrouterKey`/`openrouterModel`, `customKey`/`customModel`/`customBaseUrl`) — the settings UI shares input fields and swaps values on provider change. The custom provider's key is optional (local servers); its base URL and model are required.
- **Models:** Claude direct uses `claude-sonnet-4-6`; OpenRouter defaults to `anthropic/claude-sonnet-4.6` (user-overridable). All non-Claude models must be vision-capable. All providers use `max_tokens: 400`. System prompt is Korean; descriptions are 1–2 sentences aimed at non-developer users.
- **Screenshot compression:** JPEG quality 60 to keep payloads small.
- **Render debounce:** 200 ms during active recording.

## Known Constraints

- `captureVisibleTab` only captures the visible viewport — content below the fold is not in the screenshot.
- Page navigations can cause the screenshot to show the destination page rather than the source.
- Cross-origin iframes are inaccessible to `content.js`.
- For production/team use, route API calls through a proxy server instead of embedding the key in the extension.
