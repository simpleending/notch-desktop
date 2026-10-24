import {
  findByokProvider,
  isByokRef,
  listByokProviders,
  loadSyncedByokKeys,
  parseByokRef,
  resolveByokModel
} from "./chunk-76JNJZ2B.js";
import {
  listModels,
  showModel
} from "./chunk-MO7YLYB6.js";
import {
  ollamaChatUrl,
  ollamaRoot
} from "./chunk-RKXQ4ULC.js";
import {
  acquireLease
} from "./chunk-SWZ3JTKY.js";

// vendor/notch-cli/src/config.ts
import fs4 from "fs/promises";
import path4 from "path";

// vendor/notch-cli/src/providers/registry.ts
import { createOpenAI } from "@ai-sdk/openai";

// vendor/notch-cli/src/providers/pi-ai-adapter.ts
var PI_AI_PROVIDER_MAP = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  "google-vertex": "google-vertex",
  mistral: "mistral",
  bedrock: "amazon-bedrock",
  azure: "azure-openai-responses"
};
var UNSUPPORTED_BY_PI_AI = /* @__PURE__ */ new Set(["openrouter", "groq", "together"]);
function piAiMode() {
  const enabled = process.env.NOTCH_USE_PI_AI;
  if (!enabled || enabled === "0" || enabled.toLowerCase() === "false") return "off";
  const mode = (process.env.NOTCH_PI_AI_MODE ?? "shadow").toLowerCase();
  return mode === "swap" ? "swap" : "shadow";
}
function shouldRouteViaPiAi(config) {
  if (piAiMode() === "off") return false;
  const provider = extractProvider(config);
  if (!provider) return false;
  if (UNSUPPORTED_BY_PI_AI.has(provider)) return false;
  return provider in PI_AI_PROVIDER_MAP;
}
var PiAiNotInstalledError = class extends Error {
  constructor(originalError) {
    super(
      `NOTCH_USE_PI_AI is set but @earendil-works/pi-ai could not be loaded. Install with: pnpm --filter @freesyntax/notch-cli add @earendil-works/pi-ai. Original error: ${originalError instanceof Error ? originalError.message : String(originalError)}`
    );
    this.name = "PiAiNotInstalledError";
  }
};
async function resolveModelViaPiAi(config) {
  const { providerName, modelId } = extractProviderAndModel(config);
  const piAiProvider = PI_AI_PROVIDER_MAP[providerName];
  if (!piAiProvider) {
    throw new Error(
      `pi-ai does not support BYOK provider "${providerName}". Supported: ${Object.keys(PI_AI_PROVIDER_MAP).join(", ")}. Set NOTCH_USE_PI_AI=0 or use a different provider.`
    );
  }
  if (!modelId) {
    throw new Error(
      `pi-ai resolution requires a non-empty model id. Config: ${JSON.stringify({ byokProvider: config.byokProvider, model: config.model })}`
    );
  }
  const piAi = await loadPiAi();
  const model = piAi.getBuiltinModel(piAiProvider, modelId);
  if (!model) {
    throw new Error(
      `pi-ai has no registered model "${piAiProvider}/${modelId}". pi-ai only lists tool-calling-capable models; if your model is text-only, keep it on the AI SDK path (UNSUPPORTED_BY_PI_AI) or clear NOTCH_USE_PI_AI.`
    );
  }
  return { model, piAiProvider, modelId };
}
async function computePiAiCostUsd(config, usage) {
  try {
    const handle = await resolveModelViaPiAi(config);
    const piAi = await loadPiAi();
    const usageBucket = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    };
    piAi.calculateCost(handle.model, usageBucket);
    return usageBucket.cost.total;
  } catch {
    return null;
  }
}
var shadowContexts = /* @__PURE__ */ new WeakMap();
function registerShadowContext(model, context) {
  if (piAiMode() === "off") return;
  shadowContexts.set(model, context);
}
async function recordShadowUsage(model, usage, opts) {
  if (piAiMode() === "off") return;
  const ctx = shadowContexts.get(model);
  if (!ctx) return;
  const inputTokens = usage.promptTokens ?? 0;
  const outputTokens = usage.completionTokens ?? 0;
  const piAiCostUsd = await computePiAiCostUsd(ctx.config, {
    input: inputTokens,
    output: outputTokens
  });
  await recordShadowCost({
    requestId: opts?.requestId ?? `usage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    provider: ctx.provider,
    modelId: ctx.modelId,
    inputTokens,
    outputTokens,
    piAiCostUsd,
    stripeChargeUsd: opts?.stripeChargeUsd ?? null,
    timestamp: Date.now()
  });
}
async function recordShadowCost(event) {
  if (piAiMode() === "off") return;
  try {
    const { homedir } = await import("os");
    const { mkdir, appendFile } = await import("fs/promises");
    const { join } = await import("path");
    const dir = join(homedir(), ".notch");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "pi-ai-shadow.jsonl"), `${JSON.stringify(event)}
`, "utf8");
  } catch {
  }
}
var piAiModulePromise = null;
async function loadPiAi() {
  if (!piAiModulePromise) {
    piAiModulePromise = (async () => {
      try {
        const [catalog, mod] = await Promise.all([
          import("@earendil-works/pi-ai/providers/all"),
          import("@earendil-works/pi-ai")
        ]);
        return { getBuiltinModel: catalog.getBuiltinModel, calculateCost: mod.calculateCost };
      } catch (err) {
        piAiModulePromise = null;
        throw new PiAiNotInstalledError(err);
      }
    })();
  }
  return piAiModulePromise;
}
function extractProvider(config) {
  if (config.byokProvider) return config.byokProvider;
  if (typeof config.model === "string" && isByokRef(config.model)) {
    return parseByokRef(config.model).provider;
  }
  return void 0;
}
function extractProviderAndModel(config) {
  if (config.byokProvider) {
    return {
      providerName: config.byokProvider,
      modelId: typeof config.model === "string" ? config.model : ""
    };
  }
  if (typeof config.model === "string" && isByokRef(config.model)) {
    const { provider, model } = parseByokRef(config.model);
    return { providerName: provider, modelId: model };
  }
  throw new Error(
    "resolveModelViaPiAi called on a non-BYOK config. Notch-hosted Modal endpoints still use the AI SDK path."
  );
}

// vendor/notch-cli/src/providers/registry.ts
var MODEL_CATALOG = {};
function assertDirectEndpoint(value) {
  if (!value) return;
  const host = new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  if (host === "freesyntax.dev" || host.endsWith(".freesyntax.dev") || host.startsWith("acemagnifique--notch-serve-") && host.endsWith(".modal.run")) {
    throw new Error("This saved endpoint belongs to the retired hosted service. Choose a local model with notch models or configure your own provider with notch setup.");
  }
}
var MODEL_IDS = Object.keys(MODEL_CATALOG);
function isValidModel(id) {
  return id in MODEL_CATALOG;
}
function resolveModel(config) {
  assertDirectEndpoint(config.baseUrl ?? process.env.NOTCH_BASE_URL);
  if (config.byokProvider) {
    const resolved = resolveByokModel({
      provider: config.byokProvider,
      model: typeof config.model === "string" && config.model.length > 0 ? config.model : void 0,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      headers: { ...config.headers, ...config.byokHeaders },
      apiShape: config.byokApiShape,
      contextWindow: config.contextWindow,
      nativeContextWindow: config.nativeContextWindow,
      maxOutputTokens: config.maxOutputTokens,
      ollamaBatch: config.ollamaBatch,
      fallbacks: config.fallbacks
    });
    firePiAiShadowProbe(config, resolved.model);
    return resolved.model;
  }
  if (typeof config.model === "string" && isByokRef(config.model)) {
    const { provider, model } = parseByokRef(config.model);
    const resolved = resolveByokModel({
      provider,
      model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      headers: { ...config.headers, ...config.byokHeaders },
      apiShape: config.byokApiShape,
      contextWindow: config.contextWindow,
      nativeContextWindow: config.nativeContextWindow,
      maxOutputTokens: config.maxOutputTokens,
      ollamaBatch: config.ollamaBatch,
      fallbacks: config.fallbacks
    });
    firePiAiShadowProbe(config, resolved.model);
    return resolved.model;
  }
  const baseUrl = config.baseUrl ?? process.env.NOTCH_BASE_URL;
  if (!baseUrl) throw new Error("Hosted Notch models are retired. Run notch models for a local model or notch setup for your own provider.");
  return createOpenAI({ apiKey: config.apiKey ?? process.env.NOTCH_API_KEY ?? "not-needed", baseURL: baseUrl, headers: config.headers }).chat(config.model);
}
function firePiAiShadowProbe(config, resolvedModel) {
  if (piAiMode() === "off") return;
  if (!shouldRouteViaPiAi(config)) return;
  const provider = extractByokProvider(config);
  const modelId = typeof config.model === "string" ? config.model : "unknown";
  if (provider) {
    registerShadowContext(resolvedModel, {
      provider,
      modelId,
      config
    });
  }
  void (async () => {
    let handle = null;
    let error = null;
    try {
      handle = await resolveModelViaPiAi(config);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    await recordShadowCost({
      requestId: `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      provider: handle?.piAiProvider ?? provider ?? "unknown",
      modelId: handle?.modelId ?? modelId,
      inputTokens: 0,
      // real counts come from loop.ts via recordShadowUsage
      outputTokens: 0,
      piAiCostUsd: null,
      stripeChargeUsd: null,
      timestamp: Date.now(),
      ...error ? { error } : {}
    });
  })();
}
function extractByokProvider(config) {
  if (config.byokProvider) return config.byokProvider;
  if (typeof config.model === "string" && isByokRef(config.model)) {
    return parseByokRef(config.model).provider;
  }
  return void 0;
}

