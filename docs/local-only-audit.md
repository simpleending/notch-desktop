# Local edition service audit

The Windows local edition does not need a Notch account. Removing a login prompt alone is insufficient: inherited services can still require an access token or try to synchronize with a retired backend.

The build now applies `src/local-only-patch.mjs` to both the main process and renderer. The normal plugin catalog hashes the resulting local plugin manifests and files. Existing user databases, saved tasks, plugin folders, and credentials are preserved.

| Surface | Local edition behavior |
| --- | --- |
| Tasks, project files, search, review, Undo | Existing local harness and storage; no account exchange. |
| Knowledge Center and Sites | Local SQLite notes/HTML drafts, import, search, preview, export, and draft recovery. |
| Models settings | Reuses the composer model manager for installed models, Hugging Face downloads, optional provider keys, and context configuration. The inherited daemon-backed personal-model editor is retired. Selecting a model in settings inspects its context; task selection stays in the task composer. |
| Automations | Local scheduler, creation, run history, and execution remain. Remote tabs, hosted templates, cloud synchronization, and hosted commands are retired. |
| Extensions | Local installation/management remains. Account marketplace navigation, discovery contributions, recommendations, managed marketplace MCP profiles, and market installation requests are retired. User-configured MCP servers keep their own authentication. |
| Privacy and diagnostics | Local storage information replaces the account-backed data-sharing selector. Telemetry reporting, automatic crash upload, remote configuration synchronization, and legacy backend diagnostics are disabled. Manual proxy testing targets the public OpenRouter catalog instead of the retired service. |
| Hosted collaboration | Cloud issues, discussions, agent teams, squads, and phone/remote-control synchronization are unavailable. Local task history is retained. Persisted remote-control preferences cannot start a cloud connection. |
| Voice and managed SSH | Speech recognition, live voice, recording transcription, and SSH task execution are unavailable in this build. Their controls and shortcuts are removed or explain availability; direct service calls fail locally before microphone capture or runtime download. |
| Legacy SDK contributions | Marketplace discovery, pet, and proprietary security-scan contributions are not activated. This does not replace task permissions or add an independent security scanner. |
| Desktop updates | The inherited hosted updater and its background scheduler are disabled. Windows releases are downloaded from this project's GitHub Releases. |

Optional OpenRouter use, Hugging Face gated repositories, configured MCP servers, Tavily search, and requested web browsing may require their respective credentials or internet access. These are user-selected external services, not a Notch account or the retired application backend. Public Hugging Face downloads and DuckDuckGo search do not need a Notch account.

## Verification

`node --test tests/local-only.test.mjs` exercises the shared service boundaries, restored remote-control preferences, local capability flags, voice configuration, and complete removal of hosted controls/callbacks. Packaging refuses changed method signatures instead of silently producing a partial patch.

Run `node scripts/verify-local-only.mjs /path/to/Notch.exe report.json` against the packaged Windows app. It uses a temporary profile, visits every settings page including plugin frames, opens the actual model manager, local automation creation/history, and extension tabs/Add dialog, then invokes retired IPC methods directly. It records renderer errors and main-process/Chromium HTTP requests without replacing service results. The existing local-feature and automation verifiers cover persistence and actual local execution separately.

Electron's [WebRequest API](https://www.electronjs.org/docs/latest/api/web-request) has one active listener per event, and [Node fetch uses a different HTTP stack](https://www.electronjs.org/docs/latest/api/session). The audit therefore observes both stacks and retires shared services rather than treating a Chromium URL filter as sufficient isolation. Static source inspection also covers inactive endpoints and bundled plugin contributions; this is not a proof that arbitrary third-party plugins never contact external services.
