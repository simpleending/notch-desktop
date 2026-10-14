# notch desktop

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

Node.js 22.19+ is required. Notch CLI 0.7.0 is pinned so the desktop uses its tested model sizing, Hugging Face downloads, isolated Ollama runtime, optional Apple Silicon MLX and memory-release behavior. API keys stay with the CLI credential store. An editor renderer will receive explicit IPC capabilities rather than arbitrary Node or shell access.

The user confirmed written modification and redistribution rights for the installed Qoder application. Read-only inspection identified its Electron workbench and agent SDK boundary. See [the upstream analysis](docs/upstream-analysis.md). Generated upstream archives, extracted application files, credentials and machine-specific analysis are excluded from Git. Third-party notices must remain with any redistributed components.

The port replaces application branding and provider routing. Actual open model names and repository IDs remain accurate, including Qwen models when selected from the model dropdown. A repository creation date is used for newest-first ordering; it does not establish model capability or quality.

MLX is beta pending Apple hardware verification. No Qoder performance-parity claim or production desktop build is made yet.

The shared CLI core source is included under `vendor/notch-cli` with its license, so the desktop harness can be rebuilt and inspected without a private checkout. The published CLI stays at 0.7.0; desktop approval/session extensions are bundled separately here. Agent tool restrictions apply independently of global full access.

Initial live harness verification used the installed Hugging Face Qwen3.5 4B model: it read a test, requested write and shell approvals, created a correct finite-number addition function and ran the test successfully. The model was unloaded afterward. An earlier native prototype started with a separate user-data directory; the complete lowercase rename is being validated against inherited runtime/schema assumptions.

The lowercase SVG [wordmark](assets/notch-wordmark.svg) has [dark](assets/notch-wordmark-dark.svg) and [light](assets/notch-wordmark-light.svg) variants. The finalized dark-mode IDE capture will be used on freesyntax.dev after the end-to-end UI gate passes.

The first-launch popup uses a quiet notch welcome and workflow screen, with dark/light appearance, keyboard navigation and the notch wordmark. Startup and onboarding sounds are removed. Setup completion uses the existing validated IPC path and preserves workspace data. Setup appearance now carries into the workbench. Run `npm run verify:setup` after building to check first launch, both appearances, keyboard navigation, completion and restart using a temporary profile.

The workbench uses notch's neutral dark/light palette, wordmark and application icons. The home screen has a small heading, project link and composer. Code/Chat switches and panel launch actions use plain text controls; inherited trees, doodles, heatmaps, pet/mobile promotions and decorative backgrounds are removed from these surfaces. Shared menus, dialogs, editor gutters, file panels and terminal colors follow the same palette. Appearance keeps reading font, text size, interface scale, content width, file icon, terminal and language preferences. `npm run verify:skin` checks the UI in a temporary profile and opens real fixture files; its folder-picker selection is controlled by the test, so it does not test the OS file dialog. These UI checks do not establish production readiness or performance parity.
