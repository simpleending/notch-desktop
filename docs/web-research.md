# Web research

Open **Settings → Appearance → Web research** to enable or disable built-in web tools, choose DuckDuckGo or Tavily, save or remove an optional Tavily search key, choose Automatic, Edge, Chrome or Chromium, and install optional Chromium. No notch account is required. The CLI provides the same tools through `/settings web` and `notch web`.

- **Search:** `web_search` defaults to [DuckDuckGo public HTML search](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript), with no key or browser installation. You can instead select the official [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) and add a [Tavily key](https://app.tavily.com/). `TAVILY_API_KEY` overrides a saved Tavily key but never changes the provider. DuckDuckGo returns the first page, so the requested count is a maximum. Domain filters are checked against returned hosts. DuckDuckGo can rate-limit requests or request human verification: retry later, open search manually, or select Tavily. notch reports failures instead of inventing results, bypassing verification, or silently falling back to a paid provider. `search_depth` applies only to Tavily. Existing settings without a provider use DuckDuckGo and keep any saved key.
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
