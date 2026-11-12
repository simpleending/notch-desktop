# Notch 0.1.49 integration changes

The model picker retains fine-tune identity rather than substituting base-model metadata. Installed aliases remain visible, including Heretic. Runtime replacement preserves model folders; a Colibri model whose validation receipt predates the engine remains listed with a validation action.

## Connected desktop features

- Each desktop turn connects its enabled workbench SDK MCP servers and approved project `.notch.json` servers. Connections use the maintained MCP protocol client, including standard stdio, Streamable HTTP and legacy SSE transports. Tools, credentials and connections are scoped to that turn and closed on completion or cancellation. Read-only mode still denies arbitrary external tools. SSH sessions retain their existing remote tool boundary.
- Knowledge Center's existing "use in chat" action remains. The default desktop tool catalog now also includes `Knowledge`, a read-only search/read tool backed by the same local SQLite library. Results have document IDs, titles and bounded text. Notes are reference data, not agent instructions.
- Shared/isolated workspace selection applies to local model providers as well as OpenRouter. Isolated file tools use the existing Git worktree and conflict-aware delivery path; this is workspace separation, not an OS sandbox.
- Automation completion notifications navigate to the corresponding chat. Automation readiness errors preserve the model's actual reason instead of converting all failures into a transient unavailable-model message.
- Opt-in background mode keeps the primary window hidden in the tray, where schedules continue running. Explicit Quit or OS shutdown still stops Notch. This is not an OS service and does not run while the machine is off.
- Saved automations can watch up to ten explicit local file paths. Changes are grouped, limited to one event run per minute, and ignored during an active run to prevent self-triggering loops. These events use the existing manual-run queue and history. No public webhook listener is opened.

## Experimental engines

Colibri is pinned to 2.1.0 and Strata to release 0.2.13 / Control 0.1.59, using SHA-256 checked upstream archives. New archive sizes and control APIs were checked against the actual releases. Model storage and existing selections are retained. Manage models offers runtime setup and, for Colibri, validation of existing weights after an engine change.

Notch checks each official GitHub release feed at most once daily and exposes a manual check in each engine panel. Polling never downloads model weights, replaces a running engine, or executes an untested upstream release. Tested runtime pins advance with Notch releases. A newer untested release is reported as available upstream.

## Validation boundaries

The source suite covers standard and in-process MCP, real HTTP session headers, connection cleanup, local library retrieval, background-close behavior, file-trigger debounce and shutdown, real private Git checkouts for local provider identities, model discovery and existing automation regressions. Runtime checks use the actual upstream Colibri/Strata control and HTTP-server packages with tiny engine fixtures: launch, stop, switching, intentional startup failure and recovery, with process exit verification. Their real catalogs and Strata launch settings contract were also exercised.

These checks do not claim full-weight GPU performance or a visual desktop walkthrough. No model weights were downloaded for this release's verification.

The protocol client and glob/matching packages include current security fixes. The dependency scanner continues to identify legacy Zod 3 by version; its oversized-collection fix is locally backported and tested, including packaged copies, because the inherited workbench still needs its API.

## Tencent DSpine assessment

[DSpine](https://github.com/Tencent/DSpine) is speculative decoding: a small matching draft model proposes tokens for the target model to verify. Tencent publishes draft checkpoints for Qwen3-8B and Qwen3.8-27B. Its documented SGLang path requires CUDA; Apple Silicon has separate MLX support. These are not generic accelerators for arbitrary Qwen variants or fine-tunes.

For Notch's Windows AMD/Vulkan path and the user's 9B Heretic variant, there is no documented drop-in supported combination. A future optional SGLang adapter and model-specific benchmark is worth investigating on suitable hardware, but DSpine is not enabled in this release. Tencent's reported throughput gains are specific to its benchmark configurations, not a promise for local quantized models.

Sources: [Colibri 2.1.0](https://github.com/JustVugg/colibri/releases/tag/v2.1.0), [Strata 0.2.13](https://github.com/Niko1221/Strata/releases/tag/v0.2.13), [DSpine model card](https://huggingface.co/tencent/Qwen3.8-27B-DSpine-b16).
