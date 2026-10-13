# Desktop port baseline

Inspected on 2026-10-13, using the installed Windows x64 application. The user confirmed written modification and redistribution rights. No installed files, account credentials or Qoder user data were modified.

| Component | Observed baseline |
| --- | --- |
| Application | Qoder 0.4.4, stable, build 78174479 |
| Commit | `169d3c7ebb102b2d20a62c48c80e449af516513d` |
| Runtime | Electron 43.1.1 |
| Main bundle | `out/main/index.js`, approximately 12.1 MB |
| Renderer | Bundled React 19.2 workbench, with editor, virtual lists, xterm and workers |
| Agent SDK | `@ali/qoder-agent-sdk-next` 1.0.51, imported through an alias |
| Agent worker | `dist/_worker/qoder-worker-runtime.obf.mjs`, approximately 33.1 MB |
| Archive SHA-256 | `e1c9f8eaa1edcdaffc42f2cf12d4f879702eb924c1109219801dbc12d848ae28` |

The Electron archive can be read without executing the application. Its preload exports renderer capabilities through `contextBridge`. Model discovery, provider configuration, sessions, cancellation and permission changes use separate IPC channels. The main execution service calls SDK `query`/`startup` with streaming messages, `canUseTool` and an abort controller. These boundaries allow replacement of provider execution while retaining the existing workbench's rendering and editor workers. [Electron ASAR documentation](https://www.electronjs.org/docs/latest/tutorial/asar-archives)

The existing custom-provider path is account-bound: `requireAccountId()` rejects signed-out state; composer model discovery checks sign-in; session options obtain job-token callbacks. A label replacement alone cannot produce a local, sign-in-free product. The Notch port needs its own local session/catalog service and agent adapter. Qoder tokens and cloud daemons are not the intended local runtime.

The archive contains 5,272 entries and no source maps. The first extraction reported 15 absent unpacked entries, including macOS/Windows ARM64 native libraries and a Windows Sharp license entry. Windows x64 native modules are present separately. The inspection tool records missing unpacked entries without treating a partial extraction as a verified distributable. A build must verify the platform's required native modules and preserve notices.

The new bridge invokes the pinned Notch CLI directly, without a shell, and parses its machine-readable model catalog. Available-memory detection is refreshed on each request; model metadata/download reuse remains owned by the CLI. Installation checks tool calling before saving a project model and unloads after setup. Cached publisher/lab raster logos use public Hugging Face profiles, deduplicate concurrent requests, and fall back to initials when unavailable. Logo bytes are cached on disk rather than fetched repeatedly by the renderer.

Initial verification: seven tests cover literal arguments/Unicode, input rejection, subprocess failure/cancellation, concurrent logo caching and fallback, integration-point discovery and read-only archive inspection. The published CLI bridge returned real memory-fit recommendations on this computer. Live Qwen, MLX Community and Unsloth logo fetches succeeded; the immediate repeat reads came from disk cache. Production and full dependency audits reported zero advisories. Electron execution, full desktop UI and performance parity remain unverified.

Next integration work:

1. Reconstruct the session adapter around the SDK query/message boundary, including streamed assistant/tool events, per-tool approvals, cancellation and persistent session history. Preserve read-only/approve/full-access semantics from the CLI.
2. Replace account-bound model catalog and configuration services with local state. Offer optional API keys after local setup; disable upstream sign-in, billing, update and telemetry routes for Notch.
3. Rebrand application IDs, protocols, user-data directories, menus, icons and renderer globals with separate migration handling. Preserve third-party notices and real model/vendor identifiers.
4. Connect newest-first memory-fit model selection and cached lab logos to the existing workbench. Show metadata/download/loading progress without blocking editor startup.
5. Build and measure editor startup, large-file interaction, memory and agent-turn latency against the unmodified baseline. Test Windows first, then macOS/MLX and Linux. Electron 44.7.0 is current at inspection time; upgrade from 43.1.1 only with native-module and behavior verification.

Electron subprocess integration must respect the packaged binary's fuses. `ELECTRON_RUN_AS_NODE` requires its fuse; utility processes are an alternative for the final desktop bundle. The current bridge is tested under Node, and desktop-runtime execution remains to be verified. [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
