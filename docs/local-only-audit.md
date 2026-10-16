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
| Voice | Dictation and recording notes use local Whisper. Live Voice transcribes a spoken turn, runs it through the selected task/model and existing permissions, then speaks the result with Windows' installed voice. No hosted speech connection or Notch token. |
| SSH | Existing native OpenSSH connections, host profiles, file browser, Git, terminal, and local-agent execution operate without a Notch account. The embedded model harness routes remote file and command tools through the SSH workspace provider. Undo history stays on this device and rejects external edits. All SSH targets use local-agent execution; the proprietary managed runtime downloader is not used. |
| Legacy SDK contributions | Marketplace discovery, pet, and proprietary security-scan contributions are not activated. This does not replace task permissions or add an independent security scanner. |
| Desktop updates | The inherited hosted updater and its background scheduler are disabled. Windows releases are downloaded from this project's GitHub Releases. |

Optional OpenRouter use, Hugging Face gated repositories, configured MCP servers, Tavily search, and requested web browsing may require their respective credentials or internet access. These are user-selected external services, not a Notch account or the retired application backend. Public Hugging Face downloads and DuckDuckGo search do not need a Notch account.

## Verification

`node --test tests/local-only.test.mjs` exercises the shared service boundaries, restored remote-control preferences, local capability flags, voice configuration, and complete removal of hosted controls/callbacks. Packaging refuses changed method signatures instead of silently producing a partial patch.

## Local voice and SSH setup

On Windows x64, **Settings → Voice → Install speech engine** downloads the official CPU build of [whisper.cpp v1.9.5](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5) from build `b5454` and the multilingual Whisper base model from a pinned Hugging Face revision. Both downloads are SHA-256 checked before installation in the profile's `local-voice` directory. Nothing is downloaded merely by opening the IDE. Setup can be cancelled. After setup, transcription works offline; OS microphone permission is still required. Recognition accuracy depends on the microphone, language, noise, and speech model. Audio processing uses temporary local files that are deleted afterward; recording notes intentionally retain their saved audio/transcript locally.

The official Windows speech binary needs Microsoft's Visual C++ x64 runtime. Setup checks that it can start before downloading the model; systems missing that prerequisite get the official Microsoft download link. The IDE does not change system security settings or install elevated prerequisites silently.

Speech output uses [Windows System.Speech](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer), with the voice/language installed on the device. Live Voice is turn based: speak, pause, wait for the task, then hear its reply. Microphone capture is ignored while that reply is being processed or played, to avoid feedback. Stop or mute playback using the existing controls. Cloud voice cloning, cloud polishing, and multi-party hosted voice discussions are not part of this local replacement. Hotwords and dictation history remain local. Optional OpenRouter models receive the transcribed task text when selected; choose a local model to keep model inference offline too.

SSH reads your normal OpenSSH host aliases and uses SSH key/password and host-key authentication. This authenticates to your own host, with no Notch login. The remote host needs a POSIX shell and the standard tools checked during connection; Linux and macOS hosts are supported by that transport. Local model inference and task/Undo history remain on the PC; remote project files and commands remain on the host. Remote text tools require UTF-8 files up to 5 MiB. SSH tasks serialize per remote workspace and use conditional writes, with the same task permissions as local tasks. Opaque shell changes can exceed explicit file-edit Undo history; keep remote projects under version control. Terminal PTY availability depends on the SSH host.

`node scripts/verify-local-voice.mjs /path/to/Notch.exe report.json /path/to/cached/local-voice` checks the packaged microphone/PCM/Whisper pipeline and task handoff with a real installed Qwen3.5 model and Windows TTS. Synthetic microphone input makes this repeatable; it does not measure your physical microphone or speakers. `node scripts/verify-local-ssh.mjs /path/to/Notch.exe report.json` uses an isolated strict-key SSH server and a disposable WSL Linux directory; its fixture needs Python Paramiko in `analysis/ssh-deps`. The app itself has no Python/Paramiko dependency.

Run `node scripts/verify-local-only.mjs /path/to/Notch.exe report.json` against the packaged Windows app. It uses a temporary profile, visits every settings page including plugin frames, opens the actual model manager, local automation creation/history, and extension tabs/Add dialog, then invokes retired IPC methods directly. It records renderer errors and main-process/Chromium HTTP requests without replacing service results. The existing local-feature and automation verifiers cover persistence and actual local execution separately.

Electron's [WebRequest API](https://www.electronjs.org/docs/latest/api/web-request) has one active listener per event, and [Node fetch uses a different HTTP stack](https://www.electronjs.org/docs/latest/api/session). The audit therefore observes both stacks and retires shared services rather than treating a Chromium URL filter as sufficient isolation. Static source inspection also covers inactive endpoints and bundled plugin contributions; this is not a proof that arbitrary third-party plugins never contact external services.

The English build also translates inherited hardcoded permission titles, folder-access warnings, loading states, native errors, and built-in instruction text at packaging time. It uses existing English catalog wording where available and a static reviewed map for missing native messages. Template placeholders keep their original order and expressions; serialized keys, regular expressions, migration SQL, script commands, and legacy content matching are preserved. Embedded scripts receive only exact, reviewed replacements for quoted diagnostics. No translation service runs in the installed application.

Chinese conversation text, user documents, filenames, model names, and downloaded third-party content remain unchanged. The renderer audit checks English catalogs for missing keys and Chinese fallback values separately from hardcoded components. Localized error handling recognizes the new English messages alongside legacy Chinese errors.