// vendor/notch-cli/src/providers/ollama-credentials.ts
import fs from "fs/promises";
import path from "path";
function notchConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "notch");
  const appdata = process.env.APPDATA;
  if (appdata && process.platform === "win32") return path.join(appdata, "notch");
  const home2 = process.env.HOME ?? process.env.USERPROFILE;
  if (!home2) {
    throw new Error("Cannot determine home directory for credential storage.");
  }
  return path.join(home2, ".config", "notch");
}
function ollamaCredsPath() {
  return path.join(notchConfigDir(), "ollama.json");
}
async function readOllamaCreds() {
  try {
    const raw = await fs.readFile(ollamaCredsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.apiKey !== "string" || typeof parsed.endpoint !== "string") return null;
    return {
      apiKey: parsed.apiKey,
      endpoint: parsed.endpoint,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now()
    };
  } catch {
    return null;
  }
}

// vendor/notch-cli/src/permissions/index.ts
import fs2 from "fs/promises";
import path2 from "path";
import os from "os";
import { minimatch } from "minimatch";

// vendor/notch-cli/src/permissions/handlers/bash-classifier.ts
var DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)/i,
  /\brm\s+-rf?\s+\//i,
  /\bsudo\s+rm\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\./i,
  /\bshred\b/i,
  /\bchmod\s+-R\s+/i,
  /\bchown\s+-R\s+/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  // fork bomb
  /\b>\s*\/dev\/sd[a-z]/i,
  /\bgit\s+push\s+(?:.*\s)?(?:-f|--force|--force-with-lease)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*[fd]/i,
  /\bgit\s+checkout\s+--\s+\./,
  /\bnpm\s+publish\b/i,
  /\byarn\s+publish\b/i,
  /\bpnpm\s+publish\b/i,
  /\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+rm)\b/i,
  /\bkubectl\s+delete\b/i,
  /\bterraform\s+destroy\b/i,
  /\bmv\s+\/\s+/i,
  /\bfind\s+.*\s-delete\b/i,
  /\bfind\s+.*-exec\s+rm\b/i,
  /\btruncate\s+-s\s+0/i,
  /\b(poweroff|shutdown|reboot|halt)\b/i,
  /\bkillall?\s+-9/i
];
var NETWORK_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bhttpie?\b/i,
  /\bnc\b/i,
  /\bnetcat\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\brsync\s+.*::?/i,
  /\bftp\b/i,
  /\bsftp\b/i,
  /\btelnet\b/i,
  /\bnmap\b/i,
  /\bping\b/i,
  /\bdig\b/i,
  /\bnslookup\b/i,
  /\bhost\s+[a-z0-9.-]+\.[a-z]+/i,
  /\bgit\s+(?:clone|fetch|pull|push)\b/i,
  /\bnpm\s+(?:install|i|update|audit|fund)\b/i,
  /\bpip\s+install\b/i,
  /\bapt(?:-get)?\s+(?:install|update|upgrade)\b/i,
  /\bbrew\s+(?:install|update|upgrade)\b/i,
  /\b(?:python|python3|node|bun)\s+-c\s+.*(?:urllib|requests|fetch|http)/i,
  /\bcurl.*\|\s*(?:sh|bash|zsh|fish)\b/i,
  // explicit "pipe to shell"
  /\bwget.*\|\s*(?:sh|bash|zsh|fish)\b/i
];
var SAFE_PATTERNS = [
  /^\s*ls(\s|$)/i,
  /^\s*pwd(\s|$)/,
  /^\s*whoami(\s|$)/,
  /^\s*id(\s|$)/,
  /^\s*echo\s/i,
  /^\s*printf\s/i,
  /^\s*cat\s/i,
  /^\s*head\s/i,
  /^\s*tail\s/i,
  /^\s*wc\s/i,
  /^\s*file\s/i,
  /^\s*stat\s/i,
  /^\s*du\s/i,
  /^\s*df\s/i,
  /^\s*which\s/i,
  /^\s*type\s/i,
  /^\s*env(\s|$)/i,
  /^\s*date(\s|$)/i,
  /^\s*uname/i,
  /^\s*hostname(\s|$)/i,
  /^\s*uptime(\s|$)/i,
  /^\s*history(\s|$)/i,
  /^\s*git\s+(status|log|diff|show|branch|blame|config\s+--get|remote\s+-v|stash\s+list|tag\s+-l|ls-files)\b/i,
  /^\s*node\s+--version/i,
  /^\s*npm\s+(ls|list|outdated|view|config\s+get|--version|-v|root)\b/i,
  /^\s*yarn\s+(list|--version)\b/i,
  /^\s*(python|python3)\s+--version/i,
  /^\s*pip\s+(list|show|--version)\b/i,
  /^\s*(rg|ripgrep)\s/i,
  /^\s*grep\s/i,
  /^\s*find\s+[^|;&]*(?<!-delete)\s*$/i,
  // find without -delete/-exec rm
  /^\s*tree(\s|$)/i,
  /^\s*jq\s/i,
  /^\s*awk\s/i,
  /^\s*sed\s+-n\s/i,
  // sed in print-only mode
  /^\s*(make|cargo|go|npm|bun|pnpm|yarn)\s+(test|check|vet|fmt\s+--check|build\s+--dry-run)\b/i,
  /^\s*(cargo|rustc)\s+--version/i,
  /^\s*docker\s+(ps|images|logs|inspect|version)\b/i,
  /^\s*kubectl\s+(get|describe|logs|version|config\s+current-context)\b/i
];
function classifyBashCommand(command) {
  const cmd = command.trim();
  if (!cmd) return { category: "safe" };
  const head = cmd.split(/[\s;|&]/)[0] ?? "";
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.test(cmd)) {
      return { category: "destructive", matchedPattern: p.source, head };
    }
  }
  for (const p of NETWORK_PATTERNS) {
    if (p.test(cmd)) {
      return { category: "network", matchedPattern: p.source, head };
    }
  }
  for (const p of SAFE_PATTERNS) {
    if (p.test(cmd)) {
      return { category: "safe", matchedPattern: p.source, head };
    }
  }
  return { category: "unknown", head };
}

