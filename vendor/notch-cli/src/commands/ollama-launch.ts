/**
 * Notch CLI — `notch ollama` subcommand
 *
 * Zero-flag workflow for running Notch against a local (or Ollama-Cloud)
 * daemon. Mirrors the UX of `ollama launch claude` — detect the daemon,
 * pick a model, pull it if missing, verify context window, persist the
 * choice to `.notch.json`, then hand off to the normal agent loop.
 *
 * Subcommands:
 *   notch ollama              Interactive model setup
 *   notch ollama launch       Explicit alias for the default
 *   notch ollama list         List installed / cloud models as a table
 *   notch ollama pull <name>  Pull a model with a progress bar
 *   notch ollama status       Daemon reachability + active model
 *   notch ollama login        Capture and store OLLAMA_API_KEY for Cloud
 *   notch ollama logout       Clear stored Ollama credentials
 *   notch ollama bench        Run the bench suite against N models
 *
 * Every subcommand returns an integer exit code via process.exitCode so
 * wrappers (CI, shell scripts, ollama launch plug-in) can branch on it.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import readline from 'node:readline';
import chalk from 'chalk';
import { ollamaRoot, ollamaChatUrl } from '../providers/ollama-url.js';
import { persistConfigPatch } from '../config.js';
import {
  detectDaemon,
  listModels,
  showModel,
  pullModel,
  deleteModel,
  isCloudBaseUrl,
  isCloudModel,
  formatBytes,
  OLLAMA_LOCAL_BASE_URL,
  OLLAMA_CLOUD_BASE_URL,
  type OllamaModelRow,
  type OllamaPullEvent,
} from '../providers/ollama.js';
import { findByokProvider } from '../providers/index.js';
import {
  readOllamaCreds,
  writeOllamaCreds,
  clearOllamaCreds,
  ollamaCredsPath,
} from '../providers/ollama-credentials.js';

// Credential storage lives in ../providers/ollama-credentials.ts so the
// main `loadConfig` flow can read stored keys without importing this
// command-specific module. Thin aliases keep the rest of this file
// unchanged.
const readCreds = readOllamaCreds;
const writeCreds = writeOllamaCreds;
const clearCreds = clearOllamaCreds;
const credsPath = ollamaCredsPath;

// ---------------------------------------------------------------------------
// Arg parser (lightweight — no extra dep)
// ---------------------------------------------------------------------------

interface ParsedFlags {
  positional: string[];
  model?: string;
  cloud: boolean;
  host?: string;
  apiKey?: string;
  compat?: 'openai' | 'anthropic';
  yes: boolean;
  help: boolean;
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  const out: ParsedFlags = { positional: [], cloud: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('-')) throw new Error(`${a} requires a value.`);
      return next;
    };
    if (a === '--cloud') out.cloud = true;
    else if (a === '-y' || a === '--yes') out.yes = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--model' || a === '-m') out.model = value();
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length);
    else if (a === '--host') out.host = value();
    else if (a.startsWith('--host=')) out.host = a.slice('--host='.length);
    else if (a === '--api-key') out.apiKey = value();
    else if (a.startsWith('--api-key=')) out.apiKey = a.slice('--api-key='.length);
    else if (a === '--compat') {
      const v = value();
      if (v === 'openai' || v === 'anthropic') out.compat = v;
      else throw new Error('--compat must be openai or anthropic.');
    } else if (a.startsWith('--compat=')) {
      const v = a.slice('--compat='.length);
      if (v === 'openai' || v === 'anthropic') out.compat = v;
      else throw new Error('--compat must be openai or anthropic.');
    } else if (!a.startsWith('-')) {
      out.positional.push(a);
    } else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

interface ResolvedEndpoint {
  baseUrl: string;
  apiKey: string | undefined;
  mode: 'local' | 'cloud';
}

/**
 * Figure out which Ollama endpoint to target based on (in priority):
 *   1. --host flag
 *   2. --cloud flag (forces https://ollama.com)
 *   3. OLLAMA_HOST env var (native Ollama convention)
 *   4. Stored creds for a cloud endpoint (carry the endpoint forward)
 *   5. Default: http://localhost:11434
 */
