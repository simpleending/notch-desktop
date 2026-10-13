#!/usr/bin/env node

/**
 * Notch CLI — AI-Powered Coding Assistant
 *
 * Terminal-based coding agent by Driftrail. Bring any supported provider,
 * model gateway, or local OpenAI-compatible server.
 *
 * Usage:
 *   notch                        # Start interactive REPL
 *   notch "fix the bug"          # One-shot mode
 *   notch --model openrouter/anthropic/claude-sonnet-4.6
 *   notch init                   # Scaffold .notch.json and .notch.md
 *   notch --resume               # Resume last session
 *   cat file | notch "explain"   # Pipe mode
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { createCliProgram } from './cli-options.js';
import { checkAccess, parseAccessMode } from './permissions/access.js';
import chalk from 'chalk';
import ora from './ui/spinner.js';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';
import * as nodePath from 'node:path';
import type { ModelMessage, LanguageModel } from 'ai';

import { loadConfig, persistConfigPatch, selectModel, type NotchConfig } from './config.js';
import { ollamaContextLength } from './providers/ollama-transport.js';
import {
  resolveModel,
  validateConfig,
  MODEL_CATALOG,
  isValidModel,
  modelSupportsImages,
  MissingApiKeyError,
  findByokProvider,
  listByokProviders,
  isByokRef,
  parseByokRef,
  ByokMissingApiKeyError,
  ByokMissingBaseUrlError,
} from './providers/index.js';
import {
  loadImage,
  imageToContentBlock,
  extractImageRefs,
  formatAttachmentStatus,
  isImageLoadError,
  type ImageAttachment,
  type ImageContentBlock,
} from './ui/image-input.js';
import type { NotchModelId, ByokProvider } from './providers/index.js';
import type { OpenRouterCodingModel, OpenRouterCodingResult } from './providers/openrouter-models.js';
import { runAgentLoop, buildSystemPrompt, CheckpointManager, UsageTracker, bindHybridLoop, type HybridConfig } from './agent/index.js';
import { buildRepoMap, condensedRepoMap } from './context/repo-map.js';
import { resolveReferences, formatReferences } from './context/references.js';
import { initMCPServers, disconnectMCPServers, type ToolContext } from './tools/index.js';
import { printBanner, printWordmark, printMantis } from './ui/banner.js';
import { renderMarkdown } from './ui/markdown.js';
import { renderContextMeter, compactContextIndicator } from './ui/context-meter.js';
import { checkForUpdates, isValidChannel, isNewer as isNewerVersion, loadCache as loadUpdateCache, type UpdateChannel } from './ui/update-checker.js';
import { runUpdateCli } from './commands/update.js';
import { loadPermissions, checkPermission, formatPermissions, type PermissionConfig } from './permissions/index.js';
import {
  setCurrentSurface,
  drainTailNotifications,
  type Surface,
} from './permissions/dispatcher.js';
import { loadHooks, runHooks, startFileWatcher, type HookConfig } from './hooks/index.js';
import {
  loadMemories,
  saveMemory,
  searchMemories,
  deleteMemory,
  compactMemoriesWithModel,
  extractMemoryCandidate,
  getMemoryPromptStats,
  getMemorySummaryPath,
  rememberUserPreference,
  type MemoryType,
} from './memory/index.js';
import { estimateTokens } from './agent/compression.js';
import { withRetry } from './agent/retry.js';
import { saveSession, loadSession, loadLastSession, listSessions, exportSession, Rollout, generateSessionId, listRollouts, readRollout, rebuildMessagesFromRollout, hasActiveStream, readIndex } from './session/index.js';
import { initProject } from './init.js';
import { login, loadCredentials, clearCredentials } from './auth.js';
import { unifiedDiff } from './tools/diff-preview.js';
import { parsePatch } from './tools/apply-patch.js';
import { JsonEmitter } from './ui/json-events.js';
import { loadOutputSchema, schemaInstructions, validateStructuredOutput } from './ui/output-schema.js';
import { theme, themeId, setTheme, isValidTheme, formatThemeList, THEME_IDS, type ThemeId } from './ui/themes.js';
import { generatePlan, formatPlan, advancePlan, currentStepPrompt, isPlanComplete, type Plan } from './agent/planner.js';
import { spawnSubagent, nextSubagentId, type SubagentType } from './agent/subagent.js';
import { COORDINATOR_SYSTEM_PROMPT, isCoordinatorModeEnv } from './coordinator/index.js';
import { CostTracker, formatCostRates } from './agent/cost.js';
import { dispatchCommand, registeredCommandNames, type CommandContext } from './commands/index.js';
import { pluginManager } from './plugins/index.js';
import { isSandboxEnabled } from './commands/sandbox.js';
import { getSessionName } from './commands/rename.js';
import { stopActiveLoop } from './commands/loop.js';
import { buildCompleter } from './ui/completions.js';
import {
  generateRalphPlan, runRalphLoop, savePlan, loadPlan, deletePlan,
  formatRalphStatus, type RalphPlan,
} from './agent/ralph.js';
import {
  startAutoDreamDaemon,
  stopAutoDreamDaemon,
  resetAutoDreamIdle,
} from './services/autoDream/index.js';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const VERSION: string = _require('../package.json').version;

const program = createCliProgram(VERSION).parse(process.argv);

const opts = program.opts();
const promptArgs = program.args;
let stopRuntimeWatcher = () => {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Print the provider directory and exit (triggered by --list-providers).
 *
 * Shows id, label, env var, default model, and whether the env var is
 * currently set in the user's shell so they can spot misconfigured keys
 * at a glance.
 */
