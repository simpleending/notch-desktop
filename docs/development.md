# Developing notch desktop

Public development repository for a free desktop coding workbench, with local open models first and optional OpenRouter, OpenAI and Anthropic API keys.

The desktop port is in development. Its session adapter runs the real CLI provider/tool loop, streams assistant/tool messages, requests exact tool approvals, cancels active work and saves conversation state. An isolated Electron prototype retains the upstream workbench. Full editor/session integration, both themes and release verification are still being completed; this is not a finalized IDE release.

```sh
npm ci --ignore-scripts
npm test
npm run models
npm run inspect:upstream -- --installation "/path/to/installed/app" --out analysis.json
npm run build:core
npm run build:prototype -- --installation "/path/to/installed/app"
```

Node.js 22.19+ is required. The desktop uses CLI 0.7.2 for guided Hugging Face installs and a vendored CLI harness for agent turns. The model picker exposes only specific IPC methods. Desktop API keys are validated with their provider and saved through Electron’s asynchronous OS encryption; no secure store means session-only keys. Keys are not returned to the renderer, included in conversation state, or forwarded to unrelated child processes.

The user confirmed written modification and redistribution rights for the installed Qoder application. Read-only inspection identified its Electron workbench and agent SDK boundary. See [the upstream analysis](upstream-analysis.md). Generated upstream archives, extracted application files, credentials and machine-specific analysis are excluded from Git. Third-party notices must remain with any redistributed components.

The port replaces application branding and provider routing. Actual open model names and repository IDs remain accurate, including Qwen models when selected from the model dropdown. A repository creation date is used for newest-first ordering; it does not establish model capability or quality.

MLX is beta pending Apple hardware verification. No Qoder performance-parity claim or production desktop build is made yet.

The shared CLI core source is included under `vendor/notch-cli` with its license, so the desktop harness can be rebuilt and inspected without a private checkout. The desktop currently vendors 0.7.0 with approval/session extensions; the separately published CLI is 0.7.2. Agent tool restrictions apply independently of global full access.

Initial live harness verification used the installed Hugging Face Qwen3.5 4B model: it read a test, requested write and shell approvals, created a correct finite-number addition function and ran the test successfully. The model was unloaded afterward. An earlier native prototype started with a separate user-data directory; the complete lowercase rename is being validated against inherited runtime/schema assumptions.

The lowercase SVG [wordmark](../assets/notch-wordmark.svg) has [dark](../assets/notch-wordmark-dark.svg) and [light](../assets/notch-wordmark-light.svg) variants. The finalized dark-mode IDE capture will be used on freesyntax.dev after the end-to-end UI gate passes.

The first-launch popup uses a quiet notch welcome and workflow screen, with dark/light appearance, keyboard navigation and the notch wordmark. Startup and onboarding sounds are removed. Setup completion uses the existing validated IPC path and preserves workspace data. Setup appearance now carries into the workbench. Run `npm run verify:setup` after building to check first launch, both appearances, keyboard navigation, completion and restart using a temporary profile.

The workbench uses notch's neutral dark/light palette, wordmark and application icons. The home screen has a small heading, project link and composer. Code/Chat switches and panel launch actions use plain text controls; inherited trees, doodles, heatmaps, pet/mobile promotions and decorative backgrounds are removed from these surfaces. Shared menus, dialogs, editor gutters, file panels and terminal colors follow the same palette. Appearance keeps reading font, text size, interface scale, content width, file icon, terminal and language preferences. `npm run verify:skin` checks the UI in a temporary profile and opens real fixture files; its folder-picker selection is controlled by the test, so it does not test the OS file dialog. These UI checks do not establish production readiness or performance parity.

Menus use softer corners, restrained selection colors and the locally bundled Manrope variable font, including setup. Appearance selects use Chromium's native customizable select, retaining keyboard selection and preference handlers. The font's [OFL notice](../assets/fonts/Manrope-OFL.txt) is included in the application.

Local file-panel search uses [fff](https://github.com/dmtrKovalenko/fff)'s pinned `@ff-labs/fff-node` 0.11.0 library. The existing workspace authorization and picker stay in place; indexing runs lazily in an Electron utility process. Two project indexes are reused, watched for changes and released after one minute idle or shutdown. Symlink results outside the selected root are excluded. Content indexing and memory-map warmup are disabled for this filename-search integration. Native-library failures retain the previous search engine as a fallback. The [MIT notice](../assets/notices/fff-LICENSE.txt) is bundled. This integration does not yet replace CLI grep, composer attachment search or remote SSH search; Windows is the tested platform.

Agent grep now runs ripgrep asynchronously and only uses its JavaScript fallback when the executable is missing. See [search performance](search-performance.md) for regression coverage, measured query latency and the remaining compatibility work before extending Rust content search. Run `node scripts/benchmark-search.mjs` for a reproducible fixture comparison.

`npm run typecheck` validates the shared harness with strict TypeScript settings. `npm run verify:agent` requires the installed Hugging Face test model and an Ollama server on localhost:11436. It uses a fresh profile and real scratch files, sends the task through the composer, clicks native approvals, independently tests the generated implementation, validates execution/context state, resumes after restart and cancels a pending write without changing the file. The test unloads its model afterward. The [production release gates](release-readiness.md) track the remaining work without treating these focused checks as a production release.

The model picker has Installed, Hugging Face and OpenRouter tabs, search, arrow-key navigation and explicit context selection. Hugging Face’s token form is optional and dismissible; public guided downloads need no account. Its metadata is cached for six hours. OpenRouter uses an API key, a cached live catalog filtered for tool support, newest-first ordering and per-million-token pricing. Official provider marks are bundled unchanged. Cloud selection never happens as a fallback from a failed local request.

Local context defaults to 8K where the model and estimated memory allow it (4K on tighter limits). Options are capped by the model’s advertised context and a conservative FP16 KV-cache estimate; hybrid attention is deliberately overestimated. The running model’s own allocation is accounted for when refreshing its limits. These are memory estimates, not guarantees. OpenRouter defaults to 32K or the model’s lower published limit, with larger published contexts selectable independently of device RAM. Every agent request reserves output space, instructions/tool-schema overhead and safety margin. At 80% of the remaining history allowance, the selected model summarizes older turns; the current user task and full tool-call/result chain remain intact. A model-specific failure circuit falls back to deterministic summarization. Original transcripts are saved in the profile’s `notch-sessions/<id>.archives` before compaction. Provider token counts calibrate subsequent checks; oversized current requests fail clearly rather than silently truncating them. The native context inspector displays the latest provider request’s actual counts.