async function resolveEndpoint(flags: ParsedFlags): Promise<ResolvedEndpoint> {
  let baseUrl: string;
  if (flags.host) {
    baseUrl = flags.host;
  } else if (flags.cloud) {
    baseUrl = OLLAMA_CLOUD_BASE_URL;
  } else if (process.env.OLLAMA_HOST) {
    baseUrl = process.env.OLLAMA_HOST.startsWith('http')
      ? process.env.OLLAMA_HOST
      : `http://${process.env.OLLAMA_HOST}`;
  } else {
    baseUrl = OLLAMA_LOCAL_BASE_URL;
  }

  baseUrl = ollamaRoot(baseUrl);
  const mode: 'local' | 'cloud' = isCloudBaseUrl(baseUrl) ? 'cloud' : 'local';

  let apiKey: string | undefined = flags.apiKey
    ?? process.env.OLLAMA_API_KEY
    ?? undefined;

  if (!apiKey && mode === 'cloud') {
    const stored = await readCreds();
    if (stored && stored.endpoint === baseUrl) {
      apiKey = stored.apiKey;
    }
  }

  return { baseUrl, apiKey, mode };
}

// ---------------------------------------------------------------------------
// Interactive prompts (single-line input; no extra deps)
// ---------------------------------------------------------------------------

