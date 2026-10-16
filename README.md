<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/notch-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/notch-wordmark-light.svg">
  <img src="assets/notch-wordmark-light.svg" alt="notch" width="252" height="75">
</picture>

# Your code. Your models.

notch by [freesyntax.dev](https://freesyntax.dev) is a free coding workspace for working with AI on your own terms. Run open models on your computer, or connect OpenRouter with your own API key.

**[Download for Windows](https://github.com/simpleending/notch-desktop/releases/latest)** · [Website](https://freesyntax.dev) · [Get the CLI](https://www.npmjs.com/package/@freesyntax/notch-cli)

The Windows release supports x64 PCs running Windows 10 or 11. Check the release notes for current limitations. macOS and Linux downloads are not available yet.

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

## Web research

Ask notch to search current documentation and cite its sources. In **Settings → Appearance → Web research**, add a [Tavily API key](https://app.tavily.com/) for search, select your browser, or turn off web access. Search keys use system encryption when available; otherwise they last only for the current session. Environment variable `TAVILY_API_KEY` takes precedence. No notch account is required.

Known URLs can be read without a search key. JavaScript pages use an installed Chrome or Edge, or optional Chromium installed from the same settings. Each browser operation uses a fresh private session and closes afterward; browser actions follow your approval mode and are unavailable in read-only mode. Source links in the conversation open when clicked. Search queries and page requests go to external services even when your model is local.

See [web research details](docs/web-research.md) for setup and browser limitations.

## Start a project

1. Download the Windows installer from the [latest release](https://github.com/simpleending/notch-desktop/releases/latest), then open **notch** from your Start menu.
2. Open a project folder.
3. Choose a local model, download one from Hugging Face, or connect your OpenRouter API key. In Hugging Face, click a model's download arrow, review its size and memory requirements, then choose **Download model**. notch installs the required runtime and model files and checks coding tools; progress and errors appear in the picker. When ready, choose **Show installed models** and select it. The model loads when you send a message.
4. Try “Explain how this project works,” then review any changes before approving them.

Local models need enough memory to run. Cloud models use your provider’s pricing and receive the project content included in your request. Your API keys are kept out of saved conversations.

No notch account or sign-in is required. Knowledge Center and Sites use local storage in place of the inherited hosted services. Hosted knowledge processing and site publishing are not included; exported sites can be opened locally or deployed with a host of your choice. Using a note in a new task sends that note to the model you selected.

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
