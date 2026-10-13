# Notch Desktop

Public development repository for a free desktop coding workbench, with local open models first and optional OpenRouter, OpenAI and Anthropic API keys.

The desktop port has started. This repository currently provides tested upstream inspection, the published Notch CLI model-management bridge, and cached lab/publisher logos. The full editor/session integration is still being implemented; this is not a finished IDE release.

```sh
npm ci --ignore-scripts
npm test
npm run models
npm run inspect:upstream -- --installation "/path/to/installed/app" --out analysis.json
```

Node.js 22.19+ is required. Notch CLI 0.7.0 is pinned so the desktop uses its tested model sizing, Hugging Face downloads, isolated Ollama runtime, optional Apple Silicon MLX and memory-release behavior. API keys stay with the CLI credential store. An editor renderer will receive explicit IPC capabilities rather than arbitrary Node or shell access.

The user confirmed written modification and redistribution rights for the installed Qoder application. Read-only inspection identified its Electron workbench and agent SDK boundary. See [the upstream analysis](docs/upstream-analysis.md). Generated upstream archives, extracted application files, credentials and machine-specific analysis are excluded from Git. Third-party notices must remain with any redistributed components.

The port replaces application branding and provider routing. Actual open model names and repository IDs remain accurate, including Qwen models when selected from the model dropdown. A repository creation date is used for newest-first ordering; it does not establish model capability or quality.

MLX is beta pending Apple hardware verification. No Qoder performance-parity claim or production desktop build is made yet.
