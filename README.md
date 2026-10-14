<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/notch-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/notch-wordmark-light.svg">
  <img src="assets/notch-wordmark-light.svg" alt="notch" width="252" height="75">
</picture>

# notch desktop

A free desktop coding workbench that puts open models on your computer first. Work on your project, ask for help with code, and choose the model you want to use. Connect OpenRouter when you want a cloud model.

[Website](https://freesyntax.dev) · [Report an issue](https://github.com/simpleending/notch-desktop/issues) · [License](LICENSE)

## What you can do

- **Code with local models.** Use an installed model or browse Hugging Face for a download, with size and memory estimates to help you choose. Public guided downloads do not require a Hugging Face account.
- **Choose your model.** Switch between Installed, Hugging Face and OpenRouter in the model picker. Search and arrow-key navigation make it easy to find a model.
- **Connect cloud models when you need them.** Add your own OpenRouter API key and see available models and token prices. Cloud usage is billed by your provider; a failed local request does not silently switch to the cloud.
- **Work through coding tasks.** Ask the assistant to inspect project files, suggest changes and run commands. In approval mode, review file writes and commands before they run, and cancel a task from the conversation.
- **Keep working across sessions.** Resume saved conversations. Longer conversations are summarized to make room for new work, with original transcripts archived locally.
- **Make the workspace comfortable.** Choose a dark or light appearance, adjust fonts and text size, and search your project's filenames.

## Getting started

The desktop is currently a development preview. There is no public desktop installer yet. Windows is the tested platform; Apple Silicon MLX support is beta and still needs hardware verification. Follow this repository for desktop releases, or see the [release progress](docs/release-readiness.md).

Once you have a development build:

1. Open notch and choose your appearance.
2. Open a project folder.
3. Open the model picker. Select an installed local model, browse Hugging Face to download one, or add your OpenRouter key and select a cloud model.
4. Start with a small request, such as “Explain how this project works.” Review any requested file changes or commands before approving them.

Local models need enough memory for both the model and its conversation. Auto context rechecks free RAM/VRAM before each turn and chooses up to 128K using the model's limits and estimated KV-cache size. It prefers a context that fits on the GPU; Apple Silicon uses its unified memory. Smaller limits, including 8K or a 4K fallback, remain available. You can select a manual limit, or enable extended context to reveal 256K when the model and memory support it. A manual preference survives temporary memory pressure: notch reduces the active limit when necessary and restores the preference when it fits again. These estimates cannot guarantee a model will fit.

Want to use notch from your terminal today? The [notch CLI](https://www.npmjs.com/package/@freesyntax/notch-cli) is available separately and requires Node.js 22.19 or newer:

```sh
npm install -g @freesyntax/notch-cli
notch
```

## Your models and keys

You choose whether to use a local or cloud model. Choosing a cloud model sends the request and its included project context to that provider. Local model downloads need an internet connection, and individual models have their own licenses.

Desktop API keys use your operating system's encrypted storage. If secure storage is unavailable, keys last only for the current session. Keys are not included in saved conversations.

## Help improve notch

If something goes wrong, [open an issue](https://github.com/simpleending/notch-desktop/issues) with your operating system, model name, steps to reproduce and the error you saw. Remove API keys and private project content before sharing logs.

To build from source or contribute, see the [development guide](docs/development.md). It includes build requirements, verification commands and implementation notes. The [release checklist](docs/release-readiness.md) tracks the work still needed for a desktop release, including safe undo, extensions, packaging and broader platform checks.

## License

Copyright 2026 Driftrail (driftrail.com).

The original code in this repository is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). Vendored code, dependencies, fonts and provider marks retain their respective licenses and notices, including the [vendored CLI's Apache 2.0 license](vendor/notch-cli/LICENSE), [fff's MIT license](assets/notices/fff-LICENSE.txt), [Manrope's OFL license](assets/fonts/Manrope-OFL.txt) and [provider mark notices](assets/notices/provider-logos.md). Any redistributed upstream application components remain subject to their own terms.