// vendor/notch-cli/src/permissions/handlers/interactive.ts
var SESSION_RECENT_MS = 3e4;
var recentApprovals = /* @__PURE__ */ new Map();
function fingerprintArgs(args) {
  const keys = Object.keys(args).sort();
  const parts = [];
  for (const k of keys) {
    const v = args[k];
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s.slice(0, 200)}`);
  }
  return parts.join("|");
}
function makeKey(sessionId, toolName, args) {
  return `${sessionId}\0${toolName}\0${fingerprintArgs(args)}`;
}
function recordInteractiveApproval(sessionId, toolName, args) {
  const key = makeKey(sessionId, toolName, args);
  recentApprovals.set(key, { key, expires: Date.now() + SESSION_RECENT_MS });
}
function wasRecentlyApproved(sessionId, toolName, args) {
  const key = makeKey(sessionId, toolName, args);
  const hit = recentApprovals.get(key);
  if (!hit) return false;
  if (hit.expires < Date.now()) {
    recentApprovals.delete(key);
    return false;
  }
  return true;
}
var interactiveHandler = {
  surface: "interactive",
  check: async (toolName, args, baseDecision, ctx) => {
    if (baseDecision === "allow") {
      if (toolName === "shell" && typeof args.command === "string") {
        const pending = async () => {
          const cls = classifyBashCommand(args.command);
          if (cls.category === "destructive") {
            return {
              outcome: "prompt",
              reason: `classifier flagged destructive command: ${cls.matchedPattern}`
            };
          }
          return { outcome: "allow" };
        };
        return { outcome: "allow", pendingClassifierCheck: pending };
      }
      return { outcome: "allow" };
    }
    if (baseDecision === "deny") {
      return { outcome: "deny", reason: "denied by permission config" };
    }
    if (wasRecentlyApproved(ctx.sessionId, toolName, args)) {
      return {
        outcome: "allow",
        silent: true,
        reason: "session-recent approval (within 30s)"
      };
    }
    return { outcome: "prompt" };
  }
};

// vendor/notch-cli/src/permissions/handlers/one-shot.ts
var oneShotHandler = {
  surface: "one-shot",
  check: async (toolName, _args, baseDecision, ctx) => {
    if (baseDecision === "allow") return { outcome: "allow" };
    if (baseDecision === "deny") {
      return { outcome: "deny", reason: "denied by permission config" };
    }
    if (ctx.autoConfirm) {
      return {
        outcome: "allow",
        silent: true,
        reason: "--yes flag set; auto-confirming one-shot"
      };
    }
    const count = (ctx.denialCounter.get(toolName) ?? 0) + 1;
    ctx.denialCounter.set(toolName, count);
    return {
      outcome: "deny",
      silent: true,
      reason: "one-shot mode denies prompt-level tools without --yes",
      tailNotification: `one-shot: denied ${toolName} (pass --yes to auto-approve)`
    };
  }
};

// vendor/notch-cli/src/permissions/handlers/coordinator.ts
var COORDINATOR_ALLOWED = /* @__PURE__ */ new Set([
  "agent_spawn",
  "agent_send_message",
  "agent_stop",
  "read",
  "grep",
  "glob"
]);
var coordinatorHandler = {
  surface: "coordinator",
  check: async (toolName, _args, baseDecision, _ctx) => {
    if (COORDINATOR_ALLOWED.has(toolName)) {
      if (baseDecision === "deny") {
        return { outcome: "deny", reason: "coordinator tool explicitly denied by config" };
      }
      return { outcome: "allow", silent: true };
    }
    if (baseDecision === "deny") {
      return { outcome: "deny", reason: "denied by permission config" };
    }
    return {
      outcome: "deny",
      silent: true,
      reason: "Coordinator must delegate write operations to a worker.",
      tailNotification: `coordinator: blocked ${toolName} (delegate to worker)`
    };
  }
};

// vendor/notch-cli/src/permissions/handlers/subagent.ts
var subagentHandler = {
  surface: "subagent",
  check: async (toolName, _args, baseDecision, ctx) => {
    if (baseDecision === "allow") return { outcome: "allow" };
    if (baseDecision === "deny") {
      return { outcome: "deny", reason: "denied by permission config" };
    }
    const count = (ctx.denialCounter.get(toolName) ?? 0) + 1;
    ctx.denialCounter.set(toolName, count);
    const id = ctx.subagentId ?? "unknown";
    return {
      outcome: "deny",
      silent: true,
      reason: "subagent has no interactive UI to prompt",
      tailNotification: `subagent ${id}: denied ${toolName} (no UI to prompt)`
    };
  }
};

// vendor/notch-cli/src/permissions/handlers/auto-mode.ts
var AUTO_IMPLICIT_WRITE_KEY = "__auto_mode_implicit_writes__";
var AUTO_WRITE_NOTIFY_THRESHOLD = 10;
var WRITE_TOOLS = /* @__PURE__ */ new Set(["write", "edit", "apply_patch", "shell", "git"]);
function hardDenyReason(toolName, args) {
  if (toolName === "git") {
    const op = typeof args.operation === "string" ? args.operation : "";
    const flags = typeof args.flags === "string" ? args.flags : "";
    const argsStr = typeof args.args === "string" ? args.args : "";
    const combined = `${op} ${flags} ${argsStr}`.toLowerCase();
    if (op !== "commit_and_push" && combined.includes("push") && /(-f\b|--force\b|--force-with-lease\b)/.test(combined)) {
      return "force-push is never auto-approved";
    }
    if (combined.includes("reset") && combined.includes("--hard")) {
      return "git reset --hard is never auto-approved";
    }
  }
  if (toolName === "shell" && typeof args.command === "string") {
    const cmd = args.command;
    if (/\bnpm\s+publish\b/i.test(cmd) || /\byarn\s+publish\b/i.test(cmd) || /\bpnpm\s+publish\b/i.test(cmd)) {
      return "package publish is never auto-approved";
    }
    if (/\bgit\s+push\b.*\b(?:-f|--force|--force-with-lease)\b/i.test(cmd)) {
      return "force-push is never auto-approved";
    }
    if (/\b(?:rm\s+-rf?|dd\s+if=|mkfs\.|shred)\b/i.test(cmd)) {
      return "classifier-flagged destructive shell command";
    }
  }
  return null;
}
var autoModeHandler = {
  surface: "auto-mode",
  check: async (toolName, args, baseDecision, ctx) => {
    if (baseDecision === "deny") {
      return { outcome: "deny", reason: "denied by permission config" };
    }
    const reason = hardDenyReason(toolName, args);
    if (reason) {
      return {
        outcome: "deny",
        silent: false,
        reason,
        tailNotification: `auto-mode: refused ${toolName} \u2014 ${reason}`
      };
    }
    if (toolName === "shell" && typeof args.command === "string") {
      const pending = async () => {
        const cls = classifyBashCommand(args.command);
        if (cls.category === "destructive") {
          return {
            outcome: "deny",
            silent: false,
            reason: `classifier flagged destructive command: ${cls.matchedPattern}`,
            tailNotification: `auto-mode: refused destructive shell command (${cls.head ?? "shell"})`
          };
        }
        return baseDecision === "allow" ? { outcome: "allow", silent: true } : { outcome: "allow", silent: true, reason: "auto-mode implicit approval" };
      };
      if (baseDecision === "allow") return { outcome: "allow", pendingClassifierCheck: pending };
      return { outcome: "allow", silent: true, pendingClassifierCheck: pending };
    }
    if (baseDecision === "allow") return { outcome: "allow" };
    if (WRITE_TOOLS.has(toolName)) {
      const writes = (ctx.denialCounter.get(AUTO_IMPLICIT_WRITE_KEY) ?? 0) + 1;
      ctx.denialCounter.set(AUTO_IMPLICIT_WRITE_KEY, writes);
      if (writes === AUTO_WRITE_NOTIFY_THRESHOLD) {
        return {
          outcome: "allow",
          silent: true,
          reason: "auto-mode implicit approval",
          tailNotification: `auto-mode: ${writes} unattended writes this session \u2014 consider reviewing`
        };
      }
      if (writes > AUTO_WRITE_NOTIFY_THRESHOLD && writes % 10 === 0) {
        return {
          outcome: "allow",
          silent: true,
          reason: "auto-mode implicit approval",
          tailNotification: `auto-mode: ${writes} unattended writes this session`
        };
      }
    }
    return { outcome: "allow", silent: true, reason: "auto-mode implicit approval" };
  }
};

// vendor/notch-cli/src/permissions/handlers/json-mode.ts
var jsonModeHandler = {
  surface: "json-mode",
  check: async (toolName, _args, baseDecision, ctx) => {
    if (baseDecision === "allow") return { outcome: "allow" };
    if (baseDecision === "deny") {
      return { outcome: "deny", reason: "denied by permission config" };
    }
    const count = (ctx.denialCounter.get(toolName) ?? 0) + 1;
    ctx.denialCounter.set(toolName, count);
    const payload = JSON.stringify({
      type: "permission_denied",
      tool: toolName,
      reason: "json mode requires explicit allowlist"
    });
    return {
      outcome: "deny",
      silent: true,
      reason: "json mode requires explicit allowlist",
      tailNotification: payload
    };
  }
};

// vendor/notch-cli/src/permissions/dispatcher.ts
var HANDLERS = {
  interactive: interactiveHandler,
  "one-shot": oneShotHandler,
  coordinator: coordinatorHandler,
  subagent: subagentHandler,
  "auto-mode": autoModeHandler,
  "json-mode": jsonModeHandler
};
function getActiveHandler(surface) {
  return HANDLERS[surface];
}
async function runPermissionCheck(toolName, args, baseDecision, surface, ctx) {
  const handler = getActiveHandler(surface);
  const initial = await handler.check(toolName, args, baseDecision, ctx);
  if (initial.tailNotification) {
    pushTailNotification(initial.tailNotification);
  }
  if (!initial.pendingClassifierCheck) return initial;
  try {
    const refined = await initial.pendingClassifierCheck();
    if (refined.tailNotification) pushTailNotification(refined.tailNotification);
    return {
      outcome: refined.outcome,
      reason: refined.reason ?? initial.reason,
      silent: refined.silent ?? initial.silent,
      tailNotification: refined.tailNotification ?? initial.tailNotification
    };
  } catch {
    return {
      outcome: initial.outcome,
      reason: initial.reason,
      silent: initial.silent,
      tailNotification: initial.tailNotification
    };
  }
}
var tailQueue = [];
function pushTailNotification(message) {
  tailQueue.push(message);
}
function recordAutoModeDenial(decision) {
  if (decision.outcome !== "deny") return;
  const msg = decision.tailNotification ?? decision.reason ?? "auto-mode: tool denied";
  pushTailNotification(msg);
}
function createHandlerContext(options) {
  return {
    cwd: options.cwd,
    sessionId: options.sessionId,
    denialCounter: /* @__PURE__ */ new Map(),
    log: options.log,
    autoConfirm: options.autoConfirm,
    guardianEnabled: options.guardianEnabled,
    subagentId: options.subagentId
  };
}

// vendor/notch-cli/src/permissions/index.ts
var DEFAULT_DENY_READ_GLOBS = Object.freeze([
  "**/.env",
  "**/.env.*",
  "!**/.env.example",
  "!**/.env.sample",
  "**/*.key",
  "**/*.pem",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/id_ed25519",
  "**/id_ed25519.*",
  "**/id_ecdsa",
  "**/id_ecdsa.*",
  "**/.ssh/**",
  "**/.aws/credentials",
  "**/.aws/config",
  "**/.gcp/**",
  "**/credentials.json",
  "**/secrets.json",
  "**/*.keystore",
  "**/*.jks",
  "**/*.p12",
  "**/*.pfx",
  "**/.git/config",
  "**/.git/hooks/**"
]);
var DEFAULT_DENY_WRITE_GLOBS = Object.freeze([
  "**/.git/**",
  "!**/.git/info/exclude"
  // a file users legitimately edit
]);
var DEFAULT_PERMISSIONS = {
  default: "prompt",
  rules: [
    // Safe read-only tools auto-allowed
    { tool: "read", level: "allow" },
    { tool: "task_changes", level: "allow" },
    { tool: "grep", level: "allow" },
    { tool: "glob", level: "allow" },
    { tool: "web_fetch", level: "allow" },
    { tool: "web_search", level: "allow" },
    { tool: "browser_read", level: "allow" },
    { tool: "browser_interact", level: "prompt" },
    // Write tools prompt by default
    { tool: "write", level: "prompt" },
    { tool: "edit", level: "prompt" },
    { tool: "shell", level: "prompt" },
    { tool: "git", level: "prompt" }
  ],
  denyReadGlobs: [...DEFAULT_DENY_READ_GLOBS],
  denyWriteGlobs: [...DEFAULT_DENY_WRITE_GLOBS]
};
async function loadPermissions(projectRoot) {
  const projectPath = path2.join(projectRoot, ".notch.json");
  const globalPath = path2.join(os.homedir(), ".notch", "permissions.json");
  let config = { ...DEFAULT_PERMISSIONS };
  try {
    const raw = await fs2.readFile(globalPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.permissions) {
      config = mergePermissions(config, parsed.permissions);
    }
  } catch {
  }
  try {
    const raw = await fs2.readFile(projectPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.permissions) {
      config = mergePermissions(config, parsed.permissions);
    }
  } catch {
  }
  return config;
}
var TOOL_PATH_ACCESS = {
  task_changes: "read",
  read: "read",
  grep: "read",
  glob: "read",
  notebook: "both",
  write: "write",
  edit: "both",
  apply_patch: "both",
  applypatch: "both",
  diff_preview: "read",
  diffpreview: "read",
  // Shell-like tools can read or write — check both deny sets. Path
  // extraction below scrapes literal tokens from the command string.
  shell: "both",
  bash: "both",
  git: "both"
};
function extractPathsFromArgs(toolName, args) {
  const out = [];
  const t = toolName.toLowerCase().replace(/-/g, "_");
  const COMMON_PATH_KEYS = ["path", "file", "file_path", "filePath", "target", "input", "output"];
  for (const k of COMMON_PATH_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  if ((t === "shell" || t === "bash" || t === "git") && typeof args.command === "string") {
    const cmd = args.command;
    const tokens = cmd.split(/\s+/).filter((tok) => {
      if (tok.startsWith("-")) return false;
      if (tok.startsWith('"') || tok.startsWith("'")) tok = tok.slice(1);
      return /[./]/.test(tok);
    });
    out.push(...tokens);
  }
  if (typeof args.patch === "string") {
    for (const line of args.patch.split("\n")) {
      const m = line.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(\S+)/);
      if (m && m[1] !== "/dev/null") out.push(m[1]);
    }
  }
  return out;
}
function matchesAnyGlob(candidate, patterns) {
  let normalized = candidate.replace(/\\/g, "/");
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  const basename = normalized.split("/").pop() ?? normalized;
  let matched = false;
  for (const raw of patterns) {
    const negate = raw.startsWith("!");
    const pat = negate ? raw.slice(1) : raw;
    const hasSlash = pat.includes("/");
    let hit = false;
    if (minimatch(normalized, pat, { dot: true, matchBase: !hasSlash })) hit = true;
    if (!hit && pat.startsWith("**/")) {
      if (minimatch(basename, pat.slice(3), { dot: true })) hit = true;
    }
    if (!hit && minimatch(basename, pat, { dot: true })) hit = true;
    if (hit) matched = !negate;
  }
  return matched;
}
function checkPermission(config, toolName, args) {
  const access = TOOL_PATH_ACCESS[toolName.toLowerCase().replace(/-/g, "_")];
  if (access && args) {
    const paths = extractPathsFromArgs(toolName, args);
    if (paths.length > 0) {
      const denyRead = config.denyReadGlobs ?? [];
      const denyWrite = config.denyWriteGlobs ?? [];
      const checkRead = access === "read" || access === "both";
      const checkWrite = access === "write" || access === "both";
      for (const p of paths) {
        if (checkRead && denyRead.length > 0 && matchesAnyGlob(p, denyRead)) {
          return "deny";
        }
        if (checkWrite && denyWrite.length > 0 && matchesAnyGlob(p, denyWrite)) {
          return "deny";
        }
      }
    }
  }
  const rule = config.rules.find((r) => {
    if (r.tool !== toolName) return false;
    if (r.pattern && args) {
      const pat = new RegExp(r.pattern);
      return Object.values(args).some((v) => pat.test(String(v)));
    }
    return true;
  });
  return rule?.level ?? config.default;
}
function mergePermissions(base, override) {
  const merged = {
    ...base,
    denyReadGlobs: base.denyReadGlobs ? [...base.denyReadGlobs] : void 0,
    denyWriteGlobs: base.denyWriteGlobs ? [...base.denyWriteGlobs] : void 0
  };
  if (override.default) merged.default = override.default;
  if (override.rules) {
    for (const rule of override.rules) {
      const idx = merged.rules.findIndex((r) => r.tool === rule.tool && r.pattern === rule.pattern);
      if (idx >= 0) {
        merged.rules[idx] = rule;
      } else {
        merged.rules.push(rule);
      }
    }
  }
  if (override.denyReadGlobs) {
    const existing = new Set(merged.denyReadGlobs ?? []);
    for (const g of override.denyReadGlobs) existing.add(g);
    merged.denyReadGlobs = [...existing];
  }
  if (override.denyWriteGlobs) {
    const existing = new Set(merged.denyWriteGlobs ?? []);
    for (const g of override.denyWriteGlobs) existing.add(g);
    merged.denyWriteGlobs = [...existing];
  }
  return merged;
}

// vendor/notch-cli/src/permissions/access.ts
var ACCESS_MODES = ["approve", "read-only", "full-access"];
var READ_TOOLS = /* @__PURE__ */ new Set(["read", "task_changes", "grep", "glob", "web_fetch", "web_search", "browser_read"]);
function parseAccessMode(value) {
  if (typeof value !== "string" || !ACCESS_MODES.includes(value)) {
    throw new Error(`Invalid access mode ${JSON.stringify(value)}. Choose ${ACCESS_MODES.join(", ")}.`);
  }
  return value;
}
function checkAccess(mode, permissions, tool, args) {
  if (mode === "full-access") return "allow";
  const base = checkPermission(permissions, tool, args);
  if (base === "deny") return "deny";
  if (mode === "read-only") return READ_TOOLS.has(tool) ? "allow" : "deny";
  return base;
}
function isBuiltInReadTool(tool, builtin) {
  return builtin && READ_TOOLS.has(tool);
}

// vendor/notch-cli/src/concurrency/task-workspace.ts
import fs3 from "fs/promises";
import path3 from "path";
import os2 from "os";
import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
function openRouterTaskContext(ctx, model) {
  const cloud = typeof model === "string" ? /^openrouter[/:]/.test(model) : /^openrouter(?:\.|$)/.test(model.provider);
  return { ...ctx, isolateTasks: () => !ctx.remoteWorkspace && cloud && (ctx.workspaceMode?.() === "isolated" || !ctx.workspaceMode && !!ctx.isolateTasks?.()) };
}
function parseWorkspaceMode(value) {
  if (value !== "shared" && value !== "isolated") throw new Error("Workspace mode must be shared or isolated.");
  return value;
}
async function projectKey(cwd) {
  cwd = await fs3.realpath(cwd);
  try {
    cwd = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
  }
  return "project-task:" + (process.platform === "win32" ? path3.resolve(cwd).toLowerCase() : cwd);
}
var sharedWorkers = /* @__PURE__ */ new Map();
async function acquireProjectLease(cwd, signal, onWait) {
  return acquireLease(await projectKey(cwd), signal, onWait);
}
async function withSharedWorker(ctx, run) {
  if (ctx.taskWorkspace || ctx.accessMode === "read-only" || ctx.dryRun) return run(ctx);
  return withTaskWorkspace(ctx, (owned) => {
    const workers = sharedWorkers.get(owned.sharedTask);
    const pending = (async () => {
      const release = await acquireLease(
        "shared-workers:" + owned.sharedTask + ":" + (owned.sharedWorker ?? "root"),
        ctx.abortSignal,
        (waiting) => ctx.onQueue?.(waiting ? "Waiting for another worker in this project\u2026" : null)
      );
      try {
        return await run({ ...owned, sharedWorker: randomUUID() });
      } finally {
        await release();
      }
    })();
    workers.add(pending);
    void pending.finally(() => workers.delete(pending)).catch(() => {
    });
    return pending;
  });
}
var exec = promisify(execFile);
var hash = (data) => createHash("sha256").update(data).digest("hex");
var home = () => path3.join(process.env.USERPROFILE || process.env.HOME || os2.homedir(), ".notch", "worktrees");
async function git(cwd, args, env = {}) {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS)$/i.test(key)) delete inherited[key];
  const result = await exec("git", ["-c", "core.hooksPath=" + path3.join(home(), "no-hooks"), "-c", "core.fsmonitor=false", "-c", "core.longpaths=true", ...args], {
    cwd,
    env: { ...inherited, GIT_TERMINAL_PROMPT: "0", ...env },
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  return result.stdout;
}
async function revision(file) {
  try {
    const stat = await fs3.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Task isolation requires regular files: ${file}`);
    return { hash: hash(await fs3.readFile(file)), mode: stat.mode & 511 };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function same(a, b) {
  return a?.hash === b?.hash && (process.platform === "win32" || a?.mode === b?.mode);
}
function inside(root, file) {
  const relative = path3.relative(root, file);
  return relative !== ".." && !relative.startsWith(".." + path3.sep) && !path3.isAbsolute(relative);
}
async function safeFile(root, relative) {
  const target = path3.resolve(root, relative);
  if (!inside(root, target) || relative.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) throw new Error("Task path escapes the project.");
  if (process.platform === "win32" && path3.relative(root, target).includes(":")) throw new Error("Windows alternate data streams are not task files.");
  let parent = target;
  while (parent !== root) {
    try {
      const stat = await fs3.lstat(parent);
      if (stat.isSymbolicLink() || !inside(root, await fs3.realpath(parent))) throw new Error(`Task path crosses a symbolic link: ${relative}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    parent = path3.dirname(parent);
  }
  return target;
}
async function save(file, data) {
  await fs3.mkdir(path3.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await fs3.writeFile(temporary, JSON.stringify(data), { flag: "wx", mode: 384, flush: true });
    await fs3.rename(temporary, file);
  } finally {
    await fs3.unlink(temporary).catch(() => {
    });
  }
}
async function sourceLease(cwd, signal) {
  const projectRelease = await acquireProjectLease(cwd, signal);
  let release;
  try {
    release = await acquireLease("file-mutations", signal);
    const taskRelease = await acquireLease("task-files:" + cwd, signal);
    return async () => {
      try {
        await taskRelease();
      } finally {
        try {
          await release();
        } finally {
          await projectRelease();
        }
      }
    };
  } catch (error) {
    try {
      await release?.();
    } finally {
      await projectRelease();
    }
    throw error;
  }
}
async function files(repo, root, index) {
  const result = await git(root, ["--git-dir", repo, "--work-tree", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], index ? { GIT_INDEX_FILE: index } : {});
  return [...new Set(result.split("\0").filter(Boolean))];
}
var TaskWorkspace = class _TaskWorkspace {
  constructor(file, manifest) {
    this.file = file;
    this.manifest = manifest;
  }
  file;
  manifest;
  get cwd() {
    return this.manifest.cwd;
  }
  static async open(source, session) {
    source = await fs3.realpath(source);
    if (inside(source, home())) throw new Error("Choose a specific project folder: the selected folder contains notch\u2019s own task storage.");
    const folder = path3.join(home(), hash(source).slice(0, 20), hash(session).slice(0, 20));
    const file = path3.join(folder, "task.json");
    await fs3.mkdir(folder, { recursive: true, mode: 448 });
    let savedText;
    try {
      savedText = await fs3.readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (savedText !== void 0) {
      const saved = JSON.parse(savedText);
      if (saved.version !== 1 || saved.source !== source || typeof saved.root !== "string" || typeof saved.cwd !== "string" || typeof saved.repo !== "string" || !saved.baseline || !["running", "pending", "applied"].includes(saved.state) || !inside(folder, saved.root) || saved.root === folder || !inside(saved.root, saved.cwd)) throw new Error("Invalid saved task workspace.");
      if (saved.state !== "applied") {
        if (await fs3.realpath(saved.root).catch(() => "") !== saved.root) throw new Error("Saved task checkout is missing or moved. Its recovery record was preserved.");
        await safeFile(saved.root, path3.relative(saved.root, saved.cwd));
        await fs3.mkdir(saved.cwd, { recursive: true });
        if (await fs3.realpath(saved.cwd) !== saved.cwd) throw new Error("Saved task checkout moved.");
        return new _TaskWorkspace(file, saved);
      }
    }
    let root, repo;
    try {
      root = (await git(source, ["rev-parse", "--show-toplevel"])).trim();
      root = await fs3.realpath(root);
      repo = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("Install Git to enable automatic task isolation.");
      root = source;
      repo = path3.join(folder, "repository.git");
      await git(source, ["init", "--bare", repo]);
      await fs3.writeFile(path3.join(repo, "info", "exclude"), "node_modules/\n.venv/\nvenv/\n__pycache__/\n");
    }
    if (inside(root, home())) throw new Error("Choose a project repository outside notch\u2019s task storage. Its parent repository contains that storage.");
    const index = path3.join(folder, "index-" + randomUUID());
    const env = { GIT_INDEX_FILE: index };
    const args = ["--git-dir", repo, "--work-tree", root];
    const checkout = path3.join(folder, "checkout-" + randomUUID());
    try {
      let filterNames = "";
      try {
        filterNames = await git(root, [...args, "config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]);
      } catch (error) {
        if (error.code !== 1) throw error;
      }
      const filters = [...new Set(filterNames.trim().split(/\r?\n/).filter(Boolean).map((name) => name.replace(/\.[^.]+$/, "")))];
      const noFilters = filters.flatMap((name) => ["-c", `${name}.clean=`, "-c", `${name}.smudge=`, "-c", `${name}.process=`, "-c", `${name}.required=false`]);
      const sourceIndex = (await git(root, ["--git-dir", repo, "rev-parse", "--git-path", "index"])).trim();
      try {
        await fs3.copyFile(path3.resolve(root, sourceIndex), index);
        await git(root, [...args, "update-index", "--no-split-index"], env);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        try {
          await git(root, [...args, "read-tree", "HEAD"], env);
        } catch {
          await git(root, [...args, "read-tree", "--empty"], env);
        }
      }
      let commit;
      try {
        commit = (await git(root, [...args, "rev-parse", "--verify", "HEAD"])).trim();
      } catch {
      }
      const headNames = commit ? (await git(root, [...args, "ls-tree", "-r", "--name-only", "-z", commit])).split("\0").filter(Boolean) : [];
      const names = [.../* @__PURE__ */ new Set([...headNames, ...await files(repo, root, index)])];
      const skipped = new Set((await git(root, [...args, "ls-files", "-v", "-z"], env)).split("\0").filter((line) => line[0]?.toUpperCase() === "S").map((line) => line.slice(2)));
      const baseline = /* @__PURE__ */ Object.create(null);
      for (const name of names) baseline[name] = { source: await revision(await safeFile(root, name)), task: null };
      if (!commit) {
        const empty = { GIT_INDEX_FILE: index + ".empty" };
        try {
          await git(root, [...args, "read-tree", "--empty"], empty);
          const tree = (await git(root, [...args, "write-tree"], empty)).trim();
          commit = (await git(root, [...args, "commit-tree", tree, "-m", "notch task workspace"], {
            ...empty,
            GIT_AUTHOR_NAME: "notch",
            GIT_AUTHOR_EMAIL: "tasks@freesyntax.dev",
            GIT_COMMITTER_NAME: "notch",
            GIT_COMMITTER_EMAIL: "tasks@freesyntax.dev"
          })).trim();
        } finally {
          await fs3.unlink(empty.GIT_INDEX_FILE).catch(() => {
          });
        }
      }
      await git(root, ["--git-dir", repo, ...noFilters, "-c", "core.autocrlf=false", "worktree", "add", "--detach", checkout, commit]);
      for (const [name, entry] of Object.entries(baseline)) {
        const target = await safeFile(checkout, name);
        if (entry.source) {
          await fs3.mkdir(path3.dirname(target), { recursive: true });
          await fs3.copyFile(await safeFile(root, name), target);
        } else if (!skipped.has(name)) await fs3.unlink(target).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        entry.task = await revision(target);
      }
      for (const [name, entry] of Object.entries(baseline)) {
        if (!same(entry.source, await revision(await safeFile(root, name)))) throw new Error("Project changed while preparing the task. Please retry.");
      }
      for (const name of await files(repo, checkout, index)) {
        const entry = baseline[name];
        if (!entry) throw new Error("Project changed while preparing the task. Please retry.");
      }
      const manifest = { version: 1, source, repo, root: checkout, cwd: path3.join(checkout, path3.relative(root, source)), baseline, state: "running" };
      manifest.baseline = Object.fromEntries(Object.entries(baseline).map(([name, entry]) => [path3.relative(source, path3.join(root, name)), entry]));
      await save(file, manifest);
      return new _TaskWorkspace(file, manifest);
    } catch (error) {
      if (inside(folder, checkout) && path3.basename(checkout).startsWith("checkout-")) await git(root, ["--git-dir", repo, "worktree", "remove", "--force", checkout]).catch(() => {
      });
      throw error;
    } finally {
      await fs3.unlink(index).catch(() => {
      });
    }
  }
  /** Capture shell-created/deleted files too; plugins cannot bypass the delivery check. */
  async changes() {
    const m = this.manifest;
    const taskRepo = (await git(m.root, ["rev-parse", "--absolute-git-dir"])).trim();
    const names = /* @__PURE__ */ new Set([...Object.keys(m.baseline), ...(await files(taskRepo, m.root)).map((name) => path3.relative(m.cwd, path3.join(m.root, name)))]);
    const changes = [];
    for (const name of names) {
      const current = await revision(await safeFile(m.root, path3.relative(m.root, path3.resolve(m.cwd, name))));
      const entry = Object.hasOwn(m.baseline, name) ? m.baseline[name] : void 0;
      if (!same(current, entry?.task ?? null)) changes.push({ name, current, entry: entry ?? { source: null, task: null } });
    }
    return changes;
  }
  async apply(checkpoints) {
    const m = this.manifest, changes = await this.changes();
    const release = await sourceLease(m.source);
    try {
      const conflicts = [], plan = [];
      for (const change of changes) {
        if (!inside(m.source, path3.resolve(m.source, change.name))) {
          conflicts.push(`Outside the selected folder: ${change.name}`);
          continue;
        }
        const source = await safeFile(m.source, change.name);
        const current = await revision(source);
        if (same(current, change.current)) continue;
        if (Object.hasOwn(change.entry, "reconcile") && same(change.current, change.entry.reconcile)) {
          conflicts.push(change.name);
          continue;
        }
        if (!same(current, change.entry.source)) {
          conflicts.push(change.name);
          continue;
        }
        const bytes = change.current ? await fs3.readFile(await safeFile(m.cwd, change.name)) : null;
        if (bytes && hash(bytes) !== change.current.hash) throw new Error("Task files changed during delivery. Please retry.");
        if (checkpoints && bytes && !Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error(`Binary task output needs review before applying: ${change.name}. The private checkout was preserved.`);
        plan.push({ ...change, source, bytes });
      }
      if (conflicts.length) {
        m.state = "pending";
        await save(this.file, m);
        return { applied: false, files: changes.map((c) => c.name), conflicts, cwd: this.cwd };
      }
      for (const item of plan) await checkpoints?.recordBefore(item.source);
      for (const item of plan) {
        if (item.bytes === null) await fs3.unlink(item.source);
        else {
          await fs3.mkdir(path3.dirname(item.source), { recursive: true });
          const temporary = item.source + ".notch-" + randomUUID() + ".tmp";
          try {
            await fs3.writeFile(temporary, item.bytes, { mode: item.current.mode, flag: "wx", flush: true });
            await fs3.rename(temporary, item.source);
          } finally {
            await fs3.unlink(temporary).catch(() => {
            });
          }
        }
        await checkpoints?.recordAfter(item.source);
      }
      await checkpoints?.finish?.();
      m.state = "applied";
      await save(this.file, m);
      return { applied: true, files: changes.map((c) => c.name), conflicts, cwd: this.cwd };
    } finally {
      await release();
    }
  }
  async readSource(name) {
    const release = await sourceLease(this.manifest.source);
    try {
      const source = await safeFile(this.manifest.source, name);
      const relative = path3.relative(this.manifest.source, source);
      const key = (value) => process.platform === "win32" ? path3.normalize(value).toLowerCase() : path3.normalize(value);
      name = Object.keys(this.manifest.baseline).find((existing) => key(existing) === key(relative)) ?? relative;
      const current = await revision(source);
      const bytes = current ? await fs3.readFile(source) : null;
      if (bytes && hash(bytes) !== current.hash) throw new Error("Source changed while reading. Read it again.");
      const entry = (Object.hasOwn(this.manifest.baseline, name) ? this.manifest.baseline[name] : void 0) ?? { source: null, task: null };
      if (!same(entry.source, current)) entry.reconcile = await revision(await safeFile(this.manifest.cwd, name));
      entry.source = current;
      Object.defineProperty(this.manifest.baseline, name, { value: entry, enumerable: true, writable: true, configurable: true });
      await save(this.file, this.manifest);
      return bytes ? bytes.toString("utf8") : "[This source file does not exist.]";
    } finally {
      await release();
    }
  }
  async retainForWorkers() {
    this.manifest.retainForWorkers = true;
    await save(this.file, this.manifest);
  }
  async dispose() {
    if (this.manifest.state !== "applied" || this.manifest.retainForWorkers) return;
    const root = path3.resolve(this.manifest.root), folder = path3.dirname(this.file);
    if (!inside(folder, root) || !path3.basename(root).startsWith("checkout-")) throw new Error("Invalid managed checkout path.");
    await git(this.manifest.source, ["--git-dir", this.manifest.repo, "worktree", "remove", "--force", root]);
  }
};
async function withTaskWorkspace(ctx, run) {
  if (ctx.remoteWorkspace) {
    const release2 = await acquireLease(ctx.remoteWorkspace.leaseKey, ctx.abortSignal, (waiting) => ctx.onQueue?.(waiting ? "Waiting for another task in this SSH workspace\u2026" : null));
    try {
      return await run(ctx);
    } finally {
      try {
        await ctx.workspaceCheckpoints?.finish?.();
      } finally {
        ctx.onQueue?.(null);
        await release2();
      }
    }
  }
  if (ctx.accessMode === "read-only" || ctx.dryRun || ctx.taskWorkspace) return run(ctx);
  if (!ctx.isolateTasks?.()) {
    if (ctx.sharedTask && sharedWorkers.has(ctx.sharedTask)) return run(ctx);
    const release2 = await acquireProjectLease(
      ctx.cwd,
      ctx.abortSignal,
      (waiting) => ctx.onQueue?.(waiting ? "Waiting for another task in this project\u2026" : null)
    );
    const token = randomUUID(), workers = /* @__PURE__ */ new Set();
    sharedWorkers.set(token, workers);
    try {
      ctx.abortSignal?.throwIfAborted();
      return await run({ ...ctx, sharedTask: token, sharedWorker: void 0, _readCache: /* @__PURE__ */ new Map(), _fileVersions: /* @__PURE__ */ new Map() });
    } finally {
      try {
        while (workers.size) await Promise.allSettled([...workers]);
        await ctx.workspaceCheckpoints?.finish?.();
      } finally {
        sharedWorkers.delete(token);
        await release2();
      }
    }
  }
  const session = ctx.permissionSessionId || randomUUID();
  const release = await acquireLease("task-workspace:" + hash(ctx.cwd + "\0" + session), ctx.abortSignal);
  let task;
  try {
    ctx.onQueue?.("Preparing a private task workspace\u2026");
    const sourceLock = await sourceLease(ctx.cwd, ctx.abortSignal);
    try {
      task = await TaskWorkspace.open(ctx.cwd, session);
    } finally {
      await sourceLock();
    }
    ctx.abortSignal?.throwIfAborted();
    ctx.onQueue?.(null);
    ctx.log("Working in a private task workspace. Safe changes return automatically.");
    const child = {
      ...ctx,
      cwd: task.cwd,
      taskWorkspace: task,
      _readCache: /* @__PURE__ */ new Map(),
      _fileVersions: /* @__PURE__ */ new Map(),
      runHook: ctx.runHook ? (event, payload) => ctx.runHook(event, { ...payload, isolatedWorkspace: true, cwd: task.cwd }) : void 0
    };
    const result = await run(child);
    ctx.abortSignal?.throwIfAborted();
    if (result && typeof result === "object" && ("error" in result && result.error || "status" in result && result.status === "max-iterations")) {
      ctx.log(`Unfinished task files are safe in ${task.cwd}. Resume this chat to continue.`);
      return result;
    }
    const delivery = await task.apply(ctx.workspaceCheckpoints);
    ctx.onWorkspaceResult?.(delivery);
    ctx.log(delivery.applied ? `Applied ${delivery.files.length} task file change(s).` : `Changes kept separate: ${delivery.conflicts.join(", ")} changed in the project. Ask notch to reconcile them. Saved workspace: ${task.cwd}`);
    if (delivery.applied) await task.dispose().catch(() => ctx.log("Completed task checkout retained for cleanup."));
    return result;
  } catch (error) {
    if (task) ctx.log(`Unfinished task files are safe in ${task.cwd}. Resume this chat to continue.`);
    throw error;
  } finally {
    ctx.onQueue?.(null);
    await release();
  }
}

// vendor/notch-cli/src/config.ts
var DEFAULT_MODEL = {
  model: "openrouter/anthropic/claude-sonnet-4.6",
  temperature: 0.3
};
var DEFAULTS = {
  workspaceMode: "shared",
  models: { chat: DEFAULT_MODEL },
  projectRoot: process.cwd(),
  autoConfirm: false,
  maxIterations: 25,
  useRepoMap: true,
  renderMarkdown: true,
  enableMemory: true,
  enableHooks: true,
  permissionMode: "auto",
  theme: "default"
};
function selectModel(current, selection) {
  const next = { ...current };
  if (selection.provider || selection.model) {
    if (selection.model && selection.model !== current.model) {
      delete next.sourceRepo;
      delete next.nativeContextWindow;
      delete next.maxOutputTokens;
    }
    const oldProvider = current.byokProvider ?? (isByokRef(current.model) ? parseByokRef(current.model).provider : void 0);
    const provider = selection.provider === "custom" ? "__custom__" : selection.provider;
    const newProvider = provider ?? (selection.model && isByokRef(selection.model) ? parseByokRef(selection.model).provider : void 0);
    if (newProvider !== oldProvider) {
      delete next.baseUrl;
      delete next.apiKey;
      delete next.byokHeaders;
      delete next.headers;
      delete next.byokApiShape;
      delete next.contextWindow;
      delete next.colibriAutoContext;
      delete next.strataAutoContext;
      delete next.nativeContextWindow;
      delete next.maxOutputTokens;
      delete next.ollamaBatch;
      delete next.sourceRepo;
    }
    if (provider) {
      const info = findByokProvider(provider);
      if (!info) throw new Error(`Unknown provider: ${selection.provider}. Run notch --list-providers.`);
      next.byokProvider = provider;
      next.model = selection.model || info.defaultModel;
      if (isByokRef(next.model)) {
        const ref = parseByokRef(next.model);
        if (ref.provider !== provider) throw new Error("The --provider and --model provider must match.");
        next.model = ref.model;
      }
    } else if (selection.model) {
      if (!isValidModel(selection.model) && !isByokRef(selection.model)) {
        throw new Error(`Unknown model: ${selection.model}. Use provider/model or pass --provider.`);
      }
      next.model = selection.model;
      delete next.byokProvider;
    }
  }
  if (selection.baseUrl) next.baseUrl = selection.baseUrl;
  if (selection.apiKey) next.apiKey = selection.apiKey;
  return next;
}
async function loadConfig(overrides = {}, selection = {}) {
  const config = { ...DEFAULTS, projectRoot: path4.resolve(overrides.projectRoot ?? process.cwd()), models: { chat: { ...DEFAULT_MODEL } } };
  let explicitModelConfig = false;
  const configPath = path4.resolve(config.projectRoot, ".notch.json");
  try {
    const raw = await fs4.readFile(configPath, "utf-8");
    const fileConfig = JSON.parse(raw);
    if (fileConfig.model && (isValidModel(fileConfig.model) || isByokRef(fileConfig.model))) {
      config.models.chat.model = fileConfig.model;
      explicitModelConfig = true;
    }
    if (fileConfig.baseUrl) config.models.chat.baseUrl = fileConfig.baseUrl;
    if (fileConfig.apiKey) config.models.chat.apiKey = fileConfig.apiKey;
    const providerBlock = fileConfig.provider && typeof fileConfig.provider === "object" ? fileConfig.provider : fileConfig.byok;
    if (providerBlock && typeof providerBlock === "object") {
      const byok = providerBlock;
      config.byok = { ...byok };
      if (byok.provider && findByokProvider(byok.provider === "custom" ? "__custom__" : byok.provider)) {
        config.models.chat.byokProvider = byok.provider === "custom" ? "__custom__" : byok.provider;
        config.models.chat.model = byok.model || findByokProvider(config.models.chat.byokProvider).defaultModel;
        if (byok.baseUrl) config.models.chat.baseUrl = byok.baseUrl;
        if (typeof byok.sourceRepo === "string") config.models.chat.sourceRepo = byok.sourceRepo;
        if (byok.contextWindow !== void 0) {
          const maximum = ["ollama", "ollama-anthropic", "mlx"].includes(byok.provider || "") ? 262144 : 16777216;
          if (!Number.isInteger(byok.contextWindow) || byok.contextWindow < 2048 || byok.contextWindow > maximum) throw new Error(`provider.contextWindow must be an integer between 2048 and ${maximum}.`);
          config.models.chat.contextWindow = byok.contextWindow;
        }
        if (byok.ollamaBatch !== void 0) {
          if (!Number.isInteger(byok.ollamaBatch) || byok.ollamaBatch < 1 || byok.ollamaBatch > 2048) throw new Error("provider.ollamaBatch must be an integer between 1 and 2048.");
          config.models.chat.ollamaBatch = byok.ollamaBatch;
        }
        if (byok.headers) {
          config.models.chat.byokHeaders = { ...config.models.chat.byokHeaders, ...byok.headers };
        }
        if (byok.apiShape === "openai" || byok.apiShape === "anthropic") {
          config.models.chat.byokApiShape = byok.apiShape;
        }
        explicitModelConfig = true;
      }
    }
    if (fileConfig.hybrid && typeof fileConfig.hybrid === "object") {
      const hybrid = fileConfig.hybrid;
      config.hybrid = hybrid;
    }
    if (fileConfig.maxIterations) config.maxIterations = fileConfig.maxIterations;
    if (fileConfig.useRepoMap !== void 0) config.useRepoMap = fileConfig.useRepoMap;
    if (fileConfig.temperature !== void 0) config.models.chat.temperature = fileConfig.temperature;
    if (fileConfig.renderMarkdown !== void 0) config.renderMarkdown = fileConfig.renderMarkdown;
    if (fileConfig.enableMemory !== void 0) config.enableMemory = fileConfig.enableMemory;
    if (fileConfig.enableHooks !== void 0) config.enableHooks = fileConfig.enableHooks;
    if (fileConfig.permissionMode) config.permissionMode = fileConfig.permissionMode;
    if (fileConfig.accessMode !== void 0) config.accessMode = parseAccessMode(fileConfig.accessMode);
    if (fileConfig.workspaceMode !== void 0) config.workspaceMode = parseWorkspaceMode(fileConfig.workspaceMode);
    if (fileConfig.shellTimeout) config.shellTimeout = fileConfig.shellTimeout;
    if (fileConfig.theme) config.theme = fileConfig.theme;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Cannot read ${configPath}: ${error.message}`);
    }
  }
  if (process.env.NOTCH_ACCESS_MODE) config.accessMode = parseAccessMode(process.env.NOTCH_ACCESS_MODE);
  if (process.env.NOTCH_PROVIDER || process.env.NOTCH_MODEL) {
    config.models.chat = selectModel(config.models.chat, { provider: process.env.NOTCH_PROVIDER, model: process.env.NOTCH_MODEL });
    explicitModelConfig = true;
  }
  if (selection.provider || selection.model) {
    config.models.chat = selectModel(config.models.chat, selection);
    explicitModelConfig = true;
  }
  if (!explicitModelConfig) {
    const inferred = await inferDefaultProviderConfig();
    config.models.chat.model = inferred.modelRef;
    config.models.chat.byokProvider = void 0;
    if (inferred.baseUrl) config.models.chat.baseUrl = inferred.baseUrl;
    if (inferred.apiShape) config.models.chat.byokApiShape = inferred.apiShape;
  }
  const activeProviderId = config.models.chat.byokProvider ?? (typeof config.models.chat.model === "string" && isByokRef(config.models.chat.model) ? parseByokRef(config.models.chat.model).provider : void 0);
  const isOllamaProvider = activeProviderId === "ollama" || activeProviderId === "ollama-cloud" || activeProviderId === "ollama-anthropic";
  if (isOllamaProvider) {
    if (!config.models.chat.apiKey && !process.env.OLLAMA_API_KEY) {
      const ollamaCreds = await readOllamaCreds();
      if (ollamaCreds?.apiKey) {
        config.models.chat.apiKey = ollamaCreds.apiKey;
      }
    }
  }
  if (process.env.NOTCH_BASE_URL) {
    config.models.chat.baseUrl = process.env.NOTCH_BASE_URL;
  }
  if (process.env.NOTCH_API_KEY && !activeProviderId) {
    config.models.chat.apiKey = process.env.NOTCH_API_KEY;
  }
  if (config.models.chat.temperature !== void 0) {
    config.models.chat.temperature = Math.max(0, Math.min(2, config.models.chat.temperature));
  }
  config.maxIterations = Math.max(1, Math.min(100, config.maxIterations));
  config.models.chat = selectModel(config.models.chat, { baseUrl: selection.baseUrl, apiKey: selection.apiKey });
  return { ...config, ...overrides, workspaceMode: parseWorkspaceMode(overrides.workspaceMode ?? config.workspaceMode), projectRoot: config.projectRoot };
}
async function inferDefaultProviderConfig() {
  const providers = listByokProviders();
  const envMatch = providers.find((p) => p.apiKeyEnv && process.env[p.apiKeyEnv]);
  if (envMatch) return { modelRef: `${envMatch.id}/${envMatch.defaultModel}` };
  const synced = await loadSyncedByokKeys();
  if (synced) {
    const syncedMatch = providers.find((p) => {
      const key = synced.keys[p.id];
      return typeof key === "string" && key.length > 0;
    });
    if (syncedMatch) return { modelRef: `${syncedMatch.id}/${syncedMatch.defaultModel}` };
    if (synced.localEndpoint) {
      return {
        modelRef: "custom/local-model",
        baseUrl: synced.localEndpoint,
        apiShape: "openai"
      };
    }
  }
  const localOllama = await inferLocalOllamaModel();
  if (localOllama) return localOllama;
  const openrouter = findByokProvider("openrouter");
  if (openrouter) return { modelRef: `${openrouter.id}/${openrouter.defaultModel}` };
  const first = providers[0];
  return { modelRef: first ? `${first.id}/${first.defaultModel}` : DEFAULT_MODEL.model };
}
async function inferLocalOllamaModel() {
  try {
    const baseUrl = ollamaRoot();
    const rows = await listModels(baseUrl, { timeoutMs: 300 });
    const capabilities = await Promise.all(rows.map((row) => showModel(row.name, baseUrl, { timeoutMs: 500 }).catch(() => null)));
    const modelName = rows.find((_, index) => capabilities[index]?.capabilities?.includes("tools"))?.name;
    if (!modelName) return null;
    return {
      modelRef: `ollama/${modelName}`,
      baseUrl: ollamaChatUrl(baseUrl)
    };
  } catch {
    return null;
  }
}
async function persistConfigPatch(projectRoot, patch) {
  const configPath = path4.resolve(projectRoot, ".notch.json");
  let current = {};
  try {
    const raw = await fs4.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed;
    } else {
      throw new Error(".notch.json must contain a JSON object.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const merged = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete merged[k];
    else merged[k] = v;
  }
  if (patch.provider && !Object.hasOwn(patch, "hybrid") && current.hybrid && typeof current.hybrid === "object" && !Array.isArray(current.hybrid)) {
    merged.hybrid = { ...current.hybrid, enabled: false };
  }
  const serialised = JSON.stringify(merged, null, 2) + "\n";
  const tmpPath = `${configPath}.tmp`;
  await fs4.writeFile(tmpPath, serialised, "utf-8");
  await fs4.rename(tmpPath, configPath);
  return merged;
}

export {
  recordShadowUsage,
  resolveModel,
  recordInteractiveApproval,
  runPermissionCheck,
  pushTailNotification,
  recordAutoModeDenial,
  createHandlerContext,
  loadPermissions,
  checkPermission,
  checkAccess,
  isBuiltInReadTool,
  openRouterTaskContext,
  acquireProjectLease,
  withSharedWorker,
  withTaskWorkspace,
  selectModel,
  loadConfig,
  persistConfigPatch
};