function printByokProviderList(): void {
  const t = theme();
  console.log(t.dim('\n  Model providers (point --provider at any of these):\n'));
  const providers = listByokProviders();
  const idWidth = Math.max(12, ...providers.map((p) => p.id.length));
  const labelWidth = Math.max(20, ...providers.map((p) => p.label.length));
  const envWidth = Math.max(22, ...providers.map((p) => (p.apiKeyEnv || '(none)').length));
  const keyWidth = 7;
  const header =
    `  ${'id'.padEnd(idWidth)} ${'label'.padEnd(labelWidth)} ` +
    `${'env var'.padEnd(envWidth)} ${'key'.padEnd(keyWidth)} default model`;
  console.log(t.dim(header));
  console.log(t.dim(`  ${'-'.repeat(header.length - 2)}`));
  for (const p of providers) {
    const keyLabel = p.apiKeyEnv
      ? process.env[p.apiKeyEnv]
        ? 'set'
        : p.fallbackApiKey
          ? 'local'
          : 'missing'
      : 'none';
    const paddedKey = keyLabel.padEnd(keyWidth);
    const keyPresent =
      keyLabel === 'set' ? t.success(paddedKey)
        : keyLabel === 'missing' ? t.dim(paddedKey)
          : t.dim(paddedKey);
    const envDisplay = p.apiKeyEnv || '(none)';
    console.log(
      `  ${t.brand(p.id.padEnd(idWidth))} ${p.label.padEnd(labelWidth)} ` +
      `${envDisplay.padEnd(envWidth)} ${keyPresent} ${t.dim(p.defaultModel || '—')}`,
    );
  }
  console.log('');
  console.log(t.dim('  Use it like:'));
  console.log(t.dim('    notch setup --provider openrouter   # store a key locally'));
  console.log(t.dim('    export OPENROUTER_API_KEY=sk-or-...'));
  console.log(t.dim('    notch --provider openrouter --model anthropic/claude-sonnet-4.6'));
  console.log(t.dim('    notch --model openrouter/anthropic/claude-sonnet-4.6   # equivalent'));
  console.log(t.dim('    notch --provider custom --base-url http://localhost:8000/v1 --model my-model'));
  console.log('');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function sourceLabel(result: OpenRouterCodingResult): string {
  if (result.source === 'live') return 'live from OpenRouter';
  if (result.source === 'cache') return 'cached OpenRouter response';
  return 'bundled fallback';
}

async function printOpenRouterCodingModels(limit = 7): Promise<void> {
  const t = theme();
  const spinner = process.stderr.isTTY ? ora('Fetching OpenRouter coding models...').start() : null;
  const {
    getOpenRouterCodingModels,
    formatOpenRouterPricePerMillion,
    formatContextLength,
  } = await import('./providers/openrouter-models.js');

  const result = await getOpenRouterCodingModels({ limit });
  spinner?.stop();

  console.log(t.dim(`\n  OpenRouter coding models (${sourceLabel(result)})\n`));
  const header =
    `  ${'#'.padStart(2)}  ${'model ref'.padEnd(44)} ${'context'.padEnd(8)} ${'input/out per 1M'.padEnd(18)} tool`;
  console.log(t.dim(header));
  console.log(t.dim(`  ${'-'.repeat(header.length - 2)}`));

  result.models.forEach((model, index) => {
    const price =
      `${formatOpenRouterPricePerMillion(model.promptPrice)}/${formatOpenRouterPricePerMillion(model.completionPrice)}`;
    const tool = model.supportsTools ? t.success('yes') : t.dim('no');
    console.log(
      `  ${String(index + 1).padStart(2)}  ` +
      `${t.brand(truncate(model.modelRef, 44).padEnd(44))} ` +
      `${formatContextLength(model.contextLength).padEnd(8)} ` +
      `${price.padEnd(18)} ${tool}  ${t.dim(truncate(model.name, 34))}`,
    );
  });

  if (result.warning) {
    console.log(t.dim(`\n  Note: live refresh failed (${truncate(result.warning, 100)}).`));
  }
  console.log(t.dim('\n  Use one with:'));
  console.log(t.dim(`    notch --model ${result.models[0]?.modelRef ?? 'openrouter/anthropic/claude-sonnet-4.6'}`));
  console.log(t.dim('    /model coding        # pick inside the REPL'));
  console.log('');
}

async function quietlyCaptureMemoryCue(input: string, modelForCompaction?: LanguageModel): Promise<void> {
  const candidate = extractMemoryCandidate(input);
  if (!candidate) return;

  try {
    await rememberUserPreference(candidate);
    if (modelForCompaction) {
      const stats = await getMemoryPromptStats();
      if (stats.overBudget) {
        await compactMemoriesWithModel(modelForCompaction).catch(() => undefined);
      }
    }
  } catch {
    // Memory is opportunistic. Never interrupt the main task for it.
  }
}

/**
 * Is the active chat config pointing at an external/local provider?
 *
 * Returns the matching provider or undefined for legacy catalog configs.
 */
function activeByokProvider(
  modelConfig: { model: string; byokProvider?: string },
): ByokProvider | undefined {
  if (modelConfig.byokProvider) return findByokProvider(modelConfig.byokProvider);
  if (typeof modelConfig.model === 'string' && isByokRef(modelConfig.model)) {
    const { provider } = parseByokRef(modelConfig.model);
    return findByokProvider(provider);
  }
  return undefined;
}

/**
 * Merge a provider choice into `.notch.json` so the REPL selection survives
 * restarts. Failures are swallowed — the session has already been updated
 * in memory, and some projects intentionally keep the config read-only.
 */
async function persistByokChoice(
  projectRoot: string,
  providerId: string,
  defaultModel: string,
  selected: import('./providers/types.js').ModelConfig,
): Promise<void> {
  await persistConfigPatch(projectRoot, {
    provider: { provider: providerId === '__custom__' ? 'custom' : providerId, model: defaultModel,
      ...(selected.baseUrl ? { baseUrl: selected.baseUrl } : {}),
      ...(selected.byokApiShape ? { apiShape: selected.byokApiShape } : {}),
      ...(selected.contextWindow ? { contextWindow: selected.contextWindow } : {}),
      ...(selected.ollamaBatch ? { ollamaBatch: selected.ollamaBatch } : {}),
      ...(selected.sourceRepo ? { sourceRepo: selected.sourceRepo } : {}),
      ...(selected.byokHeaders || selected.headers ? { headers: { ...selected.headers, ...selected.byokHeaders } } : {}),
    }, byok: undefined, model: undefined, baseUrl: undefined, apiKey: undefined,
  });
}

/**
 * Best-effort context window for the current chat model.
 *
 * Legacy catalog models pull from the catalog. Provider refs fall back to 128K, which
 * covers the Llama-4 / Claude-4 / GPT-5 class — generous enough that our
 * compactor won't compress prematurely but small enough to keep a safety
 * margin on Groq-hosted 32K models.
 */
function activeContextWindow(
  modelConfig: { model: string; byokProvider?: string; contextWindow?: number },
): number {
  if (activeByokProvider(modelConfig)?.id === 'ollama') return ollamaContextLength(modelConfig.contextWindow);
  if (modelConfig.contextWindow) return modelConfig.contextWindow;
  if (activeByokProvider(modelConfig)) return 128_000;
  const id = modelConfig.model as NotchModelId;
  return MODEL_CATALOG[id]?.contextWindow ?? 128_000;
}

/** Outcome of an interactive picker selection. */
type PickerChoice =
  | { kind: 'byok'; provider: ByokProvider; modelRef: string; label?: string };

/** A numbered picker leaves terminal history and cursor control to readline. */
async function interactiveModelPicker(
  activeModel: NotchModelId | string,
  ask: (question: string) => Promise<string>,
): Promise<PickerChoice | null> {
  const choices: PickerChoice[] = [];
  const ollama = findByokProvider('ollama')!;
  try {
    const { listModels } = await import('./providers/ollama.js');
    const rows = await listModels();
    for (const row of rows) choices.push({ kind: 'byok', provider: ollama, modelRef: `ollama/${row.name}` });
  } catch { /* An offline local server does not prevent choosing a remote provider. */ }
  const openrouter = findByokProvider('openrouter')!;
  try {
    const { getOpenRouterCodingModels } = await import('./providers/openrouter-models.js');
    const { models } = await getOpenRouterCodingModels({ limit: 7, preferCache: true, timeoutMs: 3000 });
    for (const row of models) choices.push({ kind: 'byok', provider: openrouter, modelRef: row.modelRef, label: row.name });
  } catch { choices.push({ kind: 'byok', provider: openrouter, modelRef: `openrouter/${openrouter.defaultModel}` }); }
  const supportsMlx = process.platform === 'darwin' && (await import('./providers/local-models.js').then(module => module.detectLocalHardware())).mlxSupported;
  for (const provider of listByokProviders().filter(p => p.id !== 'ollama' && p.id !== 'openrouter' && p.defaultModel && (p.id !== 'mlx' || supportsMlx))) {
    choices.push({ kind: 'byok', provider, modelRef: `${provider.id}/${provider.defaultModel}` });
  }
  console.log('\n  Choose a model; /model provider/model accepts any model id.\n');
  choices.forEach((choice, i) => console.log(`  ${i + 1}. ${choice.modelRef}${choice.modelRef === activeModel ? ' (current)' : ''}`));
  const answer = (await ask('\nModel number, provider/model, or Enter to cancel: ')).trim();
  if (!answer) return null;
  const selected = choices[Number(answer) - 1];
  if (selected) return selected;
  if (isByokRef(answer)) {
    const { provider } = parseByokRef(answer);
    return { kind: 'byok', provider: findByokProvider(provider)!, modelRef: answer };
  }
  console.log(chalk.yellow('  Choose one of the listed numbers or a provider/model id.\n'));
  return null;
}

function printHelp() {
  console.log(chalk.gray(`
  Commands:
    /model              \u2014 Pick a provider and default model
    /model coding       \u2014 Pick from current OpenRouter coding models
    /models coding      \u2014 List current OpenRouter coding models
    /models install     \u2014 Download a local model sized to this computer
    /models recommend   \u2014 Show Hugging Face choices and memory estimates
    /models unload      \u2014 Release the active local model's memory
    /model <ref>        \u2014 Switch model: /model openrouter/anthropic/claude-sonnet-4.6
    /setup-keys         \u2014 Store provider API keys locally
    /sync-keys          \u2014 Pull provider keys you added on freesyntax.dev
    /providers          \u2014 List built-in providers and whether their keys are set
    /status             \u2014 Check active provider health
    /undo               \u2014 Undo last file changes
    /usage              \u2014 Show token usage + context meter
    /cost               \u2014 Show estimated session cost
    /compact            \u2014 Compress conversation history
    /diff               \u2014 Show all file changes this session
    /export [path]      \u2014 Export conversation to markdown
    /save               \u2014 Save current session
    /sessions           \u2014 List saved sessions
    /resume [id]        \u2014 Resume a saved session
    /search <query>     \u2014 Search conversation history

  Planning & Agents:
    /plan <task>        \u2014 Generate a step-by-step plan
    /plan approve       \u2014 Approve and execute the plan
    /plan cancel        \u2014 Discard the current plan
    /agent <task>       \u2014 Spawn a background subagent

  Memory & Config:
    /memory             \u2014 List saved memories
    /remember <text>    \u2014 Save durable user preference/context
    /memory search <q>  \u2014 Search memories
    /memory compact     \u2014 Summarize local memories to a bounded file
    /memory clear       \u2014 Delete all memories
    /permissions        \u2014 Show current permission config
    /yolo               \u2014 Toggle YOLO mode: auto-allow all tool calls (persists)

  Ralph Wiggum Mode (autonomous):
    /ralph plan <goal>  \u2014 Generate task plan for a goal
    /ralph run          \u2014 Execute tasks (fresh context per task)
    /ralph status       \u2014 Show plan progress
    /ralph clear        \u2014 Discard plan

  Git Workflow:
    /commit [msg]       \u2014 Smart commit (AI-generated message)
    /pr [title]         \u2014 Create PR with AI-generated summary
    /worktree <cmd>     \u2014 Manage git worktrees (create/switch/remove)

  Utilities:
    /doctor             \u2014 Diagnose installation health
    /copy               \u2014 Copy last response to clipboard
    /btw <question>     \u2014 Side question (won't affect context)
    /security-review    \u2014 Review recent changes for vulnerabilities
    /loop <int> <cmd>   \u2014 Run a command on interval (e.g. /loop 5m /status)
    /batch <task>       \u2014 Apply a task across multiple files in parallel
    /tasks              \u2014 Show agent task list
    /insights           \u2014 Session analytics and tool usage
    /rewind [turn]      \u2014 Rewind conversation to a previous turn
    /rename <name>      \u2014 Name this session
    /debug [on|off]     \u2014 Toggle debug logging
    /sandbox            \u2014 Toggle sandbox mode (read-only)

  Plugins:
    /plugin list        \u2014 List installed plugins
    /plugin install <n> \u2014 Install a plugin (npm package or git URL)
    /plugin remove <n>  \u2014 Remove a plugin

  Other:
    /branch             \u2014 Fork conversation at this point
    /branches           \u2014 List conversation branches
    /theme              \u2014 List available themes
    /theme <name>       \u2014 Switch color theme
    /mascot             \u2014 Show the Notch mantis
    /clear              \u2014 Clear conversation history
    /quit, /exit, /q    \u2014 Exit Notch (shows session usage)
    /help               \u2014 Show this help

  Inline References:
    @path/to/file       \u2014 Inject file contents into prompt
    @https://url.com    \u2014 Fetch and inject URL contents
    @*.ts               \u2014 Inject all matching files (glob)

  Pipe Mode:
    cat file | notch "explain this"
  `));
}

/**
 * Read piped stdin if available.
 */
async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim() || null));
    // Timeout after 100ms if nothing is piped
    setTimeout(() => {
      if (!data) resolve(null);
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --list-providers is a pre-flight flag: print the BYOK directory and
  // exit before any auth / config work. Keeps it usable even when the
  // user hasn't logged in yet.
  if (opts.listProviders) {
    printByokProviderList();
    return;
  }
  if (opts.listCodingModels) {
    await printOpenRouterCodingModels(7);
    return;
  }

  // Handle subcommands
  if (promptArgs[0] === 'login') {
    const spinner = ora('Opening browser...').start();
    try {
      spinner.stop();
      const creds = await login();
      console.log(chalk.green(`\n  ✓ Signed in as ${creds.email}`));
      console.log(chalk.gray(`  API key stored in ${(await import('./auth.js')).getCredentialsPath()}`));

      // Opportunistically pull provider keys the user added on freesyntax.dev
      // so the CLI can hit OpenAI / Anthropic / OpenRouter / etc. without
      // a second manual setup. Failure is non-fatal.
      try {
        const { syncByokKeys } = await import('./auth.js');
        const synced = await syncByokKeys(creds.token);
        const providerCount = Object.keys(synced.keys).length;
        if (providerCount > 0) {
          console.log(chalk.gray(
            `  Synced ${providerCount} provider key(s) from freesyntax.dev → ${(await import('./auth.js')).getByokSyncPath()}`,
          ));
        } else {
          console.log(chalk.gray(
            `  No provider keys on your profile yet — add them at freesyntax.dev/settings/keys then run ${chalk.white('notch sync-keys')}.`,
          ));
        }
      } catch (syncErr) {
        // Surface the failure but don't abort the login. Most common
        // cause: the user signed in while offline or the website is
        // temporarily unreachable.
        console.log(chalk.yellow(
          `  (provider key sync skipped: ${(syncErr as Error).message.slice(0, 120)})`,
        ));
      }
      console.log('');
    } catch (err) {
      spinner.stop();
      console.error(chalk.red(`\n  Login failed: ${(err as Error).message}\n`));
      process.exit(1);
    }
    return;
  }

  // `notch sync-keys` — standalone command for pulling provider keys after
  // the user adds or rotates credentials on freesyntax.dev. Doesn't
  // re-run the browser login.
  if (promptArgs[0] === 'sync-keys') {
    const creds = await loadCredentials();
    if (!creds) {
      console.log(chalk.gray('\n  Not signed in. Run: notch login\n'));
      return;
    }
    const spinner = ora('Pulling provider keys from freesyntax.dev...').start();
    try {
      const { syncByokKeys, getByokSyncPath } = await import('./auth.js');
      const synced = await syncByokKeys(creds.token);
      spinner.stop();
      const providers = Object.keys(synced.keys);
      if (providers.length === 0) {
        console.log(chalk.gray(`\n  No provider keys on your profile yet.`));
        console.log(chalk.gray(`  Add them at ${chalk.white('https://freesyntax.dev/settings/keys')} then rerun.\n`));
      } else {
        console.log(chalk.green(`\n  ✓ Synced ${providers.length} provider key(s): ${providers.join(', ')}`));
        console.log(chalk.gray(`  Cached at ${getByokSyncPath()}\n`));
      }
    } catch (err) {
      spinner.stop();
      console.error(chalk.red(`\n  Key sync failed: ${(err as Error).message}\n`));
      process.exit(1);
    }
    return;
  }

  if (
    (promptArgs[0] === 'models' && (promptArgs[1] === 'coding' || promptArgs[1] === 'openrouter')) ||
    (promptArgs[0] === 'openrouter' && (promptArgs[1] === 'models' || promptArgs[1] === 'coding'))
  ) {
    await printOpenRouterCodingModels(7);
    return;
  }

  if (promptArgs[0] === 'setup' || promptArgs[0] === 'setup-keys' || promptArgs[0] === 'keys') {
    const providerId = opts.provider ?? promptArgs[1];
    const { runProviderKeySetup } = await import('./commands/provider-key-setup.js');
    const code = await runProviderKeySetup({ providerId });
    process.exitCode = code;
    return;
  }

  if (promptArgs[0] === 'remember') {
    const text = promptArgs.slice(1).join(' ').trim();
    if (!text) {
      console.log(chalk.gray('\n  Usage: notch remember <preference or durable context>\n'));
      return;
    }
    await rememberUserPreference(text);
    console.log(chalk.green('\n  Remembered.\n'));
    return;
  }

  if (promptArgs[0] === 'logout') {
    const creds = await loadCredentials();
    if (!creds) {
      console.log(chalk.gray('\n  Not signed in.\n'));
    } else {
      await clearCredentials();
      console.log(chalk.green(`\n  ✓ Signed out (${creds.email})\n`));
    }
    return;
  }

  if (promptArgs[0] === 'whoami') {
    const creds = await loadCredentials();
    if (!creds) {
      console.log(chalk.gray('\n  Not signed in. Run: notch login\n'));
    } else {
      const keyPreview = `${creds.token.slice(0, 12)}...`;
      console.log(chalk.gray(`\n  Signed in as ${chalk.white(creds.email)}`));
      console.log(chalk.gray(`  Key: ${keyPreview}`));
      console.log(chalk.gray(`  Since: ${new Date(creds.createdAt).toLocaleDateString()}\n`));
    }
    return;
  }

  if (promptArgs[0] === 'mcp-serve' || promptArgs[0] === 'mcp-server') {
    const { runMcpServer } = await import('./mcp/server.js');
    await runMcpServer({
      cwd: opts.cwd ?? process.cwd(),
      version: VERSION,
      includePlugins: !promptArgs.includes('--no-plugins'),
    });
    return;
  }

  if (promptArgs[0] === 'init') {
    const subArgs = promptArgs.slice(1);
    const initOpts: Parameters<typeof initProject>[1] = {};
    if (subArgs.includes('--all')) initOpts.all = true;
    if (subArgs.includes('--minimal')) initOpts.minimal = true;
    const featuresFlag = subArgs.find((a) => a.startsWith('--features='));
    if (featuresFlag) initOpts.features = featuresFlag.split('=')[1]!.split(',').map((s) => s.trim()).filter(Boolean);
    await initProject(opts.cwd ?? process.cwd(), initOpts);
    return;
  }

  // notch update [--check] [--channel <name>]
  if (promptArgs[0] === 'update') {
    await runUpdateCli(promptArgs.slice(1));
    return;
  }

  // `notch ollama ...` is handled by the pre-commander shim above; this
  // branch exists only to keep `help` output consistent when someone
  // pipes an `ollama` arg through internal dispatch.

  // notch ralph <plan|run|status>
  if (promptArgs[0] === 'ralph') {
    await handleRalphSubcommand(promptArgs.slice(1), opts);
    return;
  }

  // Load config
  const configOverrides: Partial<NotchConfig> = {};
  if (opts.cwd) configOverrides.projectRoot = opts.cwd;
  if (opts.yes) configOverrides.autoConfirm = true;
  if (opts.trust) configOverrides.permissionMode = 'trust';
  if (opts.maxIterations) configOverrides.maxIterations = parseInt(opts.maxIterations, 10);
  if (opts.repoMap === false) configOverrides.useRepoMap = false;
  if (opts.markdown === false) configOverrides.renderMarkdown = false;
  if (opts.theme) configOverrides.theme = opts.theme as ThemeId;

  const config = await loadConfig(configOverrides, opts);
  if (opts.access && opts.trust && opts.access !== 'full-access') {
    throw new Error('--trust conflicts with --access; choose one access profile.');
  }
  let accessMode = parseAccessMode(opts.access ?? (opts.trust ? 'full-access' : config.accessMode)
    ?? (config.permissionMode === 'trust' ? 'full-access' : 'approve'));

  // Apply theme
  if (config.theme && isValidTheme(config.theme)) {
    setTheme(config.theme);
  }

  // Resolve model — `activeModelId` is the raw model string (Notch id or
  // provider ref). `activeByok` is populated when we're talking to a
  // provider backend, and downstream code uses it to skip legacy plumbing
  // (Modal health probes, context-window lookup, etc.).
  let activeModelId: NotchModelId | string = config.models.chat.model;
  const activeByok = activeByokProvider(config.models.chat);
  if (activeByok?.id === 'ollama' && config.models.chat.baseUrl?.replace(/\/v1\/?$/, '') === 'http://127.0.0.1:11436') {
    const { managedOllama } = await import('./providers/ollama-runtime.js');
    await managedOllama();
  }
  if (activeByok?.id === 'mlx') {
    const { startMlx } = await import('./providers/local-runner.js');
    config.models.chat.baseUrl = await startMlx(isByokRef(activeModelId) ? parseByokRef(activeModelId).model : activeModelId);
  }
  let model: LanguageModel;
  // Hybrid routing: when `.notch.json` has a `hybrid` block with enabled:true
  // and both primary + fallback specs, every `runAgentLoop` call is replaced
  // with the hybrid wrapper that escalates on give-up signals.
  let runLoop: typeof runAgentLoop = runAgentLoop;
  if (config.hybrid?.enabled && config.hybrid.primary && config.hybrid.fallback) {
    try {
      const hyb = config.hybrid;
      const primarySpec = hyb.primary!;
      const fallbackSpec = hyb.fallback!;
      const buildSide = (side: NonNullable<typeof hyb.primary>): LanguageModel => {
        const providerId = side.provider === 'custom' ? '__custom__' : side.provider!;
        return resolveModel({
          model: side.model ?? '',
          baseUrl: side.baseUrl,
          byokProvider: providerId,
          byokHeaders: side.headers,
          byokApiShape: side.apiShape,
        });
      };
      const hybridCfg: HybridConfig = {
        enabled: true,
        primary: () => buildSide(primarySpec),
        fallback: () => buildSide(fallbackSpec),
        maxFallbacks: hyb.maxFallbacks,
        onEscalate: (reason) => {
          console.log(chalk.yellow(`  ↑ hybrid: escalated (${reason})`));
        },
      };
      runLoop = bindHybridLoop(hybridCfg);
    } catch (err: unknown) {
      console.warn(chalk.yellow(`  ! Hybrid routing disabled: ${(err as Error).message}`));
    }
  }
  try {
    model = resolveModel(config.models.chat);
  } catch (err) {
    if (err instanceof ByokMissingBaseUrlError) {
      printWordmark(VERSION);
      console.log(chalk.red(`  ${err.message}\n`));
      process.exit(1);
    }
    if (err instanceof ByokMissingApiKeyError) {
      printWordmark(VERSION);
      const p = err.provider;
      console.log(`  To use ${p.label} you need an API key.`);
      console.log('');
      if (p.apiKeyEnv) {
        console.log('  \x1b[1mOption 1:\x1b[0m Set the env var');
        console.log(`    \x1b[33m$ export ${p.apiKeyEnv}=your-key-here\x1b[0m`);
        console.log('');
      }
      console.log('  \x1b[1mOption 2:\x1b[0m Pass it inline');
      console.log('    \x1b[33m$ notch --api-key your-key-here\x1b[0m');
      console.log('');
      console.log(`  Base URL: \x1b[4m${p.baseUrl || '(--base-url required)'}\x1b[0m`);
      console.log('');
      process.exit(1);
    }
    if (err instanceof MissingApiKeyError) {
      printWordmark(VERSION);
      console.log('  To get started, you need a Notch API key.');
      console.log('');
      console.log('  \x1b[1mOption 1:\x1b[0m Log in via browser (recommended)');
      console.log('    \x1b[33m$ notch login\x1b[0m');
      console.log('');
      console.log('  \x1b[1mOption 2:\x1b[0m Set your API key directly');
      console.log('    \x1b[33m$ export NOTCH_API_KEY=your-key-here\x1b[0m');
      console.log('');
      console.log('  \x1b[1mOption 3:\x1b[0m Pass it inline');
      console.log('    \x1b[33m$ notch --api-key your-key-here\x1b[0m');
      console.log('');
      console.log('  \x1b[1mOr:\x1b[0m Use any provider key (OpenAI, Anthropic, OpenRouter, ...)');
      console.log('    \x1b[33m$ notch --list-providers\x1b[0m');
      console.log('    \x1b[33m$ notch --model openrouter/anthropic/claude-sonnet-4.6\x1b[0m');
      console.log('');
      console.log('  Get your Notch key at: \x1b[4mhttps://freesyntax.dev/settings\x1b[0m');
      console.log('');
      process.exit(0);
    }
    throw err;
  }
  // For the banner etc we need a NotchModelInfo-shaped object. BYOK pretends
  // to be a synthesized "virtual" entry that keeps printBanner happy without
  // polluting MODEL_CATALOG.
  const info = activeByok
    ? {
        id: activeModelId as NotchModelId,
        label: `${activeByok.label}`,
        size: 'provider',
        gpu: activeByok.id,
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        baseUrl: activeByok.baseUrl,
      }
    : MODEL_CATALOG[activeModelId as NotchModelId];

  // JSONL event stream (activated by --json; suppresses banner/spinners on stdout)
  const jsonMode = !!opts.json;
  const events = new JsonEmitter(jsonMode);

  if (promptArgs[0] === 'memory' && promptArgs[1] === 'compact') {
    const spinner = jsonMode ? null : ora('Compacting local memory...').start();
    try {
      const result = await compactMemoriesWithModel(model);
      spinner?.succeed(`Compacted ${result.rawCount} memories into ${result.summaryChars} chars`);
      if (!jsonMode) console.log(chalk.gray(`  Summary: ${result.summaryPath}\n`));
      else events.emit({ type: 'memory-compact', result } as any);
      return;
    } catch (err) {
      spinner?.fail(`Memory compact failed: ${(err as Error).message}`);
      if (jsonMode) events.emit({ type: 'error', message: (err as Error).message });
      process.exit(1);
    }
  }

  // Resolve update channel (CLI flag > env var > persisted config > 'latest').
  // The channel needs to be known both for the banner hint (from cache)
  // and for the background check.
  const envChannel = process.env.NOTCH_UPDATE_CHANNEL;
  let updateChannel: UpdateChannel | undefined;
  if (opts.updateChannel) {
    if (!isValidChannel(opts.updateChannel)) {
      console.warn(chalk.yellow(`  Unknown --update-channel: ${opts.updateChannel}. Valid: latest | next | beta.`));
    } else {
      updateChannel = opts.updateChannel as UpdateChannel;
    }
  } else if (envChannel && isValidChannel(envChannel)) {
    updateChannel = envChannel as UpdateChannel;
  }

  // Whether to poll npm on launch. Mirrors codex: opt-out via flag or env.
  // Commander's `--no-update` produces `opts.update === false`.
  const updatesEnabled =
    opts.update !== false && process.env.NOTCH_AUTO_UPDATE !== '0';

  // Print banner (skipped in JSON mode)
  if (!jsonMode) {
    // If we have a cached "newer-available" entry, surface it on the banner
    // so users see the pointer without a separate line below the art.
    let bannerHint: string | null = null;
    if (updatesEnabled) {
      try {
        const cache = await loadUpdateCache();
        if (cache?.latestVersion && isNewerVersion(cache.latestVersion, VERSION)) {
          bannerHint = cache.latestVersion;
        }
      } catch {
        // ignore
      }
    }
    printBanner(VERSION, info.label, config.models.chat.sourceRepo || info.id, info.size, config.projectRoot, {
      updateAvailable: bannerHint,
    });
  }

  // Kick off the real network check in the background. Don't await — it
  // must never block REPL startup. Inside a REPL we don't auto-restart
  // (that would obliterate the user's in-memory session) — the install
  // lands and the user sees "Updated to vX.Y.Z. Restart to use."
  if (updatesEnabled) {
    void checkForUpdates(VERSION, {
      channel: updateChannel,
      force: false,
      autoInstall: true,
    })
      .then((result) => {
        if (jsonMode) return;
        if (result.status === 'installed' && result.latest) {
          console.log(chalk.green(`  ↑ Updated to v${result.latest}. Restart Notch to use the new version.`));
        } else if (result.status === 'install-failed' && result.latest) {
          console.log(chalk.yellow(`  Update to v${result.latest} failed: ${result.message}. Try: notch update`));
        }
      })
      .catch(() => {
        // Swallow — logs have already captured the error.
      });
  }

  // Trust prompt shown when project has hooks from an unrecognised .notch.json.
  // Full access is an explicit grant. Other profiles require a real approval;
  // missing input must not authorize repository-provided shell commands.
  const startupPermissive = accessMode === 'full-access';
  const hookTrustPrompt = async (commands: string[]): Promise<boolean> => {
    if (startupPermissive) return true;
    if (!process.stdin.isTTY) return false;
    console.warn(chalk.yellow('\n⚠  This project contains hooks in .notch.json that will run shell commands:'));
    commands.forEach((cmd) => console.warn(chalk.gray(`   • ${cmd}`)));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.on('close', () => resolve(false));
      rl.question(chalk.yellow('\nAllow these hooks for this project? [y/N] '), (answer) => {
        const norm = answer.trim().toLowerCase();
        resolve(norm === 'y' || norm === 'yes');
        rl.close();
      });
    });
  };

  // Load permissions, hooks in parallel
  const [permissions, hookConfig] = await Promise.all([
    loadPermissions(config.projectRoot),
    config.enableHooks && accessMode !== 'read-only' ? loadHooks(config.projectRoot, hookTrustPrompt) : Promise.resolve({ hooks: [] } as HookConfig),
  ]);

  // Build repo map
  let repoMapStr = '';
  if (config.useRepoMap) {
    const spinner = ora('Mapping repository...').start();
    try {
      const repoMap = await buildRepoMap(config.projectRoot);
      repoMapStr = condensedRepoMap(repoMap);
      spinner.succeed(`Mapped ${repoMap.entries.length} source files`);
    } catch {
      spinner.warn('Could not build repo map');
    }
  }

  // Optional structured-output schema (used by headless callers)
  let outputSchema: Awaited<ReturnType<typeof loadOutputSchema>> | null = null;
  if (opts.outputSchema) {
    try {
      outputSchema = await loadOutputSchema(opts.outputSchema);
    } catch (err: any) {
      if (jsonMode) {
        events.emit({ type: 'error', message: `Failed to load output schema: ${err.message}` });
      } else {
        console.error(chalk.red(`  Failed to load output schema: ${err.message}`));
      }
      process.exit(1);
    }
  }

  // Coordinator mode — top-level agent restricted to orchestration.
  // Triggered by --coordinator flag or NOTCH_COORDINATOR=1 env var.
  const coordinatorMode: boolean = !!opts.coordinator || isCoordinatorModeEnv();

  if (coordinatorMode && !jsonMode) {
    console.log(
      chalk.green(
        '  Coordinator mode: enabled (Agent/SendMessage/TaskStop only — direct work delegated)',
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Permission surface selection
  // ---------------------------------------------------------------------------
  //
  // Chosen once at startup from CLI flags + pipe detection. The dispatcher's
  // per-surface handler decides allow/deny/prompt BEFORE the UI dialog opens.
  // See src/permissions/handlers/* for the full surface→handler map.
  //
  //   --json        → 'json-mode'   (no dialog possible — prompts become deny)
  //   --coordinator → 'coordinator' (write ops must be delegated to workers)
  //   --trust       → 'auto-mode'   (prompts implicit-allow + classifier)
  //   positional    → 'one-shot'    (prompts deny unless --yes)
  //   default       → 'interactive' (pass-through + 30s recent-approval cache)
  const hasPipe = !process.stdin.isTTY;
  const isOneShotInvocation = promptArgs.length > 0 || hasPipe;
  const permissionSurface: Surface = jsonMode
    ? 'json-mode'
    : coordinatorMode
      ? 'coordinator'
      : accessMode === 'full-access'
        ? 'interactive'
        : isOneShotInvocation
          ? 'one-shot'
          : 'interactive';
  setCurrentSurface(permissionSurface);
  if (!jsonMode && permissionSurface !== 'interactive') {
    console.log(chalk.gray(`  Permission surface: ${permissionSurface}`));
  }
  // Session id for the interactive handler's recently-approved cache.
  const permissionSessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // Checkpoint manager
  const checkpoints = new CheckpointManager();

  // Usage tracker
  const usage = new UsageTracker();

  // Ollama Cloud-specific usage tracker (segmented from the generic
  // UsageTracker so `/usage cloud` can report quota-facing totals without
  // mixing in Notch or local traffic).
  const { OllamaCloudUsageTracker } = await import('./ui/ollama-usage.js');
  const cloudUsage = new OllamaCloudUsageTracker();

  // Session state
  let sessionId: string | undefined;

  // Plan mode state
  let activePlan: Plan | null = null;
  let activePlanTask: string | null = null;

  // Conversation branches
  const branches = new Map<string, ModelMessage[]>();
  let currentBranch = 'main';

  // Cost tracker
  const costTracker = new CostTracker();

  // Load MCP servers (non-blocking — failures don't block startup)
  try {
    const configRaw = await fs.readFile(nodePath.resolve(config.projectRoot, '.notch.json'), 'utf-8').catch(() => '{}');
    const toolCount = await initMCPServers(JSON.parse(configRaw));
    if (toolCount > 0) {
      console.log(chalk.green(`  MCP: Connected (${toolCount} tools)`));
    }
  } catch {
    // No MCP config — that's fine
  }

  // Load plugins (non-blocking — failures don't block startup)
  try {
    const pluginCount = await pluginManager.init(config.projectRoot, (msg) => {
      console.log(chalk.gray(`  ${msg}`));
    });
    if (pluginCount > 0) {
      console.log(chalk.green(`  Plugins: ${pluginCount} loaded`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Plugin init failed: ${err.message}`));
  }

  // Guardian model - optional provider-backed second-opinion risk scorer.
  let guardianModel: LanguageModel | undefined;
  if (opts.guardian) {
    try {
      guardianModel = resolveModel({
        model: process.env.NOTCH_GUARDIAN_MODEL ?? config.models.chat.model,
        apiKey: config.models.chat.apiKey,
        baseUrl: process.env.NOTCH_GUARDIAN_BASE_URL,
        headers: config.models.chat.headers,
        byokProvider: config.models.chat.byokProvider,
        byokHeaders: config.models.chat.byokHeaders,
        byokApiShape: config.models.chat.byokApiShape,
      });
      if (!jsonMode) {
        console.log(chalk.green(`  Guardian: enabled (${process.env.NOTCH_GUARDIAN_MODEL ?? config.models.chat.model})`));
      }
    } catch (err: any) {
      if (!jsonMode) {
        console.log(chalk.yellow(`  Guardian: could not initialise (${err.message}) — running without it`));
      }
      guardianModel = undefined;
    }
  }

  // Tool context
  //
  // Approval grants require an explicit yes. Closed input and an empty answer
  // deny; full access is selected explicitly through the access profile.
  const isPermissive = () => accessMode === 'full-access' || (accessMode === 'approve' && config.autoConfirm);
  let interactiveRl: readline.Interface | undefined;
  const toolCtx: ToolContext = {
    cwd: config.projectRoot,
    accessMode,
    dryRun: !!opts.dryRun,
    requireConfirm: !isPermissive(),
    confirm: async (message: string) => {
      if (isPermissive()) return true;
      if (interactiveRl) return new Promise(resolve => {
        const rl = interactiveRl!;
        const closed = () => resolve(false);
        rl.once('close', closed);
        rl.question(`${message} (y/N) `, answer => {
          rl.removeListener('close', closed);
          resolve(/^(y|yes)$/i.test(answer.trim()));
        });
      });
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        rl.on('close', () => resolve(false));
        rl.question(`${message} (y/N) `, (answer) => {
          const norm = answer.trim().toLowerCase();
          resolve(norm === 'y' || norm === 'yes');
          rl.close();
        });
      });
    },
    log: (msg: string) => console.log(chalk.gray(`  ${msg}`)),
    guardianModel,
    coordinatorMode,
    coordinatorWorkerModel: coordinatorMode ? model : undefined,
    permissionSurface,
    permissionSessionId,
    autoConfirm: !!opts.yes || !!config.autoConfirm,
    checkPermission: (toolName, args) => checkAccess(accessMode, permissions, toolName, args),
    runHook: async (event, ctx) => {
      if (accessMode === 'read-only') return;
      if (event === 'pre-tool') {
        const args = ctx.args as Record<string, unknown>;
        if ((ctx.tool === 'write' || ctx.tool === 'edit') && typeof args.path === 'string') {
          await checkpoints.recordBefore(nodePath.resolve(toolCtx.cwd, args.path));
        }
        if (ctx.tool === 'apply_patch' && typeof args.input === 'string') {
          for (const action of parsePatch(args.input)) {
            await checkpoints.recordBefore(nodePath.resolve(toolCtx.cwd, action.target));
            if (action.kind === 'update' && action.moveTo) await checkpoints.recordBefore(nodePath.resolve(toolCtx.cwd, action.moveTo));
          }
        }
      }
      if (!config.enableHooks || hookConfig.hooks.length === 0) return;
      const { results } = await runHooks(hookConfig, event as any, {
        cwd: config.projectRoot,
        ...ctx,
      });
      for (const r of results) {
        if (!r.ok) {
          console.log(chalk.yellow(`  Hook failed (${r.hook.event}): ${r.error}`));
        }
      }
    },
  };

  // Build system prompt after MCP/plugins and permission surface are known so
  // the prompt carries the exact active tool schemas for this session.
  const baseSystemPrompt = await buildSystemPrompt(config.projectRoot, activeModelId, toolCtx);
  const systemPrompt = coordinatorMode
    ? [
        COORDINATOR_SYSTEM_PROMPT,
        '\n\n',
        baseSystemPrompt,
        repoMapStr ? `\n\n## Repository Map\n${repoMapStr}` : '',
        outputSchema ? `\n\n${schemaInstructions(outputSchema)}` : '',
      ].join('')
    : [
        baseSystemPrompt,
        repoMapStr ? `\n\n## Repository Map\n${repoMapStr}` : '',
        outputSchema ? `\n\n${schemaInstructions(outputSchema)}` : '',
      ].join('');

  // Fire session-start hooks
  await toolCtx.runHook?.('session-start', {});

  // Start file watcher for file-changed and config-change hooks
  const stopFileWatcher = startFileWatcher(config.projectRoot, hookConfig, (event, results) => {
    for (const r of results) {
      if (!r.ok) {
        console.log(chalk.yellow(`  Hook failed (${event}): ${r.error}`));
      }
    }
  });
  stopRuntimeWatcher = stopFileWatcher;

  // Message history — may be restored from a session
  const messages: ModelMessage[] = [];

  // Append-only rollout log for this session (resumable streams + /fork).
  // Opens a fresh rollout unless --resume was passed with a known id.
  const rollout = new Rollout(opts.session ?? generateSessionId());
  if (opts.session || opts.resume) {
    try {
      await rollout.openExisting();
      if (messages.length === 0) {
        const records = await readRollout(rollout.id);
        const rebuilt = rebuildMessagesFromRollout(records);
        if (rebuilt.length > 0) messages.push(...(rebuilt as ModelMessage[]));
      }
      if (hasActiveStream(await readIndex(rollout.id))) {
        console.log(chalk.yellow('  ⚠  Previous stream was interrupted mid-turn — resuming from rollout.\n'));
      }
    } catch {
      // No existing rollout for this id — fall through to new.
      await rollout.openNew({ project: config.projectRoot, model: activeModelId });
    }
  } else {
    await rollout.openNew({ project: config.projectRoot, model: activeModelId });
  }

  // Track last assistant response for /copy
  let lastAssistantResponse = '';

  // Resume session if requested
  if (opts.resume || opts.session) {
    const session = opts.session
      ? await loadSession(opts.session)
      : await loadLastSession(config.projectRoot);

    if (session) {
      messages.push(...session.messages);
      sessionId = session.meta.id;
      console.log(chalk.green(`  Resumed session ${session.meta.id} (${session.meta.turns} turns)\n`));
    } else {
      console.log(chalk.gray('  No session to resume.\n'));
    }
  }

  // Read piped stdin
  const pipedInput = await readStdin();
  const oneShot = promptArgs.join(' ').trim();

  // One-shot mode (with optional piped input)
  if (oneShot || pipedInput) {
    let prompt = oneShot;
    if (pipedInput) {
      const stdinContext = `<stdin>\n${pipedInput.slice(0, 50_000)}\n</stdin>`;
      prompt = prompt
        ? `${stdinContext}\n\n${prompt}`
        : `${stdinContext}\n\nAnalyze the above input.`;
    }

    // Resolve @references
    const { cleanInput, references } = await resolveReferences(prompt, config.projectRoot);
    const refContext = formatReferences(references);
    const finalPrompt = refContext + cleanInput;

    // Load --image attachments (repeatable). In one-shot mode, a bad image
    // is a hard failure — the user asked for a specific file or URL, we
    // can't silently drop it.
    const cliImages: string[] = Array.isArray(opts.image) ? (opts.image as string[]) : [];
    const attachments: ImageAttachment[] = [];
    for (const spec of cliImages) {
      const res = await loadImage(spec, config.projectRoot);
      if (isImageLoadError(res)) {
        if (jsonMode) {
          events.emit({ type: 'error', message: `--image: ${res.error}` });
        } else {
          console.error(chalk.red(`  --image: ${res.error}`));
        }
        process.exit(1);
      }
      attachments.push(res);
    }

    // Attachments are only enabled for models we know accept image blocks.
    if (attachments.length > 0 && !modelSupportsImages(activeModelId)) {
      const msg = `Selected model "${activeModelId}" does not support image attachments. Switch to a vision-capable model.`;
      if (jsonMode) events.emit({ type: 'error', message: msg } as any);
      else console.error(chalk.red(`  ${msg}`));
      process.exit(1);
    }

    if (attachments.length > 0) {
      const imageBlocks: ImageContentBlock[] = attachments.map(imageToContentBlock);
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: finalPrompt },
          ...imageBlocks,
        ],
      });
    } else {
      messages.push({ role: 'user', content: finalPrompt });
    }

    if (jsonMode) {
      events.emit({
        type: 'session-start',
        model: activeModelId,
        cwd: config.projectRoot,
        outputSchema: outputSchema?.schema,
      });
      events.emit({ type: 'user-message', content: finalPrompt });
      for (const a of attachments) {
        events.emit({ type: 'image-attached', source: a.source, path: a.path, url: a.url, mimeType: a.mimeType, sizeBytes: a.sizeBytes } as any);
      }
    } else {
      console.log(chalk.cyan(`> ${oneShot || '(piped input)'}\n`));
      if (references.length > 0) {
        console.log(chalk.gray(`  Injected ${references.length} reference(s)\n`));
      }
      for (const a of attachments) {
        console.log(chalk.gray(`  ${formatAttachmentStatus(a)}`));
      }
      if (attachments.length > 0) console.log('');
    }

    const spinner = jsonMode ? null : ora('Thinking...').start();
    try {
      const response = await withRetry(() =>
        runLoop(messages, {
          model,
          systemPrompt,
          toolContext: toolCtx,
          maxIterations: config.maxIterations,
          contextWindow: activeContextWindow(config.models.chat),
          onTextChunk: (chunk) => {
            if (spinner?.isSpinning) spinner.stop();
            if (jsonMode) events.emit({ type: 'text-delta', content: chunk });
            else process.stdout.write(chunk);
          },
          onToolCall: (name, args) => {
            if (spinner?.isSpinning) spinner.stop();
            if (jsonMode) {
              events.emit({ type: 'tool-call', name, args: args as Record<string, unknown> });
            } else {
              const argSummary = Object.entries(args)
                .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
                .join(', ');
              console.log(chalk.gray(`\n  \u2192 ${name}(${argSummary})`));
            }
          },
          onToolResult: (name, result, isError) => {
            if (jsonMode) {
              events.emit({ type: 'tool-result', name, content: result, isError: !!isError });
            } else {
              const preview = result.slice(0, 100).replace(/\n/g, ' ');
              const icon = isError ? chalk.red('\u2717') : chalk.green('\u2713');
              console.log(chalk.gray(`    ${icon} ${preview}${result.length > 100 ? '...' : ''}`));
            }
          },
        })
      );

      if (!jsonMode) console.log('\n');

      // Track usage
      if (response.status === 'max-iterations') {
        process.exitCode = 2;
        if (jsonMode) events.emit({ type: 'error', message: response.text, code: 'max-iterations' });
      }
      let cost = 0;
      if (response.usage) {
        usage.record({
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          toolCalls: response.toolCallCount,
          iterations: response.iterations,
        });
        cloudUsage.record({
          modelId: activeModelId,
          ts: Date.now(),
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          toolCalls: response.toolCallCount,
          iterations: response.iterations,
        });
        cost = costTracker.record(activeModelId, response.usage.promptTokens, response.usage.completionTokens).cost;
        if (!jsonMode) {
          const footer = cloudUsage.formatFooter(activeModelId);
          console.log(usage.formatLast() + '  ' + costTracker.formatLastCost() + (footer ? '  ' + footer : ''));
        }
      }

      if (jsonMode && response.usage) {
        events.emit({
          type: 'usage',
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          cost,
        });
      }

      if (jsonMode) {
        events.emit({ type: 'assistant-message', content: response.text });
      }

      // Structured output extraction
      if (outputSchema) {
        const structured = validateStructuredOutput(response.text, outputSchema);
        if (structured.ok) {
          if (jsonMode) events.emit({ type: 'structured-output', value: structured.value });
          else console.log(chalk.gray('  [structured-output]\n') + JSON.stringify(structured.value, null, 2) + '\n');
        } else {
          process.exitCode = 1;
          if (jsonMode) events.emit({ type: 'error', message: structured.error, code: 'invalid-structured-output' });
          else console.error(chalk.red(structured.error));
        }
      }

      if (opts.outputLastMessage) {
        try {
          await fs.writeFile(opts.outputLastMessage, response.text, 'utf-8');
        } catch (err: any) {
          if (jsonMode) events.emit({ type: 'error', message: `Failed to write --output-last-message: ${err.message}` });
        }
      }

      await quietlyCaptureMemoryCue(cleanInput, model);

      if (jsonMode) {
        events.emit({
          type: 'session-end',
          status: response.status ?? 'completed',
          turns: response.iterations ?? 1,
          durationMs: events.elapsedMs,
        });
      }
    } catch (err: any) {
      process.exitCode = 1;
      if (jsonMode) {
        events.emit({ type: 'error', message: err.message });
      } else {
        spinner?.fail(`Error: ${err.message}`);
      }
    }

    // Surface any queued permission tail notifications for this run. In JSON
    // mode they are emitted as first-class events; otherwise as dim text.
    const oneShotTail = drainTailNotifications();
    for (const msg of oneShotTail) {
      if (jsonMode) {
        // json-mode handler already formats payloads as JSON strings; parse
        // them back so the event stream stays well-typed. Anything that fails
        // to parse (auto-mode / one-shot / subagent notifications) is emitted
        // as a plain 'permission-notice' event.
        try {
          const parsed = JSON.parse(msg);
          events.emit({ type: 'permission-denied', ...parsed } as any);
        } catch {
          events.emit({ type: 'permission-notice', message: msg } as any);
        }
      } else {
        console.log(chalk.gray.dim(`  [permissions] ${msg}`));
      }
    }

    // Let fetch/native handles drain. Forced exit can crash Node's Windows
    // async handles after a successful streamed tool turn, and truncate JSONL.
    disconnectMCPServers();
    stopFileWatcher();
    return;
  }

  // ----------- INTERACTIVE REPL -----------

  // Ralph plan state (may be restored from disk)
  let ralphPlan: RalphPlan | null = null;

  // Try to restore Ralph plan from disk
  try {
    const savedPlan = await loadPlan(config.projectRoot);
    if (savedPlan) {
      ralphPlan = savedPlan;
      console.log(chalk.gray(`  Ralph plan loaded (${savedPlan.tasks.length} tasks)\n`));
    }
  } catch { /* no plan */ }

  // Tab completion
  const completer = buildCompleter(config.projectRoot);

  // A separate stream lets key setup detach stdin without exposing a secret to the REPL.
  const replInput = new PassThrough();
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.pipe(replInput);
  const rl = readline.createInterface({
    input: replInput,
    output: process.stdout,
    terminal: !!process.stdout.isTTY,
    prompt: theme().prompt('notch> '),
    completer: (line: string) => completer(line),
  });
  interactiveRl = rl;

  console.log(chalk.gray(process.env.TERM === 'dumb'
    ? '  Type a request, or /help for commands.\n'
    : '  Type a request. Tab completes commands and @files; /help lists commands.\n'));
  rl.prompt();

  const switchActiveModel = async (ref: string, local?: { baseUrl?: string; contextWindow?: number; ollamaBatch?: number; sourceRepo?: string }) => {
    try {
      const candidate = { ...selectModel(config.models.chat, { model: ref }), ...local };
      if (activeByokProvider(candidate)?.id === 'mlx') {
        const { startMlx } = await import('./providers/local-runner.js');
        candidate.baseUrl = await startMlx(parseByokRef(ref).model, toolCtx.abortSignal);
      }
      const check = await validateConfig(candidate);
      if (!check.ok) throw new Error(check.error);
      const resolved = resolveModel(candidate);
      config.models.chat = candidate;
      if (config.hybrid) config.hybrid.enabled = false;
      runLoop = runAgentLoop;
      model = resolved;
      activeModelId = ref;
      console.log(chalk.green(`  Switched to ${ref}\n`));
      if (isByokRef(ref)) {
        const { provider, model: id } = parseByokRef(ref);
        try { await persistByokChoice(config.projectRoot, provider, id, candidate); }
        catch (error) { console.log(chalk.yellow(`  Selected for this session; could not save preferences: ${(error as Error).message}`)); }
      }
    } catch (error) {
      console.log(chalk.red(`  Failed to switch: ${(error as Error).message}\n`));
    }
  };

  const setActiveAccess = async (mode: ReturnType<typeof parseAccessMode>) => {
    accessMode = mode;
    config.accessMode = mode;
    config.permissionMode = mode === 'full-access' ? 'trust' : 'auto';
    config.autoConfirm = mode === 'full-access';
    toolCtx.accessMode = mode;
    toolCtx.requireConfirm = mode !== 'full-access';
    toolCtx.autoConfirm = mode === 'full-access';
    try {
      await persistConfigPatch(config.projectRoot, { accessMode: mode, permissionMode: config.permissionMode, autoConfirm: config.autoConfirm });
      console.log(chalk.gray(`  Access: ${mode}. Saved to .notch.json.\n`));
    } catch (error) { console.log(chalk.yellow(`  Access: ${mode} for this session; could not save: ${(error as Error).message}\n`)); }
  };

  // Start the background memory-consolidation daemon. Fires the /dream
  // subagent after 60s of idle, once per REPL session, behind a cheap-first
  // gate (24h + 5-sessions + file lock). Gated by `--no-auto-dream` and
  // `NOTCH_AUTO_DREAM=0`. Never awaits — the daemon must NEVER block REPL.
  if (opts.autoDream !== false) {
    startAutoDreamDaemon({
      cwd: config.projectRoot,
      model,
      log: (msg: string) => console.log(chalk.gray(`  ${msg}`)),
      toolContext: toolCtx,
    });
  }

  const handleLine = async (line: string) => {
    // Reset the autoDream idle timer on every user keystroke line event.
    resetAutoDreamIdle();

    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // ---- Commands ----

    if (input === '/quit' || input === '/exit' || input === '/q') {
      if (usage.turnCount > 0) {
        console.log(usage.formatSession());
        console.log(costTracker.formatTotal());
      }
      // Flush rollout so --resume always sees a consistent file.
      try { await rollout.close(); } catch { /* non-critical */ }
      // Auto-save session
      if (messages.length > 0) {
        try {
          const name = getSessionName();
          const id = await saveSession(messages, config.projectRoot, activeModelId);
          console.log(chalk.gray(`  Session saved: ${id}${name ? ` (${name})` : ''}`));
          console.log(chalk.gray(`  Rollout: ${rollout.id} (replay with notch --session ${rollout.id})`));
        } catch { /* non-critical */ }
      }
      // Disconnect MCP servers
      try { disconnectMCPServers(); } catch { /* best effort */ }
      // Clean up interactive UI
      // Stop active loop timer
      stopActiveLoop();
      // Stop autoDream daemon (cancels any pending idle-fire)
      stopAutoDreamDaemon();
      // Stop file watcher
      stopFileWatcher();
      // Shut down plugins
      await pluginManager.shutdown();
      // Fire session-end hook
      await toolCtx.runHook?.('session-end', {});
      console.log(chalk.gray('\n  Goodbye!\n'));
      process.exit(0);
    }

    if (input === '/clear') {
      messages.length = 0;
      console.log(chalk.gray('  Conversation cleared.\n'));
      rl.prompt();
      return;
    }

    if (input === '/help') {
      printHelp();
      rl.prompt();
      return;
    }

    if (/^\/models (install|recommend|status|unload)(?:\s|$)/.test(input)) {
      const { runLocalModelsCli } = await import('./commands/local-models.js');
      const args = input.slice('/models '.length).trim().split(/\s+/);
      const result = await runLocalModelsCli(args, { cwd: config.projectRoot, embedded: true, signal: toolCtx.abortSignal,
        ask: question => new Promise((resolve, reject) => {
          const signal = toolCtx.abortSignal!;
          const cancelled = () => reject(signal.reason);
          signal.addEventListener('abort', cancelled, { once: true });
          rl.question(question, { signal }, answer => { signal.removeEventListener('abort', cancelled); resolve(answer); });
        }),
      });
      if (result.selection) {
        const { provider, model: id, baseUrl, contextWindow, ollamaBatch, sourceRepo } = result.selection;
        await switchActiveModel(`${provider}/${id}`, { baseUrl, contextWindow, ollamaBatch, sourceRepo });
      }
      rl.prompt(); return;
    }

    // /models coding — live OpenRouter coding list.
    if (input === '/models coding' || input === '/models openrouter' || input === '/openrouter') {
      await printOpenRouterCodingModels(7);
      rl.prompt();
      return;
    }

    // /model with no args — interactive provider/model picker.
    if (input === '/model' || input === '/models' || input === '/model coding' || input === '/model openrouter') {
      const picked = await interactiveModelPicker(activeModelId, question => new Promise(resolve => rl.question(question, resolve)));
      if (!picked) {
        console.log(chalk.gray('  Cancelled\n'));
      } else {
        await switchActiveModel(picked.modelRef);
      }
      rl.resume();
      rl.prompt();
      return;
    }

    // /model <ref> accepts provider/model refs. If a provider is already
    // active, a bare model id is interpreted as that provider's model id.
    if (input.startsWith('/model ') && !input.startsWith('/model download')) {
      const arg = input.replace('/model ', '').trim();
      if (isByokRef(arg)) {
        const { provider } = parseByokRef(arg);
        if (!findByokProvider(provider)) {
          console.log(chalk.red(`  Unknown provider: ${provider}`));
          console.log(chalk.gray(`  Run /providers to list built-ins.`));
          rl.prompt();
          return;
        }
        await switchActiveModel(arg);
        rl.prompt();
        return;
      }
      const currentProvider = activeByokProvider(config.models.chat);
      if (currentProvider) {
        const providerId = currentProvider.id === '__custom__' ? 'custom' : currentProvider.id;
        const modelRef = `${providerId}/${arg}`;
        await switchActiveModel(modelRef);
        rl.prompt();
        return;
      }

      let newModel = arg;
      if (!newModel.startsWith('notch-')) {
        newModel = `notch-${newModel}`;
      }
      if (!isValidModel(newModel)) {
        console.log(chalk.red(`  Unknown model: ${arg}`));
        console.log(chalk.gray('  Use provider/model, for example openrouter/anthropic/claude-sonnet-4.6.'));
        console.log(chalk.gray('  Run /providers to list built-ins.'));
        rl.prompt();
        return;
      }
      activeModelId = newModel as NotchModelId;
      config.models.chat.model = activeModelId;
      config.models.chat.byokProvider = undefined;
      model = resolveModel(config.models.chat);
      const switchedInfo = MODEL_CATALOG[activeModelId as NotchModelId];
      console.log(chalk.green(`  Switched to ${switchedInfo.label} (${switchedInfo.id})\n`));
      rl.prompt();
      return;
    }

    // /model download used to pull first-party weights. Provider/local-server
    // routing is now the supported local model path.
    if (input.startsWith('/model download')) {
      console.log(chalk.gray('  Direct weight downloads are no longer part of the model picker.'));
      console.log(chalk.gray('  Run a local provider instead, then select it with /model ollama/<model>, /model lmstudio/<model>, or /model custom/<model>.\n'));
      rl.prompt();
      return;
    }

    // /downloads — retained for sessions that already started a local pull.
    if (input === '/downloads') {
      const { listDownloads } = await import('./commands/model-download.js');
      const active = listDownloads();
      if (active.length === 0) {
        console.log(chalk.gray('  No local downloads started this session.\n'));
      } else {
        console.log(chalk.gray('\n  Model              State       Last line'));
        for (const h of active) {
          const state = h.result == null ? chalk.yellow('running')
            : h.result.code === 0 ? chalk.green('done')
            : chalk.red('error');
          const info = MODEL_CATALOG[h.modelId];
          const label = (info?.label ?? h.modelId).padEnd(18);
          const tail = (h.lastLine || '').slice(0, 80);
          console.log(`  ${label} ${state.padEnd(20)} ${chalk.gray(tail)}`);
        }
        console.log('');
      }
      rl.prompt();
      return;
    }

    // /setup-keys — local provider API-key wizard.
    if (input === '/setup-keys' || input === '/keys' || input === '/setup') {
      process.stdin.unpipe(replInput);
      rl.pause();
      const { runProviderKeySetup } = await import('./commands/provider-key-setup.js');
      try { await runProviderKeySetup(); }
      finally {
        process.stdin.setRawMode(true);
        process.stdin.pipe(replInput);
        rl.resume();
      }
      rl.prompt();
      return;
    }

    // /sync-keys — pull provider keys from freesyntax.dev using stored creds.
    if (input === '/sync-keys') {
      const { loadCredentials, syncByokKeys, getByokSyncPath } = await import('./auth.js');
      const creds = await loadCredentials();
      if (!creds) {
        console.log(chalk.gray('  Not signed in. Run:  notch login\n'));
        rl.prompt();
        return;
      }
      const spinner = ora('Pulling provider keys from freesyntax.dev...').start();
      try {
        const synced = await syncByokKeys(creds.token);
        spinner.stop();
        const providers = Object.keys(synced.keys);
        if (providers.length === 0) {
          console.log(chalk.gray(`  No provider keys on your profile yet. Add them at https://freesyntax.dev/settings/keys.\n`));
        } else {
          console.log(chalk.green(`  ✓ Synced ${providers.length} key(s): ${providers.join(', ')}`));
          console.log(chalk.gray(`    Cached at ${getByokSyncPath()}\n`));
        }
      } catch (err) {
        spinner.stop();
        console.log(chalk.red(`  Sync failed: ${(err as Error).message}\n`));
      }
      rl.prompt();
      return;
    }

    // /providers — provider directory
    if (input === '/providers') {
      printByokProviderList();
      rl.prompt();
      return;
    }

    // /status — health of the active backend (Notch or BYOK)
    if (input === '/status') {
      const byokCur = activeByokProvider(config.models.chat);
      const spinnerLabel = byokCur ? `Checking ${byokCur.label}...` : 'Checking Notch API...';
      const statusSpinner = ora(spinnerLabel).start();
      const check = await validateConfig(config.models.chat);
      if (check.ok) {
        if (byokCur) {
          statusSpinner.succeed(`${byokCur.label} (${activeModelId}) looks configured`);
        } else {
          const statusInfo = MODEL_CATALOG[activeModelId as NotchModelId];
          statusSpinner.succeed(`${statusInfo.label} (${activeModelId}) is reachable`);
        }
      } else {
        statusSpinner.fail(check.error ?? 'API unreachable');
        if (byokCur && byokCur.apiKeyEnv) {
          console.log(chalk.gray(`  Tip: export ${byokCur.apiKeyEnv}=... (or pass --api-key) and verify ${byokCur.baseUrl} is reachable.\n`));
        } else {
          console.log(chalk.gray('  Tip: Set NOTCH_API_KEY or use --api-key, and verify your Modal endpoint is running.\n'));
        }
      }
      rl.prompt();
      return;
    }

    // /undo
    if (input === '/undo') {
      if (checkpoints.undoCount === 0) {
        console.log(chalk.gray('  Nothing to undo.\n'));
        rl.prompt();
        return;
      }
      const undone = await checkpoints.undo();
      if (undone) {
        const fileCount = undone.files.length;
        console.log(chalk.yellow(`  Undid "${undone.description}" (${fileCount} file${fileCount !== 1 ? 's' : ''} restored)`));
        console.log(chalk.gray(`  ${checkpoints.undoCount} checkpoint${checkpoints.undoCount !== 1 ? 's' : ''} remaining\n`));
      }
      rl.prompt();
      return;
    }

    // /usage
    if (input === '/usage') {
      if (usage.turnCount === 0) {
        console.log(chalk.gray('  No usage yet.\n'));
      } else {
        console.log(usage.formatSession());
        // Show context meter
        const currentTokens = estimateTokens(messages);
        const ctxWindow = activeContextWindow(config.models.chat);
        console.log(renderContextMeter(currentTokens, ctxWindow));
        console.log('');
      }
      rl.prompt();
      return;
    }

    // /cost
    if (input === '/cost') {
      if (costTracker.totalCost === 0) {
        console.log(chalk.gray('  No cost data yet.\n'));
      } else {
        console.log(costTracker.formatTotal());
        console.log(costTracker.formatByModel());
        console.log('');
      }
      rl.prompt();
      return;
    }

    // /compact
    if (input === '/compact') {
      const { autoCompress } = await import('./agent/compression.js');
      const before = messages.length;
      const compressed = await autoCompress(messages, model, activeContextWindow(config.models.chat));
      messages.length = 0;
      messages.push(...compressed);
      console.log(chalk.green(`  Compressed: ${before} messages \u2192 ${messages.length} messages`));
      console.log('');
      rl.prompt();
      return;
    }

    // /diff
    if (input === '/diff') {
      const diffs = checkpoints.allDiffs();
      if (diffs.length === 0) {
        console.log(chalk.gray('  No file changes this session.\n'));
      } else {
        for (const df of diffs) {
          console.log(chalk.cyan(`  ${df.path}:`));
          console.log(unifiedDiff(df.before ?? '', df.after ?? '', df.path));
          console.log('');
        }
      }
      rl.prompt();
      return;
    }

    // /export
    if (input.startsWith('/export')) {
      const exportPath = input.replace('/export', '').trim() || 'notch-export.md';
      try {
        const ePath = await exportSession(messages, exportPath, {
          model: activeModelId,
          project: config.projectRoot,
        });
        console.log(chalk.green(`  Exported to ${ePath}\n`));
      } catch (err: any) {
        console.log(chalk.red(`  Export failed: ${err.message}\n`));
      }
      rl.prompt();
      return;
    }

    // /save
    if (input === '/save') {
      try {
        const id = await saveSession(messages, config.projectRoot, activeModelId);
        sessionId = id;
        console.log(chalk.green(`  Session saved: ${id}\n`));
      } catch (err: any) {
        console.log(chalk.red(`  Save failed: ${err.message}\n`));
      }
      rl.prompt();
      return;
    }

    // /sessions
    if (input === '/sessions') {
      try {
        const sessions = await listSessions();
        if (sessions.length === 0) {
          console.log(chalk.gray('  No saved sessions.\n'));
        } else {
          console.log(chalk.gray('\n  Saved sessions:\n'));
          for (const s of sessions.slice(0, 10)) {
            console.log(chalk.gray(`    ${s.id}  ${s.turns} turns  ${s.updated}  ${s.model}`));
          }
          console.log('');
        }
      } catch (err: any) {
        console.log(chalk.red(`  Error listing sessions: ${err.message}\n`));
      }
      rl.prompt();
      return;
    }

    // /resume [id]
    if (input.startsWith('/resume')) {
      const resumeId = input.replace('/resume', '').trim() || undefined;
      try {
        const session = resumeId
          ? await loadSession(resumeId)
          : await loadLastSession(config.projectRoot);
        if (session) {
          messages.length = 0;
          messages.push(...session.messages);
          sessionId = session.meta.id;
          // Restore Ralph plan if one exists
          try {
            const savedPlan = await loadPlan(config.projectRoot);
            if (savedPlan) {
              ralphPlan = savedPlan;
              console.log(chalk.green(`  Ralph plan restored (${savedPlan.tasks.length} tasks)\n`));
            }
          } catch { /* no plan to restore */ }
          console.log(chalk.green(`  Resumed session ${session.meta.id} (${session.meta.turns} turns)\n`));
        } else {
          console.log(chalk.gray('  No session found.\n'));
        }
      } catch (err: any) {
        console.log(chalk.red(`  Resume failed: ${err.message}\n`));
      }
      rl.prompt();
      return;
    }

    // /search <query>
    if (input.startsWith('/search ')) {
      const query = input.replace('/search ', '').trim().toLowerCase();
      if (!query) {
        console.log(chalk.gray('  Usage: /search <query>\n'));
        rl.prompt();
        return;
      }
      const matches: { index: number; role: string; preview: string }[] = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((p: any) => p.text || p.result || '').join(' ')
            : '';
        if (text.toLowerCase().includes(query)) {
          matches.push({
            index: i,
            role: msg.role,
            preview: text.slice(0, 120).replace(/\n/g, ' '),
          });
        }
      }
      if (matches.length === 0) {
        console.log(chalk.gray(`  No matches for "${query}"\n`));
      } else {
        console.log(chalk.gray(`\n  ${matches.length} match(es) for "${query}":\n`));
        for (const m of matches.slice(0, 10)) {
          console.log(chalk.gray(`    [${m.index}] ${m.role}: ${m.preview}`));
        }
        console.log('');
      }
      rl.prompt();
      return;
    }

    // /plan <task>
    if (input.startsWith('/plan ') && !input.startsWith('/plan approve') && !input.startsWith('/plan cancel') && !input.startsWith('/plan edit')) {
      const task = input.replace('/plan ', '').trim();
      const planSpinner = ora('Generating plan...').start();
      try {
        activePlan = await generatePlan(task, model, { cwd: config.projectRoot, repoMap: repoMapStr || undefined, history: messages });
        activePlanTask = task;
        planSpinner.succeed('Plan generated');
        console.log(formatPlan(activePlan));
        console.log(chalk.gray('  Use /plan approve to execute, /plan edit to modify, or /plan cancel to discard.\n'));
      } catch (err: any) {
        planSpinner.fail(`Plan failed: ${err.message}`);
      }
      rl.prompt();
      return;
    }

    if (input === '/plan approve') {
      if (!activePlan) {
        console.log(chalk.gray('  No active plan. Use /plan <task> to create one.\n'));
        rl.prompt();
        return;
      }
      console.log(chalk.green('  Executing plan...\n'));
      while (!isPlanComplete(activePlan!)) {
        const stepPrompt = currentStepPrompt(activePlan!);
        if (!stepPrompt) break;
        messages.push({ role: 'user', content: stepPrompt });
        const planStepSpinner = ora(`Step ${activePlan!.currentStep + 1}/${activePlan!.steps.length}...`).start();
        try {
          const response = await runLoop(messages, {
            model,
            systemPrompt,
            toolContext: toolCtx,
            maxIterations: config.maxIterations,
            contextWindow: activeContextWindow(config.models.chat),
            onTextChunk: (chunk) => {
              if (planStepSpinner.isSpinning) planStepSpinner.stop();
              process.stdout.write(chunk);
            },
            onToolCall: (name) => {
              if (planStepSpinner.isSpinning) planStepSpinner.stop();
              console.log(chalk.gray(`  \u2192 ${name}`));
            },
            onToolResult: (_name, _result, isError) => {
              console.log(isError ? chalk.red('    \u2717') : chalk.green('    \u2713'));
            },
          });
          console.log('\n');
          messages.length = 0;
          messages.push(...response.messages);
          advancePlan(activePlan!);
        } catch (err: any) {
          planStepSpinner.fail(`Step failed: ${err.message}`);
          break;
        }
      }
      if (activePlan && isPlanComplete(activePlan)) {
        console.log(chalk.green('  Plan completed!\n'));
      }
      activePlan = null;
      activePlanTask = null;
      rl.prompt();
      return;
    }

    if (input === '/plan edit') {
      if (!activePlan) {
        console.log(chalk.gray('  No active plan to edit.\n'));
        rl.prompt();
        return;
      }
      console.log(formatPlan(activePlan));
      console.log(chalk.gray('  Type a modified plan description and use /plan <new task> to regenerate,'));
      console.log(chalk.gray('  or /plan approve to proceed with the current plan.\n'));
      rl.prompt();
      return;
    }

    if (input === '/plan cancel') {
      activePlan = null;
      console.log(chalk.gray('  Plan discarded.\n'));
      rl.prompt();
      return;
    }

    // /agent <task>
    if (input.startsWith('/agent ')) {
      const task = input.replace('/agent ', '').trim();
      const agentId = nextSubagentId('general');
      console.log(chalk.cyan(`  Spawning subagent #${agentId}: ${task}\n`));
      spawnSubagent({
        id: agentId,
        type: 'general',
        prompt: task,
        model,
        toolContext: toolCtx,
        onStatus: (id: string, status: string) => {
          console.log(chalk.gray(`  [${id}] ${status}`));
        },
      }).then((result) => {
          console.log(chalk.green(`\n  Subagent #${agentId} finished:`));
          console.log(chalk.gray(`  ${result.text.slice(0, 200)}\n`));
          rl.prompt();
        }).catch((err: Error) => {
          console.log(chalk.red(`\n  Subagent #${agentId} failed: ${err.message}\n`));
          rl.prompt();
        });
      rl.prompt();
      return;
    }

    // /memory
    if (input.startsWith('/remember ')) {
      const text = input.replace('/remember ', '').trim();
      if (text) {
        await rememberUserPreference(text);
      }
      console.log(chalk.gray('  Remembered.\n'));
      rl.prompt();
      return;
    }

    if (input === '/memory compact') {
      const compactSpinner = ora('Compacting local memory...').start();
      try {
        const result = await compactMemoriesWithModel(model);
        compactSpinner.succeed(`Compacted ${result.rawCount} memories into ${result.summaryChars} chars`);
        console.log(chalk.gray(`  Summary: ${result.summaryPath}`));
        console.log(chalk.gray(`  Method: ${result.usedModel ? 'active model' : 'deterministic fallback'}\n`));
      } catch (err: any) {
        compactSpinner.fail(`Memory compact failed: ${err.message}`);
      }
      rl.prompt();
      return;
    }

    if (input === '/memory') {
      try {
        const memories = await loadMemories();
        const stats = await getMemoryPromptStats();
        if (memories.length === 0) {
          console.log(chalk.gray('  No saved memories.\n'));
        } else {
          console.log(chalk.gray(`\n  ${memories.length} saved memories (${stats.rawChars} raw chars, ${stats.promptBudget} char prompt budget):\n`));
          for (const m of memories) {
            console.log(chalk.gray(`    [${m.type}] ${m.content.slice(0, 80)}`));
          }
          if (stats.summaryChars > 0) {
            console.log(chalk.gray(`\n  Summary: ${getMemorySummaryPath()} (${stats.summaryChars} chars)`));
          }
          console.log('');
        }
      } catch (err: any) {
        console.log(chalk.red(`  Error: ${err.message}\n`));
      }
      rl.prompt();
      return;
    }

    if (input.startsWith('/memory search ')) {
      const query = input.replace('/memory search ', '').trim();
      try {
        const results = await searchMemories(query);
        if (results.length === 0) {
          console.log(chalk.gray(`  No memories matching "${query}"\n`));
        } else {
          for (const m of results) {
            console.log(chalk.gray(`    [${m.type}] ${m.content.slice(0, 100)}`));
          }
          console.log('');
        }
      } catch (err: any) {
        console.log(chalk.red(`  Error: ${err.message}\n`));
      }
      rl.prompt();
      return;
    }

    if (input === '/memory clear') {
      try {
        const memories = await loadMemories();
        for (const m of memories) {
          await deleteMemory(m.filename);
        }
        await fs.unlink(getMemorySummaryPath()).catch(() => undefined);
        console.log(chalk.yellow(`  Cleared ${memories.length} memories.\n`));
      } catch (err: any) {
        console.log(chalk.red(`  Error: ${err.message}\n`));
      }
      rl.prompt();
      return;
    }

    // /permissions
    if (input === '/permissions') {
      console.log(formatPermissions(permissions));
      console.log(chalk.gray(`  Access: ${accessMode}${config.autoConfirm ? ' (autoConfirm)' : ''}`));
      console.log(chalk.gray('  /permissions approve      Ask before actions that need approval\n  /permissions read-only    Allow built-in reads; deny actions\n  /permissions full-access  Allow tool actions without prompts'));
      console.log('');
      rl.prompt();
      return;
    }

    if (input.startsWith('/permissions ')) {
      try { await setActiveAccess(parseAccessMode(input.slice('/permissions '.length).trim())); }
      catch (error) { console.log(chalk.red(`  ${(error as Error).message}\n`)); }
      rl.prompt();
      return;
    }

    // /yolo — toggle trust mode and persist.
    //
    // Flips `permissionMode` between 'trust' and the prior value (default
    // 'auto'). Writes the result to `.notch.json` so the setting survives
    // process restarts — this is the "sticks when set" behaviour the user
    // asked for. Also flips `autoConfirm` in lockstep so any remaining
    // confirm prompts (hooks trust etc.) also auto-accept.
    //
    // Aliases: /yes (trust-on), /strict (trust-off). /yolo toggles.
    if (input === '/yolo' || input === '/yes' || input === '/trust' || input === '/strict' || input === '/autoaccept' || input === '/auto') {
      const turnOn = input === '/yolo'
        ? accessMode !== 'full-access'
        : (input === '/yes' || input === '/trust' || input === '/autoaccept' || input === '/auto');
      await setActiveAccess(turnOn ? 'full-access' : 'approve');
      rl.prompt();
      return;
    }

    // /ralph commands
    if (input.startsWith('/ralph plan ')) {
      const goal = input.replace('/ralph plan ', '').trim();
      const planSpinner = ora('Ralph is planning...').start();
      try {
        ralphPlan = await generateRalphPlan(goal, model, config.projectRoot);
        await savePlan(ralphPlan, config.projectRoot);
        planSpinner.succeed(`Ralph planned ${ralphPlan.tasks.length} tasks`);
        console.log(formatRalphStatus(ralphPlan));
      } catch (err: any) {
        planSpinner.fail(`Ralph planning failed: ${err.message}`);
      }
      rl.prompt();
      return;
    }

    if (input === '/ralph run') {
      if (!ralphPlan) {
        console.log(chalk.gray('  No Ralph plan. Use /ralph plan <goal> first.\n'));
        rl.prompt();
        return;
      }
      console.log(chalk.green('  Ralph is running...\n'));
      try {
        ralphPlan = await runRalphLoop(ralphPlan, model, toolCtx, config.projectRoot, {
          onTaskStart: (task: import('./agent/ralph.js').RalphTask) => console.log(chalk.cyan(`  \u25b6 Task: ${task.title}`)),
          onTaskEnd: (task: import('./agent/ralph.js').RalphTask) => console.log(chalk.green(`  \u2713 Done: ${task.title}\n`)),
          onText: (chunk: string) => process.stdout.write(chunk),
        });
        await savePlan(ralphPlan, config.projectRoot);
        console.log(formatRalphStatus(ralphPlan));
      } catch (err: any) {
        console.log(chalk.red(`  Ralph error: ${err.message}\n`));
      }
      rl.prompt();
      return;
    }

    if (input === '/ralph status') {
      if (!ralphPlan) {
        console.log(chalk.gray('  No Ralph plan active.\n'));
      } else {
        console.log(formatRalphStatus(ralphPlan));
      }
      rl.prompt();
      return;
    }

    if (input === '/ralph clear') {
      ralphPlan = null;
      await deletePlan(config.projectRoot).catch(() => {});
      console.log(chalk.gray('  Ralph plan cleared.\n'));
      rl.prompt();
      return;
    }

    // /branch (a.k.a /fork)
    if (input === '/branch' || input === '/fork') {
      const branchId = `branch-${branches.size + 1}`;
      branches.set(branchId, [...messages]);
      // Record a fork marker in the rollout so replay knows where to split.
      await rollout.append({ type: 'branch-fork', payload: { branchId, fromMessageIndex: messages.length - 1 } });
      console.log(chalk.green(`  Forked conversation as "${branchId}" (${messages.length} messages)\n`));
      console.log(chalk.gray('  Use /branches to list, or notch --session ' + rollout.id + ' to replay.\n'));
      rl.prompt();
      return;
    }

    // /rollouts — list all rollouts across projects
    if (input === '/rollouts') {
      try {
        const list = await listRollouts();
        if (list.length === 0) {
          console.log(chalk.gray('  No rollouts yet.\n'));
        } else {
          console.log(chalk.gray('\n  Rollouts (newest first):\n'));
          for (const r of list.slice(0, 15)) {
            const when = new Date(r.updated).toLocaleString();
            console.log(chalk.gray(`    ${r.id}  ${r.messageCount} msgs  ${when}  ${r.project?.slice(-30) ?? ''}`));
          }
          console.log('');
        }
      } catch (err: any) {
        console.log(chalk.red(`  Error: ${err.message}\n`));
      }
      rl.prompt();
      return;
    }

    // /branches
    if (input === '/branches') {
      if (branches.size === 0) {
        console.log(chalk.gray('  No conversation branches. Use /branch to fork.\n'));
      } else {
        console.log(chalk.gray('\n  Branches:\n'));
        for (const [name, msgs] of branches) {
          const marker = name === currentBranch ? chalk.green(' \u25cf') : '  ';
          console.log(chalk.gray(`  ${marker} ${name}  (${msgs.length} messages)`));
        }
        console.log('');
      }
      rl.prompt();
      return;
    }

    // /theme
    if (input === '/theme' || input === '/themes') {
      console.log(formatThemeList(themeId()));
      rl.prompt();
      return;
    }

    if (input.startsWith('/theme ')) {
      const newTheme = input.replace('/theme ', '').trim();
      if (!isValidTheme(newTheme)) {
        const t = theme();
        console.log(t.error(`  Unknown theme: ${newTheme}`));
        console.log(t.dim(`  Available: ${THEME_IDS.join(', ')}\n`));
        rl.prompt();
        return;
      }
      setTheme(newTheme as ThemeId);
      const t = theme();
      console.log(t.success(`  Switched to "${t.name}" theme`));
      console.log(t.dim(`  ${THEME_IDS.length} themes available. Use /theme to browse.\n`));
      // Update prompt color
      rl.setPrompt(t.prompt('notch> '));
      rl.prompt();
      return;
    }

    // /mascot
    if (input === '/mascot') {
      printMantis();
      rl.prompt();
      return;
    }

    // Command registry — try registered commands before falling through
    if (input.startsWith('/')) {
      const cmdCtx: CommandContext = {
        cwd: config.projectRoot,
        modelId: activeModelId,
        messages,
        lastResponse: lastAssistantResponse,
        log: (msg) => console.log(chalk.gray(`  ${msg}`)),
        runPrompt: async (prompt, msgs) => {
          const spinner = ora('Thinking...').start();
          const response = await withRetry(() =>
            runLoop(msgs, {
              model,
              systemPrompt,
              toolContext: { ...toolCtx, dryRun: isSandboxEnabled() || toolCtx.dryRun },
              maxIterations: config.maxIterations,
              contextWindow: activeContextWindow(config.models.chat),
              onTextChunk: (chunk) => {
                if (spinner.isSpinning) spinner.stop();
                process.stdout.write(chunk);
              },
              onToolCall: (name, args) => {
                if (spinner.isSpinning) spinner.stop();
                const argSummary = Object.entries(args)
                  .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
                  .join(', ');
                console.log(chalk.gray(`\n  \u2192 ${name}(${argSummary})`));
              },
              onToolResult: (_name, result, isError) => {
                const preview = result.slice(0, 100).replace(/\n/g, ' ');
                const icon = isError ? chalk.red('\u2717') : chalk.green('\u2713');
                console.log(chalk.gray(`    ${icon} ${preview}${result.length > 100 ? '...' : ''}`));
              },
            })
          );
          if (spinner.isSpinning) spinner.stop();
          lastAssistantResponse = response.text;
          return response.text;
        },
      };

      const handled = await dispatchCommand(input, cmdCtx);
      if (handled) {
        rl.prompt();
        return;
      }

      // Not found in registry either
      console.log(chalk.red(`  Unknown command: ${input}`));
      console.log(chalk.gray('  Type /help for available commands.\n'));
      rl.prompt();
      return;
    }

    // ----- Normal prompt -----

    // Extract inline image references (drag-drop paths, `Image:` prefix,
    // pasted data URLs). Images are stripped from the prompt text before
    // @reference resolution so e.g. `./shot.png` isn't treated as a file
    // include.
    const imgRefs = extractImageRefs(input);
    const replAttachments: ImageAttachment[] = [];
    for (const spec of imgRefs.specs) {
      const res = await loadImage(spec, config.projectRoot);
      if (isImageLoadError(res)) {
        console.log(chalk.yellow(`  image skipped: ${res.error}`));
        continue;
      }
      replAttachments.push(res);
      console.log(chalk.gray(`  \u{1F4CE} ${formatAttachmentStatus(res)}`));
    }

    // Attachments are only enabled for models we know accept image blocks.
    if (replAttachments.length > 0 && !modelSupportsImages(activeModelId)) {
      console.warn(
        chalk.yellow(
          `  \u26A0 ${activeModelId} does not support image attachments. Switch with /model; skipping image(s).`,
        ),
      );
      replAttachments.length = 0;
    }

    // Resolve @references on the text remaining after image extraction.
    // If the user supplied ONLY an image with no prose, give the model a
    // neutral instruction so it doesn't see an empty user message.
    const textForRefs = imgRefs.cleanedText
      || (replAttachments.length > 0 ? 'Describe the attached image(s).' : '');
    const { cleanInput, references } = await resolveReferences(textForRefs, config.projectRoot);
    const refContext = formatReferences(references);
    const finalPrompt = refContext + cleanInput;

    if (references.length > 0) {
      console.log(chalk.gray(`  Injected ${references.length} reference(s)`));
    }

    if (!finalPrompt.trim() && replAttachments.length === 0) {
      console.warn(chalk.yellow('  Add a message, or switch to a vision-capable model before sending only images.'));
      return;
    }

    if (replAttachments.length > 0) {
      const imageBlocks: ImageContentBlock[] = replAttachments.map(imageToContentBlock);
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: finalPrompt },
          ...imageBlocks,
        ],
      });
    } else {
      messages.push({ role: 'user', content: finalPrompt });
    }

    // Rollout: record the user turn + mark an active stream. The marker is
    // cleared on turn-end or error so `notch --resume <id>` knows whether
    // the prior run died mid-stream.
    const turnStreamId = `s_${Date.now().toString(36)}`;
    const userMsgId = `m_${Date.now().toString(36)}`;
    await rollout.append({ type: 'turn-start', payload: { streamId: turnStreamId } });
    await rollout.append({ type: 'user-message', msgId: userMsgId, payload: { content: finalPrompt } });
    await rollout.append({ type: 'active-stream', streamId: turnStreamId });

    const spinner = ora('Thinking...').start();
    const spinnerStart = Date.now();
    const spinnerTimer = setInterval(() => {
      if (!spinner.isSpinning) { clearInterval(spinnerTimer); return; }
      const elapsed = Math.floor((Date.now() - spinnerStart) / 1000);
      if (elapsed >= 30) {
        spinner.text = `Waiting for model... (${elapsed}s — endpoint may be cold-starting)`;
      } else if (elapsed >= 10) {
        spinner.text = `Thinking... (${elapsed}s)`;
      }
    }, 2000);

    try {
      const response = await withRetry(() =>
        runLoop(messages, {
          model,
          systemPrompt,
          toolContext: { ...toolCtx, dryRun: isSandboxEnabled() || toolCtx.dryRun },
          maxIterations: config.maxIterations,
          contextWindow: activeContextWindow(config.models.chat),
          onTextChunk: (chunk) => {
            clearInterval(spinnerTimer);
            if (spinner.isSpinning) spinner.stop();
            process.stdout.write(chunk);
            void rollout.append({ type: 'text-delta', streamId: turnStreamId, payload: { content: chunk } });
          },
          onToolCall: (name, args) => {
            clearInterval(spinnerTimer);
            if (spinner.isSpinning) spinner.stop();

            const argSummary = Object.entries(args)
              .map(([k, v]) => {
                const val = String(v);
                return `${k}=${val.length > 60 ? val.slice(0, 60) + '...' : val}`;
              })
              .join(', ');
            console.log(chalk.gray(`\n  \u2192 ${name}(${argSummary})`));
            void rollout.append({ type: 'tool-call', streamId: turnStreamId, payload: { name, args } });
          },
          onToolResult: (name, result, isError) => {
            const preview = result.slice(0, 100).replace(/\n/g, ' ');
            const icon = isError ? chalk.red('\u2717') : chalk.green('\u2713');
            console.log(chalk.gray(`    ${icon} ${preview}${result.length > 100 ? '...' : ''}`));
            void rollout.append({ type: 'tool-result', streamId: turnStreamId, payload: { name, content: result, isError: !!isError } });
          },
          onCompress: () => {
            console.log(chalk.yellow('\n  [Context compressed to fit window]\n'));
          },
        })
      );

      console.log('\n');
      lastAssistantResponse = response.text;
      await checkpoints.commit(`Turn ${usage.turnCount + 1}`);

      // Rollout: emit assistant message + usage + turn-end. This clears
      // the active-stream marker so --resume knows the turn is complete.
      const assistantMsgId = `m_${Date.now().toString(36)}`;
      await rollout.append({ type: 'assistant-message', msgId: assistantMsgId, parent: userMsgId, payload: { content: response.text } });
      if (response.usage) {
        await rollout.append({ type: 'usage', payload: {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
        } });
      }
      await rollout.append({ type: 'turn-end', streamId: turnStreamId });
      await rollout.flush();

      // Track usage + cost
      if (response.usage) {
        usage.record({
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          toolCalls: response.toolCallCount,
          iterations: response.iterations,
        });
        cloudUsage.record({
          modelId: activeModelId,
          ts: Date.now(),
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          toolCalls: response.toolCallCount,
          iterations: response.iterations,
        });
        costTracker.record(activeModelId, response.usage.promptTokens, response.usage.completionTokens);
        const cloudFooter = cloudUsage.formatFooter(activeModelId);
        console.log(usage.formatLast() + '  ' + costTracker.formatLastCost() + (cloudFooter ? '  ' + cloudFooter : ''));

        // Show context warning when approaching limit
        const currentTokens = estimateTokens(messages);
        const ctxWindow = activeContextWindow(config.models.chat);
        if (currentTokens > ctxWindow * 0.5) {
          console.log(compactContextIndicator(currentTokens, ctxWindow));
        }
      }
      console.log('');

      // Update messages with the full history
      messages.length = 0;
      messages.push(...response.messages);

      await quietlyCaptureMemoryCue(cleanInput, model);

      // Back-compat: silently persist an explicit memory marker if a provider
      // emits one. The system prompt does not encourage this marker.
      const lastText = response.text;
      if (lastText.includes('[MEMORY:') || lastText.includes('[memory:')) {
        const memMatch = lastText.match(/\[(?:MEMORY|memory):\s*([^\]]+)\]/);
        if (memMatch) {
          try {
            await saveMemory({
              name: `auto-saved ${Date.now()}`,
              description: memMatch[1]!.slice(0, 80),
              type: 'project' as MemoryType,
              content: memMatch[1]!,
            }, { unique: true });
            const stats = await getMemoryPromptStats();
            if (stats.overBudget) {
              await compactMemoriesWithModel(model).catch(() => undefined);
            }
          } catch { /* non-critical */ }
        }
      }
    } catch (err: any) {
      clearInterval(spinnerTimer);
      spinner.fail(`Error: ${err.message}`);
      try { await checkpoints.commit(`Interrupted turn ${usage.turnCount + 1}`); }
      catch (error) { console.log(chalk.yellow(`  Could not save undo checkpoint: ${(error as Error).message}`)); }
      await rollout.append({ type: 'error', streamId: turnStreamId, payload: { message: err.message } });
      await rollout.flush();

      const msg = err.message?.toLowerCase() ?? '';
      if (msg.includes('fetch') || msg.includes('econnrefused') || msg.includes('network')) {
        console.log(chalk.gray('  Tip: Check that your Notch endpoint is running. Use /status to verify.\n'));
      } else if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('api key')) {
        console.log(chalk.gray('  Tip: Set NOTCH_API_KEY env var or use --api-key flag.\n'));
      } else if (msg.includes('429') || msg.includes('rate limit')) {
        console.log(chalk.gray('  Tip: Rate limited. Wait a moment and try again.\n'));
      } else {
        console.log(chalk.gray('  (The conversation history is preserved. Try again.)\n'));
      }
    }

    // Surface any tail notifications from per-surface handlers (auto-mode
    // denials, subagent blocks, classifier upgrades, etc.) queued during
    // this turn.
    const tail = drainTailNotifications();
    for (const msg of tail) {
      console.log(chalk.gray.dim(`  [permissions] ${msg}`));
    }

    rl.prompt();
  };

  // Pasted lines and fast submissions must not run overlapping agent turns.
  let lineQueue = Promise.resolve();
  let activeTurnAbort: AbortController | undefined;
  rl.on('SIGINT', () => {
    if (activeTurnAbort) {
      activeTurnAbort.abort(new Error('Cancelled by user'));
      console.log(chalk.gray('\n  Cancelling current turn...'));
    } else {
      rl.write(null, { ctrl: true, name: 'u' });
      console.log(chalk.gray('\n  Use /quit to exit.'));
      rl.prompt();
    }
  });
  rl.on('line', line => {
    lineQueue = lineQueue.then(async () => {
      activeTurnAbort = new AbortController();
      toolCtx.abortSignal = activeTurnAbort.signal;
      try { await handleLine(line); }
      finally { activeTurnAbort = undefined; toolCtx.abortSignal = undefined; }
    }).catch(error => {
      console.log(chalk.red(`  ${(error as Error).message}\n`));
      rl.prompt();
    });
  });

  rl.on('close', () => {
    interactiveRl = undefined;
    process.stdin.unpipe(replInput);
    process.stdin.setRawMode(wasRaw ?? false);
    stopAutoDreamDaemon();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Ralph subcommand handler (for `notch ralph plan|run|status`)
// ---------------------------------------------------------------------------

async function handleRalphSubcommand(args: string[], cliOpts: any) {
  const config = await loadConfig(cliOpts.cwd ? { projectRoot: cliOpts.cwd } : {});
  if (cliOpts.model) config.models.chat.model = cliOpts.model as NotchModelId;

  const model = resolveModel(config.models.chat);
  const toolCtx: ToolContext = {
    cwd: config.projectRoot,
    requireConfirm: false,
    confirm: async () => true,
    log: (msg) => console.log(chalk.gray(`  ${msg}`)),
  };

  const subcommand = args[0];

  if (subcommand === 'plan') {
    const goal = args.slice(1).join(' ');
    if (!goal) {
      console.error(chalk.red('  Usage: notch ralph plan <goal>'));
      process.exit(1);
    }
    const spinner = ora('Ralph is planning...').start();
    const plan = await generateRalphPlan(goal, model, config.projectRoot);
    await savePlan(plan, config.projectRoot);
    spinner.succeed(`Planned ${plan.tasks.length} tasks`);
    console.log(formatRalphStatus(plan));
  } else if (subcommand === 'run') {
    let plan = await loadPlan(config.projectRoot);
    if (!plan) {
      console.error(chalk.red('  No plan found. Run: notch ralph plan <goal>'));
      process.exit(1);
    }
    plan = await runRalphLoop(plan, model, toolCtx, config.projectRoot, {
      onTaskStart: (t: import('./agent/ralph.js').RalphTask) => console.log(chalk.cyan(`  \u25b6 ${t.title}`)),
      onTaskEnd: (t: import('./agent/ralph.js').RalphTask) => console.log(chalk.green(`  \u2713 ${t.title}`)),
      onText: (chunk: string) => process.stdout.write(chunk),
    });
    await savePlan(plan, config.projectRoot);
    console.log(formatRalphStatus(plan));
  } else if (subcommand === 'status') {
    const plan = await loadPlan(config.projectRoot);
    if (!plan) {
      console.log(chalk.gray('  No Ralph plan found.'));
    } else {
      console.log(formatRalphStatus(plan));
    }
  } else {
    console.error(chalk.red(`  Unknown: notch ralph ${subcommand}`));
    console.error(chalk.gray('  Usage: notch ralph <plan|run|status>'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red(`\nFatal: ${err.message}\n`));
  process.exitCode = 1;
  disconnectMCPServers();
  stopRuntimeWatcher();
});
