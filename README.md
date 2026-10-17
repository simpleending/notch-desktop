<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/notch-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/notch-wordmark-light.svg">
  <img src="assets/notch-wordmark-light.svg" alt="notch" width="252" height="75">
</picture>

# Your code. Your models.

notch by [freesyntax.dev](https://freesyntax.dev) is a free coding workspace for working with AI on your own terms. Run open models on your computer, or connect OpenRouter with your own API key.

**[Download for Windows](https://github.com/simpleending/notch-desktop/releases/latest)** · [Website](https://freesyntax.dev) · [Get the CLI](https://www.npmjs.com/package/@freesyntax/notch-cli)

The Windows release supports x64 PCs running Windows 10 or 11. Check the release notes for current limitations. macOS and Linux downloads are not available yet.

Windows releases check GitHub for new stable versions after opening, download updates in the background and install after a normal quit. They do not close your work to apply an update, and installation is deferred during Windows shutdown. In **Settings → Appearance → Updates**, turn automatic updates off, check manually or choose **Quit and install** when an update is ready. Preview builds and separate test profiles do not automatically install updates.

## Make yourself at home

- **Bring your own model.** Choose an installed model or search Hugging Face by name, including Gemma and DeepSeek, with newest results first and more pages available. Public guided downloads need no account. Downloads use compatible Q4_K_M GGUF or MLX weights; memory fit and tool support are checked before use.
- **Browse before connecting.** Search OpenRouter's chat and coding catalog without a key. Connect your own key to use models with coding tools; chat-only models are shown with their limitation.
- **Stay in control.** Review file changes and commands before approving them, or choose the access level that suits your project.
- **Use your project folder.** Tasks edit your open folder by default, and writable tasks take turns across notch chats and CLI processes. In **Settings → Appearance → Task workspace**, choose **Isolated worktrees** if you want parallel OpenRouter tasks with private project copies. Safe isolated changes return automatically; conflicts stay separate. Waiting tasks remain cancellable.
- **Pick up where you left off.** Reopen saved conversations and keep working as longer chats are summarized.
- **Review and undo changes.** Restore a selected agent turn and its later tracked file changes, even after restarting. Undo previews protect later manual edits and never change files themselves.
- **Use the memory you have.** notch adjusts conversation size to your available memory. You can choose a limit yourself when you need more room.
- **Work your way.** Choose dark or light mode, adjust the text, and search your project’s files.
- **Keep knowledge and sites locally.** Knowledge Center saves searchable text notes and imports Markdown, text, CSV and JSON files. Sites saves HTML drafts with an offline static preview and HTML export. Both work without an account, keep drafts across restarts, and store their data in your device’s notch profile. Extensions opens the local extension manager; Workspace Index describes the automatic local file search.

## Colibri (experimental)

Colibri selects its tokenizer and supported chat template from the selected checkpoint and model family. Managed launches isolate tokenizer, template and stop-token settings from other models.

New Colibri setups use 16K context to leave room for coding tools and conversation. Loading still requires enough current free memory; existing explicit context choices are preserved.

Open the model picker and choose **Colibri → Set up Colibri** to install the optional local engine. Setup needs 64-bit Python 3.10+. The model list shows free RAM, a safety reserve and each model's download size and memory precheck. **Refresh memory** after closing applications. Models that fail the precheck cannot be downloaded through setup. Passing this preliminary estimate does not verify that the model will run at 16K context: exact checkpoint/context checks run after download and before loading. Select **Download and validate** to continue. Downloads resume if interrupted; coding tools are checked before the model becomes selectable under **Installed**.

Use **Colibri → Unload model** to release RAM while keeping downloaded files. Unload before changing its context limit. Colibri shares the local task queue and keeps one configured model at a time. Disk-streamed models can have long delays before their first token; this experimental option does not replace Ollama. Engine and model downloads are separate from the IDE installer, and model licenses apply separately.

## Web research

Ask notch to search current documentation and cite its sources. In **Settings → Appearance → Web research**, choose **DuckDuckGo (default, no key)** or optional **Tavily (API key)**, select your browser, or turn off web access. DuckDuckGo search works immediately without a browser install. Save a [Tavily key](https://app.tavily.com/) only if you choose Tavily. Search keys use system encryption when available; otherwise they last only for the current session. Environment variable `TAVILY_API_KEY` overrides a saved Tavily key but does not change your selected provider. No notch account is required.

Known URLs can be read without a search key. JavaScript pages use an installed Chrome or Edge, or optional Chromium installed from the same settings. Each browser operation uses a fresh private session and closes afterward; browser actions follow your approval mode and are unavailable in read-only mode. Source links in the conversation open when clicked. Search queries and page requests go to external services even when your model is local.

See [web research details](docs/web-research.md) for setup and browser limitations.

## Start a project

1. Download the Windows installer from the [latest release](https://github.com/simpleending/notch-desktop/releases/latest), then open **notch** from your Start menu.
2. Open a project folder.
3. Choose a local model, download one from Hugging Face, or connect your OpenRouter API key. In Hugging Face, click a model's download arrow, review its size and memory requirements, then choose **Download model**. notch installs the required runtime and model files and checks coding tools; progress and errors appear in the picker. When ready, choose **Show installed models** and select it. The model loads when you send a message.
4. Try “Explain how this project works,” then review any changes before approving them.

Local models need enough memory to run. Cloud models use your provider’s pricing and receive the project content included in your request. Your API keys are kept out of saved conversations.

On launch, notch starts its previously installed Ollama runtime so downloaded models remain available after a reboot. Startup does not download a missing runtime; choose a model download to install one.

No notch account or sign-in is required. Knowledge Center and Sites use local storage in place of the inherited hosted services. Hosted knowledge processing and site publishing are not included; exported sites can be opened locally or deployed with a host of your choice. Using a note in a new task sends that note to the model you selected.

Voice input, recording notes, and Live Voice use local speech processing. Open **Settings → Voice → Install speech engine** for a one-time download of about 157 MB. Whisper transcribes audio on your PC; Windows' installed speech voice reads replies. Live Voice sends spoken requests through the task's selected model and tool permissions. Choose a local model for offline inference; an optional cloud model receives the transcript, not microphone audio.

SSH uses your system OpenSSH client and SSH configuration, keys, and normal host authentication. Add a host under **Settings → Connections**, then open a remote project. The model and task history stay on this device; file operations, Git, and commands run on the POSIX remote host. No Notch account or proprietary remote runtime is needed. Remote tasks share their remote workspace; the local worktree-isolation preference does not create remote worktrees.

The local edition retires the account marketplace, hosted collaboration/remote control, and proprietary managed SSH runtime. Local automations, model management, voice, SSH, and custom MCP configuration remain available. See the [local service audit](docs/local-only-audit.md) for setup, limits, and verification commands.

Undo covers built-in file edits and changes returned from an isolated OpenRouter task, including terminal-created files. Commands in the shared project folder and external tools can still make changes outside that history. Keep projects in version control. The Windows installer is unsigned; see the [download notes](docs/windows-preview.md).

Optional worktree isolation needs Git installed. Your branch, staged edits and untracked files stay intact; folders without Git use a private database. Shared MCP tools, plugins and command hooks are disabled for isolated tasks because they can hold paths to a shared project. Dependencies are private to each task. Interrupted chats retain their files; completed copies are cleaned up. Symbolic-link/submodule inputs and binary outputs that Undo cannot record require review. This separation is not an OS sandbox: arbitrary commands with explicit external paths can still access your account’s files.

Prefer the terminal? Install the [notch CLI](https://www.npmjs.com/package/@freesyntax/notch-cli) with Node.js 22.19 or newer:

```sh
npm install -g @freesyntax/notch-cli
notch
```

## Questions or feedback?

[Open an issue](https://github.com/simpleending/notch-desktop/issues) with what happened, your model, and your operating system. Keep API keys and private project content out of anything you share.

Want to contribute? See the [development guide](docs/development.md). The IDE’s [wordmark](assets/notch-wordmark.svg) and its [dark](assets/notch-wordmark-dark.svg) and [light](assets/notch-wordmark-light.svg) variants are included in this repository.

## Free and open source

notch’s original code is licensed under [AGPL v3](LICENSE). Dependencies and bundled components retain their [own licenses and notices](docs/third-party-notices.md).

Copyright 2026 Driftrail.

## Contributing

Pull requests are welcome. Fork the repository and send your changes to `main`; no collaborator invitation is needed. See [how to contribute](CONTRIBUTING.md) for setup, checks, and the pull-request process.
