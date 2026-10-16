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
- **Keep tasks separate.** Local generations take turns across notch chats and CLI processes; OpenRouter can run in parallel. Waiting tasks remain cancellable. File tools refuse stale edits, and undo waits for file operations. For parallel tasks using arbitrary terminal commands or plugins, use separate Git worktrees: those commands can change files they have not read.
- **Pick up where you left off.** Reopen saved conversations and keep working as longer chats are summarized.
- **Review and undo changes.** Restore a selected agent turn and its later tracked file changes, even after restarting. Undo previews protect later manual edits and never change files themselves.
- **Use the memory you have.** notch adjusts conversation size to your available memory. You can choose a limit yourself when you need more room.
- **Work your way.** Choose dark or light mode, adjust the text, and search your project’s files.

## Start a project

1. Download the Windows installer from the [latest release](https://github.com/simpleending/notch-desktop/releases/latest), then open **notch** from your Start menu.
2. Open a project folder.
3. Choose a local model, download one from Hugging Face, or connect your OpenRouter API key. In Hugging Face, click a model's download arrow, review its size and memory requirements, then choose **Download model**. notch installs the required runtime and model files and checks coding tools; progress and errors appear in the picker. When ready, choose **Show installed models** and select it. The model loads when you send a message.
4. Try “Explain how this project works,” then review any changes before approving them.

Local models need enough memory to run. Cloud models use your provider’s pricing and receive the project content included in your request. Your API keys are kept out of saved conversations.

Undo covers the built-in file write, edit and patch tools. Terminal commands and external tools can make changes outside that history, so keep projects in version control. Checkpoints created before this release were not saved and cannot be recovered retrospectively. The Windows installer is unsigned; see the [download notes](docs/windows-preview.md).

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
