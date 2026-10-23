import {
  showModel
} from "./chunk-MO7YLYB6.js";
import {
  ollamaRoot
} from "./chunk-RKXQ4ULC.js";

// vendor/notch-cli/src/providers/ollama-model-template.ts
import { createHash } from "crypto";
function ollamaTemplateSource(info) {
  const architecture = info.modelInfo["general.architecture"];
  if (architecture === "qwen35") return "qwen3.5:4b";
  if (architecture === "gemma4") return "gemma4:e2b";
  if (architecture === "qwen3moe" && info.template?.includes("<function=")) return "qwen3-coder:30b";
  if (architecture === "glm4moelite" && info.template?.includes("<arg_key>")) return "glm-4.7-flash:latest";
  return void 0;
}
async function blob(root, digest, signal) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Official model manifest has an invalid template digest.");
  const response = await fetch(`${root}/blobs/${digest}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15e3)]) : AbortSignal.timeout(15e3) });
  if (!response.ok) throw new Error(`Could not obtain official model metadata (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 256 * 1024 || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) throw new Error("Official model template checksum failed.");
  return bytes.toString("utf8");
}
async function officialOllamaTemplate(base, signal) {
  const match = /^([a-z0-9._-]+):([a-z0-9._-]+)$/.exec(base);
  if (!match) throw new Error("Invalid official template model reference.");
  const root = `https://registry.ollama.ai/v2/library/${match[1]}`;
  const response = await fetch(`${root}/manifests/${match[2]}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15e3)]) : AbortSignal.timeout(15e3) });
  if (!response.ok) throw new Error(`Cannot read the official ${base} template (HTTP ${response.status}).`);
  const manifest = await response.json();
  const layer = manifest.layers.find((item) => item.mediaType === "application/vnd.ollama.image.template");
  const config = JSON.parse(await blob(root, manifest.config.digest, signal));
  const template = layer ? await blob(root, layer.digest, signal) : void 0;
  const parameterLayer = manifest.layers.find((item) => item.mediaType === "application/vnd.ollama.image.params");
  const parameters = parameterLayer ? JSON.parse(await blob(root, parameterLayer.digest, signal)) : void 0;
  if (parameters !== void 0 && (!parameters || typeof parameters !== "object" || Array.isArray(parameters))) throw new Error("Official model parameters must be an object.");
  if (parameters) {
    for (const name of Object.keys(parameters)) if (!["temperature", "top_k", "top_p", "min_p", "repeat_penalty", "repeat_last_n", "presence_penalty", "frequency_penalty", "stop"].includes(name)) delete parameters[name];
  }
  if ((!config.renderer || !config.parser) && !template?.includes(".Tools")) throw new Error(`${base} has no verifiable tool-capable template.`);
  return { template, renderer: config.renderer, parser: config.parser, requires: config.requires, ...parameters && Object.keys(parameters).length ? { parameters } : {} };
}
async function createToolReadyAlias(source, setup, host, signal) {
  const hash = createHash("sha256").update(source + JSON.stringify(setup)).digest("hex").slice(0, 12);
  const model = `notch-hf-${hash}`;
  try {
    if ((await showModel(model, host)).capabilities?.includes("tools")) return model;
  } catch {
  }
  const response = await fetch(`${ollamaRoot(host)}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12e4)]) : AbortSignal.timeout(12e4),
    body: JSON.stringify({ model, from: source, ...setup, stream: false })
  });
  const body = await response.json();
  if (!response.ok || body.error || body.status !== "success") throw new Error(`Could not prepare tool calling: ${body.error || response.status}.`);
  if (!(await showModel(model, host)).capabilities?.includes("tools")) throw new Error("The prepared alias still does not advertise tools; current selection is unchanged.");
  return model;
}
export {
  createToolReadyAlias,
  officialOllamaTemplate,
  ollamaTemplateSource
};
