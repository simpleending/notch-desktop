import {
  checkOllamaTools,
  downloadMlx,
  ensureOllama,
  startMlx,
  stopMlx,
  unloadOllama
} from "./chunk-R2LF7GJS.js";
import {
  GiB,
  LOCAL_MODEL_CATALOG,
  detectLocalHardware,
  inspectHubModel,
  modelFit
} from "./chunk-B72JEX4V.js";
import "./chunk-M6FOGWEU.js";
import {
  formatBytes,
  listModels,
  pullModel
} from "./chunk-MO7YLYB6.js";
import {
  ollamaChatUrl,
  ollamaRoot
} from "./chunk-RKXQ4ULC.js";
import "./chunk-SWZ3JTKY.js";

// vendor/notch-cli/src/commands/local-models.ts
import { Command } from "commander";
import { createInterface } from "readline/promises";
async function runLocalModelsCli(argv, options = {}) {
  const command = new Command("notch models").description("Choose, download and run a Hugging Face model sized for this computer").argument("[action]", "recommend, install, status, or unload", process.stdin.isTTY ? "install" : "recommend").option("--runner <id>", "ollama or mlx (Apple Silicon)").option("--model <repo>", "Public Hugging Face owner/model repository").option("--host <url>", "Local Ollama endpoint").option("--cwd <dir>", "Project directory", options.cwd || process.cwd()).option("-y, --yes", "Download the explicit model and required runtime without another prompt").option("--no-launch", "Install and validate only; release model memory afterward").option("--json", "Machine-readable recommendations").parse(argv, { from: "user" });
  const flags = command.opts();
  const action = command.args[0];
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error("Cancelled by user"));
  process.once("SIGINT", cancel);
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const ask = options.ask || (async (question) => {
    if (!process.stdin.isTTY) throw new Error("Use --model owner/repo --runner ollama --yes for non-interactive installation.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once("SIGINT", cancel);
    try {
      return (await rl.question(question, { signal })).trim();
    } finally {
      rl.close();
    }
  });
  let selected;
  let loaded = false;
  let leaveLoaded = false;
  let host = ollamaRoot(flags.host);
  try {
    if (!["recommend", "install", "status", "unload"].includes(action)) throw new Error("Choose recommend, install, status, or unload.");
    if (flags.json && !["recommend", "status"].includes(action)) throw new Error("--json is supported for recommend and status.");
    if (action === "unload") {
      const { loadConfig } = await import("./config-U5ZRGBVH.js");
      const { parseByokRef, isByokRef } = await import("./byok-RCJXHY7M.js");
      const { models } = await loadConfig({ projectRoot: flags.cwd });
      const current = models.chat;
      const ref = isByokRef(current.model) ? parseByokRef(current.model) : { provider: current.byokProvider, model: current.model };
      if (ref.provider === "mlx") {
        if (!await stopMlx()) throw new Error("MLX is owned by its Notch session. Use /models unload in that session, or quit it to release memory.");
        console.log("The MLX model owned by this Notch session is stopped.");
      } else if (ref.provider === "ollama") {
        await unloadOllama(ref.model, flags.host || current.baseUrl);
        console.log(`Unloaded ${ref.model}; downloaded files remain available.`);
      } else throw new Error("The active provider is not a local Ollama or MLX model.");
      return { code: 0 };
    }
    const hardware = await detectLocalHardware();
    let runner = flags.runner || (hardware.mlxSupported ? "mlx" : "ollama");
    if (!["ollama", "mlx"].includes(runner)) throw new Error("Choose ollama or mlx.");
    if (runner === "mlx" && !hardware.mlxSupported) throw new Error("MLX needs Apple Silicon (M1 or newer) and macOS 14+. Choose Ollama on this computer.");
    if (runner === "mlx" && flags.host) throw new Error("--host is for Ollama; Notch-managed MLX binds only to localhost.");
    if (action === "status") {
      console.log(JSON.stringify({ hardware, installedOllama: await listModels(host).catch(() => []) }, null, 2));
      return { code: 0 };
    }
    if (!flags.json) {
      console.log(`
Memory: ${((hardware.installedMemory || hardware.totalMemory) / GiB).toFixed(1)} GiB installed; ${(hardware.availableMemory / GiB).toFixed(1)} GiB available to the OS${hardware.availableVram ? `; ${(hardware.availableVram / GiB).toFixed(1)} GiB available dedicated GPU memory` : ""}.`);
      if (hardware.mlxSupported && action === "install" && !flags.runner) {
        console.log("  1. MLX - Apple Silicon / unified memory (requires native Python 3.11+)\n  2. Ollama - GGUF models");
        const answer = await ask("Runner number or name (1): ");
        runner = !answer || answer === "1" || answer === "mlx" ? "mlx" : answer === "2" || answer === "ollama" ? "ollama" : (() => {
          throw new Error("Choose 1 (mlx) or 2 (ollama).");
        })();
      }
    }
    if (flags.model) selected = await inspectHubModel(flags.model, runner, signal);
    else {
      const results = await Promise.allSettled(LOCAL_MODEL_CATALOG.map((row) => inspectHubModel(runner === "mlx" ? row.mlx : row.gguf, runner, signal)));
      const candidates = [];
      results.forEach((result2, i) => {
        if (result2.status === "fulfilled") candidates.push(result2.value);
        else if (!flags.json) console.log(`Could not inspect ${LOCAL_MODEL_CATALOG[i].label}: ${result2.reason.message}`);
      });
      candidates.sort((a, b) => (Date.parse(b.createdAt || "") || 0) - (Date.parse(a.createdAt || "") || 0));
      if (!candidates.length) throw new Error("No model metadata is available. Retry when Hugging Face is reachable.");
      if (flags.json) {
        console.log(JSON.stringify({ hardware, runner, models: candidates.map((model) => ({ ...model, ...modelFit(model, hardware) })) }, null, 2));
        return { code: 0 };
      }
      console.log(`
${runner === "mlx" ? "MLX 4-bit" : "GGUF Q4_K_M"} models from Hugging Face. Estimates include context/loading headroom:
`);
      candidates.forEach((model, i) => {
        const fit2 = modelFit(model, hardware);
        console.log(`  ${i + 1}. ${model.repo} - ${formatBytes(model.bytes).trim()} download; ${(fit2.required / GiB).toFixed(1)} GiB estimated memory - ${fit2.fits ? "fits current estimate" : "exceeds current estimate"}`);
      });
      if (action === "recommend") return { code: 0 };
      const recommended = candidates.findIndex((model) => modelFit(model, hardware).fits);
      if (recommended < 0) throw new Error("None fits current available memory. Close other applications and retry; no model was downloaded.");
      const answer = await ask(`Model number (${recommended + 1}), or q to cancel: `);
      if (answer.toLowerCase() === "q") return { code: 0 };
      selected = candidates[Number(answer || String(recommended + 1)) - 1];
      if (!selected) throw new Error("Choose one of the listed model numbers.");
    }
    const fit = modelFit(selected, hardware);
    if (!fit.fits && !options.downloadOnly) throw new Error("This model exceeds the current memory estimate. Close applications or choose a smaller model; no download started.");
    if (action === "recommend") {
      console.log(JSON.stringify({ hardware, ...selected, ...fit }, null, 2));
      return { code: 0 };
    }
    if (flags.model && !flags.yes && !/^(y|yes)$/i.test(await ask(`Download ${selected.repo} (${formatBytes(selected.bytes).trim()}) and use it for this project? [y/N] `))) return { code: 0 };
    console.log(`
Installing ${selected.repo}; model license: ${selected.license || "see model card"}.`);
    if (runner === "ollama") {
      if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(host).hostname)) throw new Error("Hardware recommendations apply to this computer. Choose a local Ollama endpoint.");
      host = await ensureOllama(host, signal);
      let template;
      if (selected.ollamaBase) {
        const { officialOllamaTemplate } = await import("./ollama-model-template-L5TE3W6X.js");
        template = await officialOllamaTemplate(selected.ollamaBase, signal);
        if (template.requires) {
          const { daemonVersion, versionAtLeast, managedOllama } = await import("./ollama-runtime-QXBKLJ6I.js");
          const version = await daemonVersion(host);
          if (!version || !versionAtLeast(version, template.requires)) host = await managedOllama(template.requires, signal);
        }
      }
      let previous = "";
      const installed = await listModels(host);
      if (installed.some((row) => row.name.toLowerCase() === selected.model.toLowerCase())) console.log("Model files are already cached; reusing the download.");
      else for await (const event of pullModel(selected.model, host, { signal })) {
        const progress = event.kind === "progress" ? `${Math.floor(event.percent / 10) * 10}% - ${event.message}` : event.kind === "status" ? event.message : "Download complete";
        if (progress !== previous) {
          console.log(progress);
          previous = progress;
        }
      }
      if (template) {
        const { createToolReadyAlias } = await import("./ollama-model-template-L5TE3W6X.js");
        selected = { ...selected, model: await createToolReadyAlias(selected.model, template, host, signal) };
      }
      await checkOllamaTools(selected.model, host);
    } else await downloadMlx(selected.repo, signal);
    if (options.downloadOnly) {
      signal.throwIfAborted();
      console.log(`Downloaded: ${runner}/${selected.model}. Model files are ready; memory and context are checked when loading.`);
      return { code: 0 };
    }
    if (!modelFit(selected, await detectLocalHardware()).fits) throw new Error("Available memory fell during the download. Close other applications and retry; the download is retained.");
    const baseUrl = runner === "mlx" ? await startMlx(selected.repo, signal) : ollamaChatUrl(host);
    loaded = true;
    const endpoint = runner === "mlx" ? `${baseUrl}/chat/completions` : `${host}/api/chat`;
    const request = runner === "mlx" ? { model: selected.model, stream: false, max_tokens: 128, temperature: 0, chat_template_kwargs: { enable_thinking: false } } : { model: selected.model, stream: false, think: false, options: { num_ctx: fit.contextLength, num_batch: fit.batchSize, num_predict: 128, temperature: 0 }, keep_alive: "5m" };
    console.log("Loading model and checking a harmless tool call...");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(18e4)]),
      body: JSON.stringify({
        ...request,
        messages: [{ role: "user", content: "Call notch_setup_probe with ok=true. Do not answer with text." }],
        tools: [{ type: "function", function: { name: "notch_setup_probe", description: "A harmless setup check; no action is executed.", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } }]
      })
    });
    if (!response.ok) throw new Error(`Model load/probe failed (HTTP ${response.status}): ${(await response.text()).slice(0, 400)}`);
    const body = await response.json();
    const calls = runner === "mlx" ? body.choices?.[0]?.message?.tool_calls : body.message?.tool_calls;
    const call = calls?.find((item) => item.function?.name === "notch_setup_probe");
    const args = typeof call?.function?.arguments === "string" ? JSON.parse(call.function.arguments) : call?.function?.arguments;
    if (args?.ok !== true) throw new Error("The model did not produce a valid tool call. Download is retained, but your previous model selection is unchanged.");
    signal.throwIfAborted();
    const selection = { provider: runner, model: selected.model, sourceRepo: selected.repo, baseUrl, contextWindow: fit.contextLength, ...runner === "ollama" ? { ollamaBatch: fit.batchSize } : {} };
    const { persistConfigPatch } = await import("./config-U5ZRGBVH.js");
    await persistConfigPatch(flags.cwd, { provider: selection, byok: void 0, model: void 0, baseUrl: void 0, apiKey: void 0 });
    console.log(`Ready: ${runner}/${selected.model}. Saved for ${flags.cwd}.`);
    leaveLoaded = flags.launch !== false && (options.embedded || !!process.stdin.isTTY);
    return { code: 0, selection, ...leaveLoaded && !options.embedded ? { launch: flags.cwd } : {} };
  } catch (error) {
    console.error(`Local model setup failed: ${error.message}`);
    return { code: 1 };
  } finally {
    process.removeListener("SIGINT", cancel);
    if (loaded && !leaveLoaded && selected) {
      if (selected.runner === "mlx") await stopMlx();
      else await unloadOllama(selected.model, host).catch(() => {
      });
    }
  }
}

// vendor/notch-cli/src/desktop-model-download.ts
var result = await runLocalModelsCli(process.argv.slice(2), { downloadOnly: true });
process.exitCode = result.code;