async function promptLine(prompt: string, opts: { mask?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('Interactive prompt requested but stdin is not a TTY.');
  }
  if (!opts.mask) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, (ans) => resolve(ans));
    });
    rl.close();
    return answer.trim();
  }
  // Masked: raw-mode key-by-key capture. Required for password entry
  // on every Node version (≥ 20) without monkey-patching readline.
  return new Promise<string>((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        // Ctrl-C
        if (byte === 0x03) {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        // Enter (CR or LF)
        if (byte === 0x0d || byte === 0x0a) {
          cleanup();
          process.stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        // Backspace / DEL
        if (byte === 0x7f || byte === 0x08) {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        // Ignore other control chars
        if (byte < 0x20) continue;
        buf += String.fromCharCode(byte);
        process.stdout.write('*');
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

/**
 * Arrow-key picker over a plain list of strings. Returns the selected
 * entry or `null` on Esc/Ctrl-C. Deliberately framework-free so it works
 * in the minimal subcommand context.
 */
function pickFromList(items: string[], title: string): Promise<string | null> {
  if (items.length === 0) return Promise.resolve(null);
  if (!process.stdin.isTTY) return Promise.resolve(items[0] ?? null);
  return new Promise((resolve) => {
    let cursor = 0;
    const render = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${items.length + 2}A\x1b[J`);
      process.stdout.write(chalk.gray(`  ${title} (↑↓ to move, Enter to select, Esc to cancel)\n\n`));
      for (let i = 0; i < items.length; i++) {
        const pointer = i === cursor ? chalk.cyan('❯') : ' ';
        const label = i === cursor ? chalk.bold(items[i]!) : chalk.gray(items[i]!);
        process.stdout.write(`  ${pointer} ${label}\n`);
      }
    };
    render(true);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const onKey = (key: Buffer) => {
      const s = key.toString();
      if (s === '\x1b[A') { cursor = (cursor - 1 + items.length) % items.length; render(false); }
      else if (s === '\x1b[B') { cursor = (cursor + 1) % items.length; render(false); }
      else if (s === '\r' || s === '\n') { cleanup(); resolve(items[cursor] ?? null); }
      else if (s === '\x1b' || s === '\x03') { cleanup(); resolve(null); }
    };
    const cleanup = () => {
      stdin.removeListener('data', onKey);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };
    stdin.on('data', onKey);
  });
}

// ---------------------------------------------------------------------------
// Progress bar for /api/pull
// ---------------------------------------------------------------------------

function renderProgressLine(ev: OllamaPullEvent, lastStatus: { label: string }): void {
  if (ev.kind === 'progress') {
    const width = 30;
    const filled = Math.max(0, Math.min(width, Math.round((ev.percent / 100) * width)));
    const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
    const suffix = `${ev.percent.toFixed(1).padStart(5)}%  ${formatBytes(ev.completed)}/${formatBytes(ev.total)}`;
    const label = ev.message || lastStatus.label;
    lastStatus.label = label;
    process.stdout.write(`\r  ${chalk.cyan(bar)}  ${chalk.gray(suffix)}  ${chalk.dim(label)}\x1b[K`);
  } else if (ev.kind === 'status') {
    lastStatus.label = ev.message;
    process.stdout.write(`\r  ${chalk.gray(ev.message)}\x1b[K`);
  } else {
    process.stdout.write('\n');
  }
}

// ---------------------------------------------------------------------------
// .notch.json persistence
// ---------------------------------------------------------------------------

/**
 * Merge an Ollama choice into `.notch.json` (create if missing). Idempotent —
 * running `notch ollama` twice with the same selection is a no-op.
 */
async function persistOllamaChoice(
  projectRoot: string,
  opts: {
    providerId: 'ollama' | 'ollama-cloud' | 'ollama-anthropic';
    modelId: string;
    baseUrl?: string;
    apiShape?: 'openai' | 'anthropic';
  },
): Promise<void> {
  const byok: Record<string, unknown> = {
    provider: opts.providerId,
    model: opts.modelId,
  };
  if (opts.baseUrl) byok.baseUrl = opts.apiShape === 'anthropic'
    ? ollamaRoot(opts.baseUrl) : ollamaChatUrl(opts.baseUrl);
  if (opts.apiShape) byok.apiShape = opts.apiShape;
  await persistConfigPatch(projectRoot, {
    provider: byok, byok: undefined, model: undefined, baseUrl: undefined, apiKey: undefined,
  });
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

async function cmdList(flags: ParsedFlags): Promise<number> {
  const { baseUrl, apiKey, mode } = await resolveEndpoint(flags);
  const ok = await detectDaemon(baseUrl, { apiKey });
  if (!ok) {
    printNotReachable(baseUrl, mode);
    return 1;
  }
  let rows: OllamaModelRow[];
  try {
    rows = await listModels(baseUrl, { apiKey });
  } catch (err: unknown) {
    console.error(chalk.red(`  ${(err as Error).message}`));
    return 1;
  }
  if (rows.length === 0) {
    console.log(chalk.gray(`\n  No models installed at ${baseUrl}.`));
    console.log(chalk.gray(`  Pull one:  notch ollama pull llama3.2:latest\n`));
    return 0;
  }
  const header = `  ${'name'.padEnd(36)} ${'params'.padEnd(8)} ${'quant'.padEnd(10)} ${'size'.padStart(8)}`;
  console.log(chalk.gray(`\n  ${mode === 'cloud' ? 'Ollama Cloud' : 'Ollama local'}  @  ${baseUrl}\n`));
  console.log(chalk.gray(header));
  console.log(chalk.gray(`  ${'-'.repeat(header.length - 2)}`));
  for (const r of rows) {
    console.log(
      `  ${chalk.white(r.name.padEnd(36))} ${chalk.gray(r.parameterSize.padEnd(8))} ${chalk.gray(r.quantization.padEnd(10))} ${chalk.gray(formatBytes(r.sizeBytes))}`,
    );
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: pull
// ---------------------------------------------------------------------------

async function cmdPull(flags: ParsedFlags): Promise<number> {
  const modelName = flags.positional[0] ?? flags.model;
  if (!modelName) {
    console.error(chalk.red('  Usage: notch ollama pull <model>'));
    return 2;
  }
  const { baseUrl, apiKey, mode } = await resolveEndpoint(flags);
  const ok = await detectDaemon(baseUrl, { apiKey });
  if (!ok) {
    printNotReachable(baseUrl, mode);
    return 1;
  }
  console.log(chalk.cyan(`\n  Pulling ${chalk.bold(modelName)} from ${baseUrl}...\n`));
  const lastStatus = { label: '' };
  try {
    for await (const ev of pullModel(modelName, baseUrl, { apiKey })) {
      renderProgressLine(ev, lastStatus);
    }
  } catch (err: unknown) {
    process.stdout.write('\n');
    console.error(chalk.red(`  Pull failed: ${(err as Error).message}`));
    return 1;
  }
  console.log(chalk.green(`  ✓ ${modelName} ready.\n`));
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: status
// ---------------------------------------------------------------------------

async function cmdStatus(flags: ParsedFlags): Promise<number> {
  const { baseUrl, apiKey, mode } = await resolveEndpoint(flags);
  const ok = await detectDaemon(baseUrl, { apiKey });
  console.log('');
  console.log(chalk.gray('  Endpoint'), chalk.white(baseUrl));
  console.log(chalk.gray('  Mode    '), chalk.white(mode));
  console.log(chalk.gray('  Auth    '), apiKey ? chalk.green('yes (api key)') : chalk.yellow('none'));
  console.log(chalk.gray('  Reach   '), ok ? chalk.green('ok') : chalk.red('unreachable'));
  console.log('');
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Subcommand: login / logout
// ---------------------------------------------------------------------------

async function cmdLogin(flags: ParsedFlags): Promise<number> {
  const endpoint = flags.host ?? OLLAMA_CLOUD_BASE_URL;
  console.log(chalk.cyan(`\n  Ollama login — paste your API key for ${endpoint}`));
  console.log(chalk.gray(`  Get one at https://ollama.com/settings/keys\n`));
  let apiKey = flags.apiKey;
  if (!apiKey) {
    apiKey = await promptLine('  API key: ', { mask: true });
  }
  if (!apiKey) {
    console.error(chalk.red('  No key provided.'));
    return 2;
  }
  // Round-trip the key with /api/tags to confirm it's accepted.
  const reachable = await detectDaemon(endpoint, { apiKey, timeoutMs: 8_000 });
  if (!reachable) {
    console.error(chalk.red(`  Could not authenticate against ${endpoint} with the provided key.`));
    return 1;
  }
  await writeCreds({ apiKey, endpoint, createdAt: Date.now() });
  console.log(chalk.green(`  ✓ Key stored at ${credsPath()}`));
  console.log(chalk.gray(`  The CLI will auto-load it when you run \`notch ollama --cloud\`.\n`));
  return 0;
}

async function cmdLogout(_flags: ParsedFlags): Promise<number> {
  const existed = await readCreds();
  await clearCreds();
  if (existed) {
    console.log(chalk.green(`\n  ✓ Cleared Ollama credentials for ${existed.endpoint}\n`));
  } else {
    console.log(chalk.gray('\n  No stored Ollama credentials.\n'));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: launch (default)
// ---------------------------------------------------------------------------

async function cmdLaunch(flags: ParsedFlags, opts: { projectRoot: string }): Promise<number> {
  const { baseUrl, apiKey, mode } = await resolveEndpoint(flags);
  const ok = await detectDaemon(baseUrl, { apiKey });
  if (!ok) {
    printNotReachable(baseUrl, mode);
    return 1;
  }

  // Enumerate installed models (cloud endpoint returns available cloud
  // models the API key can hit).
  let rows: OllamaModelRow[] = [];
  try {
    rows = await listModels(baseUrl, { apiKey });
  } catch (err: unknown) {
    console.error(chalk.red(`  Could not list models: ${(err as Error).message}`));
    return 1;
  }

  let chosen = flags.model;
  if (!chosen) {
    if (rows.length === 0) {
      if (!process.stdin.isTTY) {
        console.error('No models installed. Run notch ollama pull <model>, then notch ollama --model <model>.');
        return 1;
      }
      console.log(chalk.yellow(`\n  No models installed at ${baseUrl}.`));
      const suggest = ['qwen3-coder:30b', 'gpt-oss:20b', 'llama3.2:latest'];
      const pick = await pickFromList(
        suggest,
        'Pick one to pull',
      );
      if (!pick) return 0;
      chosen = pick;
      const pullCode = await cmdPull({ ...flags, positional: [chosen] });
      if (pullCode !== 0) return pullCode;
    } else {
      const pick = await pickFromList(rows.map((r) => r.name), 'Select a model');
      if (!pick) return 0;
      chosen = pick;
    }
  } else if (mode === 'local' && !rows.some((r) => r.name === chosen) && !isCloudModel(chosen)) {
    // User specified a model that isn't installed yet — offer to pull.
    const consent = flags.yes
      ? true
      : (await promptLine(`  Model ${chosen} isn't installed. Pull now? [Y/n] `)).toLowerCase() !== 'n';
    if (consent) {
      const pullCode = await cmdPull({ ...flags, positional: [chosen] });
      if (pullCode !== 0) return pullCode;
    } else {
      console.error(chalk.red('  Aborted: model not installed.'));
      return 1;
    }
  }

  // Context window sanity check (Claude-Code integration recommends ≥64k).
  if (mode === 'local') {
    try {
      const info = await showModel(chosen, baseUrl, { apiKey });
      if (info.capabilities && !info.capabilities.includes('tools')) {
        console.error(`  ${chosen} does not advertise tool calling. Choose a tool-capable model for coding.`);
        return 1;
      }
      if (typeof info.contextLength === 'number' && info.contextLength < 64_000) {
        console.warn(
          chalk.yellow(
            `  ⚠ ${chosen} exposes only ${info.contextLength.toLocaleString()} tokens of context. ` +
            `Notch recommends ≥64,000 — agent loops will truncate aggressively.`,
          ),
        );
      }
    } catch {
      // /api/show can fail on cloud aliases; non-fatal.
    }
  }

  // Pick provider id + wire protocol.
  const compat = flags.compat ?? 'openai';
  let providerId: 'ollama' | 'ollama-cloud' | 'ollama-anthropic';
  if (mode === 'cloud') {
    providerId = 'ollama-cloud';
    if (flags.compat === 'anthropic') {
      console.warn(chalk.yellow(
        '  ! --compat anthropic is ignored for Ollama Cloud (only the local daemon exposes /v1/messages).',
      ));
    }
  } else if (compat === 'anthropic') {
    providerId = 'ollama-anthropic';
  } else {
    providerId = 'ollama';
  }

  const providerInfo = findByokProvider(providerId);
  if (!providerInfo) {
    console.error(chalk.red(`  Internal: provider ${providerId} missing from catalog.`));
    return 1;
  }

  // Persist to .notch.json so next invocation is fully zero-flag.
  try {
    await persistOllamaChoice(opts.projectRoot, {
      providerId,
      modelId: chosen,
      // Only persist baseUrl when it differs from the provider default
      // — otherwise the catalog default carries forward and survives
      // future CLI upgrades.
      baseUrl: baseUrl === providerInfo.baseUrl || (mode === 'cloud' && baseUrl === OLLAMA_CLOUD_BASE_URL)
        ? undefined
        : baseUrl,
      apiShape: providerInfo.apiShape,
    });
  } catch (err: unknown) {
    console.warn(chalk.yellow(`  ! Could not write .notch.json: ${(err as Error).message}`));
  }

  console.log('');
  console.log(chalk.green(`  ✓ Ollama configured.`));
  console.log(chalk.gray('    provider '), chalk.white(providerId));
  console.log(chalk.gray('    model    '), chalk.white(chosen));
  console.log(chalk.gray('    endpoint '), chalk.white(baseUrl));
  console.log(chalk.gray('    compat   '), chalk.white(providerInfo.apiShape ?? 'openai'));
  console.log('');
  // Cloud key hint: stored creds are auto-loaded in `notch ollama ...`
  // AND in the main `notch` chat flow (see config.ts), so no manual
  // export is required. We still tell the user where the key lives.
  if (mode === 'cloud' && apiKey && !process.env.OLLAMA_API_KEY) {
    console.log(chalk.gray(`  Ollama Cloud key loaded from  ${credsPath()}`));
  }
  console.log(chalk.gray(`  Run:  notch  (the selection is saved in .notch.json)`));
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Shared error helper
// ---------------------------------------------------------------------------

function printNotReachable(baseUrl: string, mode: 'local' | 'cloud'): void {
  console.error(chalk.red(`\n  Cannot reach Ollama at ${baseUrl}.`));
  if (mode === 'local') {
    console.error(chalk.gray(`  Start the daemon:  ollama serve`));
    console.error(chalk.gray(`  Or install:        https://ollama.com/download\n`));
  } else {
    console.error(chalk.gray(`  Check that OLLAMA_API_KEY is set (notch ollama login).\n`));
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
  Notch CLI — Ollama integration

  Usage:
    notch ollama                 Interactive model setup
    notch ollama launch          Same setup (explicit alias)
    notch ollama list            List installed / cloud models
    notch ollama pull <model>    Pull a model with a progress bar
    notch ollama status          Show daemon reachability
    notch ollama login           Store OLLAMA_API_KEY for Cloud
    notch ollama logout          Clear stored Ollama credentials
    notch ollama bench           Benchmark multiple models on a prompt

  Flags (for every subcommand):
    --cloud                      Use https://ollama.com (Ollama Cloud)
    --host <url>                 Override the daemon base URL
    --model, -m <name>           Model to use / pull / bench
    --api-key <key>              API key override (env: OLLAMA_API_KEY)
    --compat <openai|anthropic>  Wire protocol for local daemon
    -y, --yes                    Auto-confirm destructive prompts

  Examples:
    notch ollama                 Detect daemon, pick a model, save to .notch.json
    notch ollama --cloud         Target Ollama Cloud
    notch ollama --compat anthropic --model qwen3-coder:30b
    notch ollama pull llama3.2:latest
    notch ollama bench "summarize this repo" --model llama3.2,qwen3-coder:30b
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runOllamaCli(argv: readonly string[], cwd: string): Promise<number> {
  // First positional is the subcommand (or "launch" by default).
  const flags = parseFlags(argv);
  if (flags.help) {
    printHelp();
    return 0;
  }
  const sub = flags.positional[0] ?? 'launch';
  // The remaining positionals belong to the sub-sub command.
  const subFlags: ParsedFlags = { ...flags, positional: flags.positional.slice(1) };

  switch (sub) {
    case 'launch':
    case undefined:
      return cmdLaunch(subFlags, { projectRoot: cwd });
    case 'list':
    case 'ls':
      return cmdList(subFlags);
    case 'pull':
      return cmdPull(subFlags);
    case 'status':
      return cmdStatus(subFlags);
    case 'login':
      return cmdLogin(subFlags);
    case 'logout':
      return cmdLogout(subFlags);
    case 'bench': {
      // Dynamic import — keeps ollama-bench.ts free to import helpers
      // from this file without creating a static cycle.
      const { runOllamaBench } = await import('./ollama-bench.js');
      return runOllamaBench(subFlags, { projectRoot: cwd });
    }
    case 'help':
      printHelp();
      return 0;
    default:
      console.error(chalk.red(`  Unknown subcommand: ollama ${sub}`));
      printHelp();
      return 2;
  }
}

// Exports shared with `notch ollama bench` so both subcommands use the
// same endpoint-resolution and progress-rendering code paths.
export {
  type ParsedFlags,
  resolveEndpoint,
  renderProgressLine,
  printNotReachable,
  persistOllamaChoice,
  parseFlags,
};
