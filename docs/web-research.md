# Web research

Open **Settings → Appearance → Web research** to choose a search provider, manage its key, turn web access on or off, and choose a browser for page reading. No notch account is required.

- **Search:** `web_search` sends queries directly to the selected provider. The default is [DuckDuckGo public HTML search](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript), which requires neither a key nor a browser installation. If DuckDuckGo requests human verification, retry later, open it manually, or choose a keyed provider. Search failures are reported without switching providers. `search_depth` applies only to Tavily.
- **Keys:** Choose [Tavily](https://app.tavily.com/), [Serper](https://serper.dev/), or [SerpApi](https://serpapi.com/dashboard) and save the matching key in Web research settings. `TAVILY_API_KEY`, `SERPER_API_KEY`, and `SERPAPI_API_KEY` override the corresponding saved keys. Provider selection is separate from key setup. Saved keys use system encryption where available and stay in memory for the session otherwise.
- **Read a known page:** `web_fetch` retrieves HTTP(S) text, HTML or JSON without a search key. Responses have a 2 MB download limit and a configurable output limit. Binary documents are not parsed.
- **Read a JavaScript page:** `browser_read` uses [Playwright](https://playwright.dev/docs/browsers) with an installed Edge or Chrome, or optional Chromium. It returns visible text, links and control descriptions. It can wait for a CSS selector to appear.
- **Interact:** `browser_interact` opens a URL, then performs up to eight CSS-selector click, fill, select or keypress actions and reads the result. It follows the task approval policy. Read-only tasks cannot use it. Include a complete action sequence in one call.

Browser sessions are private and temporary. Login state, cookies and form state do not persist to the next call. Downloads and popups are disabled, and each session closes after success, error, timeout or cancellation. Chromium setup is a separate user action and never starts silently during a tool call. Linux installations may additionally need the system libraries listed in Playwright's browser documentation.

Source links in conversations are clickable. Search and page results include retrieval times and identify external content as untrusted data. The assistant is instructed to cite retrieved URLs and prefer official sources. A language model can still misinterpret a page; open cited sources when accuracy matters.

Desktop search keys use system encryption. If secure key storage is unavailable, a key lasts only for the current app session. Settings do not return a key to the renderer after saving, and keys are not added to model prompts or saved conversations. The CLI stores its separate key in its per-user configuration with restrictive file permissions, or accepts an environment variable. Search queries go to the selected provider and page requests go to their websites, including when inference runs locally.

Turning off Web research disables these built-in web tools. Task shell commands, separately configured plugins and MCP servers have their own access controls; this setting does not act as a network firewall.


## Verification

`npm run verify:web -- <Notch.exe> <report.json>` uses the dev-only `electron-qa` package pinned to Playwright 1.64.0 for Electron connection. Playwright 1.64.1 can hang while connecting to this app's permanent hidden window; browser research itself uses the current 1.64.1 runtime. See the upstream [Electron connection issue](https://github.com/microsoft/playwright/issues/43247). The QA alias is excluded from runtime packaging.

The verifier uses a temporary profile, the installed 4B local-model test runtime on port 11436, real browser page rendering and interactions, native approvals, live keyless DuckDuckGo searches, and an explicitly identified Tavily contract fixture. It does not claim to test a live Tavily account or billing. It tests saving/removing keys, web access, browser setup and restart persistence before model tasks. Run the CLI's `verify:web` script against a fresh independently installed tarball as well. Unload the test model after the run.
