/**
 * Notch CLI — Init Command (installer-as-function pattern)
 *
 * Scaffolds `.notch.json`, `.notch.md`, and optional capability overlays.
 * Each capability is a standalone installer `(ctx) => Promise<void>` that
 * patches files independently. `initProject` composes the selected installers
 * (interactive picker or passed list) and runs them in sequence.
 *
 * To add a capability:
 *   1. Write an `Installer` in `INSTALLERS` below
 *   2. Add a bullet to the `--help` list in `src/index.ts` if user-facing
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Installer contract
// ---------------------------------------------------------------------------

export interface InstallerContext {
  projectRoot: string;
  selected: Set<string>;
  log: (msg: string) => void;
}

export interface Installer {
  /** Short stable id (e.g. 'base', 'mcp', 'hooks', 'vesta', '1sec', 'telemetry') */
  id: string;
  /** Human label shown in the picker */
  label: string;
  /** One-line description */
  description: string;
  /** Whether it runs even without being explicitly selected (e.g. 'base') */
  required?: boolean;
  /** Runs after picker, in dependency order */
  run: (ctx: InstallerContext) => Promise<void>;
}

// ---------------------------------------------------------------------------
// File helpers (shared by installers)
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function writeIfMissing(
  p: string,
  content: string,
  ctx: InstallerContext,
): Promise<boolean> {
  if (await fileExists(p)) {
    ctx.log(chalk.gray(`  Skipped ${path.relative(ctx.projectRoot, p)} (already exists)`));
    return false;
  }
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
  ctx.log(chalk.green(`  Created ${path.relative(ctx.projectRoot, p)}`));
  return true;
}

async function patchJson(
  p: string,
  patch: (current: Record<string, unknown>) => Record<string, unknown>,
  ctx: InstallerContext,
): Promise<void> {
  let current: Record<string, unknown> = {};
  if (await fileExists(p)) {
    const raw = await fs.readFile(p, 'utf-8');
    try { current = JSON.parse(raw); } catch { current = {}; }
  }
  const next = patch(current);
  await fs.writeFile(p, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  ctx.log(chalk.green(`  Patched ${path.relative(ctx.projectRoot, p)}`));
}

async function ensureGitignoreEntries(
  p: string,
  entries: string[],
  sectionTitle: string,
  ctx: InstallerContext,
): Promise<void> {
  if (!(await fileExists(p))) return;
  const current = await fs.readFile(p, 'utf-8');
  const missing = entries.filter((e) => !current.includes(e));
  if (missing.length === 0) return;
  const append = `\n# ${sectionTitle}\n` + missing.join('\n') + '\n';
  await fs.appendFile(p, append, 'utf-8');
  ctx.log(chalk.green(`  Updated .gitignore (+${missing.length})`));
}

// ---------------------------------------------------------------------------
// Installers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  model: 'openrouter/anthropic/claude-sonnet-4.6',
  temperature: 0.3,
  maxIterations: 25,
  useRepoMap: true,
  renderMarkdown: true,
  permissionMode: 'auto',
  // Provider passthrough — disabled by default.
  // Uncomment `provider` below (and remove the "_" prefix) to route every
  // request to an OpenAI-compatible endpoint (OpenAI / Anthropic /
  // OpenRouter / Google / DeepSeek / Together / Fireworks / Groq / Ollama / vLLM / LM Studio
  // / custom). Providers read their key from the corresponding env var —
  // e.g. OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY.
  // Run `notch --list-providers` to see all built-in ids.
  _providerExample: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
  },
};

const DEFAULT_INSTRUCTIONS = `# Project Instructions for Notch

<!--
  These instructions are loaded into Notch's system prompt every session.
  Use them to customize how Notch behaves in this project.
-->

## Project Overview
<!-- Describe what this project is and what it does -->

## Code Conventions
<!-- Coding style preferences, naming conventions, etc. -->
- Follow existing patterns in the codebase
- Use TypeScript strict mode

## Important Notes
<!-- Any gotchas, special setup, or things Notch should know -->

## Off-Limits
<!-- Files or areas Notch should NOT modify -->
`;

const baseInstaller: Installer = {
  id: 'base',
  label: 'Base config',
  description: '.notch.json + .notch.md + .gitignore entries',
  required: true,
  async run(ctx) {
    await writeIfMissing(
      path.join(ctx.projectRoot, '.notch.json'),
      JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n',
      ctx,
    );
    await writeIfMissing(
      path.join(ctx.projectRoot, '.notch.md'),
      DEFAULT_INSTRUCTIONS,
      ctx,
    );
    await ensureGitignoreEntries(
      path.join(ctx.projectRoot, '.gitignore'),
      ['.notch.json'],
      'Notch CLI',
      ctx,
    );
  },
};

const mcpInstaller: Installer = {
  id: 'mcp',
  label: 'MCP servers',
  description: 'Add the mcpServers block to .notch.json (example: github)',
  async run(ctx) {
    await patchJson(
      path.join(ctx.projectRoot, '.notch.json'),
      (cur) => ({
        ...cur,
        mcpServers: (cur.mcpServers as Record<string, unknown>) ?? {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${env:GITHUB_TOKEN}' },
          },
        },
      }),
      ctx,
    );
  },
};

const hooksInstaller: Installer = {
  id: 'hooks',
  label: 'Git/lifecycle hooks',
  description: 'Add hooks array scaffold to .notch.json',
  async run(ctx) {
    await patchJson(
      path.join(ctx.projectRoot, '.notch.json'),
      (cur) => ({
        ...cur,
        hooks: (cur.hooks as unknown[]) ?? [
          { event: 'pre-tool', match: { tool: 'shell' }, run: 'echo "About to run shell"' },
        ],
      }),
      ctx,
    );
  },
};

const vestaInstaller: Installer = {
  id: 'vesta',
  label: 'Vesta agents',
  description: 'Scaffold .notch/agents/ directory for Vesta agent configs',
  async run(ctx) {
    const dir = path.join(ctx.projectRoot, '.notch', 'agents');
    await fs.mkdir(dir, { recursive: true });
    await writeIfMissing(
      path.join(dir, 'README.md'),
      `# Vesta Agents\n\nDrop agent JSON/TOML configs in this directory. Notch will load them at startup.\n`,
      ctx,
    );
  },
};

const oneSecInstaller: Installer = {
  id: '1sec',
  label: '1-SEC security checks',
  description: 'Enable 1-SEC opt-in and add the block to .notch.json',
  async run(ctx) {
    await patchJson(
      path.join(ctx.projectRoot, '.notch.json'),
      (cur) => ({
        ...cur,
        security: (cur.security as Record<string, unknown>) ?? {
          provider: '1sec',
          enabled: true,
          scanOn: ['pre-commit', 'pre-tool:shell', 'pre-tool:write'],
        },
      }),
      ctx,
    );
  },
};

const telemetryInstaller: Installer = {
  id: 'telemetry',
  label: 'Anonymous telemetry',
  description: 'Enable opt-in anonymous usage stats',
  async run(ctx) {
    await patchJson(
      path.join(ctx.projectRoot, '.notch.json'),
      (cur) => ({ ...cur, telemetry: { enabled: true, anonymous: true } }),
      ctx,
    );
  },
};

const agentsMdInstaller: Installer = {
  id: 'agents-md',
  label: 'AGENTS.md',
  description: 'Industry-standard agent instructions file (shared with Codex, Cursor, etc.)',
  async run(ctx) {
    await writeIfMissing(
      path.join(ctx.projectRoot, 'AGENTS.md'),
      `# Agent Instructions\n\nShared instructions for AI coding agents working in this repo.\n\n## Build\n\n## Test\n\n## Style\n\n## Caveats\n`,
      ctx,
    );
  },
};

export const INSTALLERS: Installer[] = [
  baseInstaller,
  agentsMdInstaller,
  mcpInstaller,
  hooksInstaller,
  vestaInstaller,
  oneSecInstaller,
  telemetryInstaller,
];

// ---------------------------------------------------------------------------
// Interactive picker
// ---------------------------------------------------------------------------

async function pickInstallers(all: Installer[]): Promise<Set<string>> {
  const optional = all.filter((i) => !i.required);
  const selected = new Set<string>();

  process.stdout.write(chalk.cyan('\n  Select optional capabilities (space to toggle, Enter to confirm):\n\n'));

  // Preselect none; user opts in.
  let cursor = 0;
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  const draw = (first: boolean) => {
    if (!first) process.stdout.write(`\x1b[${optional.length + 1}A\x1b[J`);
    for (let i = 0; i < optional.length; i++) {
      const item = optional[i]!;
      const pointer = i === cursor ? chalk.cyan('❯') : ' ';
      const box = selected.has(item.id) ? chalk.green('[x]') : '[ ]';
      process.stdout.write(`  ${pointer} ${box} ${chalk.bold(item.label.padEnd(24))} ${chalk.gray(item.description)}\n`);
    }
    process.stdout.write('\n');
  };

  draw(true);

  return new Promise((resolve) => {
    const onKey = (key: Buffer) => {
      const s = key.toString();
      if (s === '\x1b[A') { cursor = (cursor - 1 + optional.length) % optional.length; draw(false); }
      else if (s === '\x1b[B') { cursor = (cursor + 1) % optional.length; draw(false); }
      else if (s === ' ') {
        const id = optional[cursor]!.id;
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        draw(false);
      } else if (s === '\r' || s === '\n') {
        cleanup(); resolve(selected);
      } else if (s === '\x1b' || s === '\x03') {
        cleanup(); resolve(new Set());
      }
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
// Entry point
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** If set, skip the interactive picker and use these ids */
  features?: string[];
  /** If true, skip picker entirely and run only required installers */
  minimal?: boolean;
  /** If true, run every installer */
  all?: boolean;
}

export async function initProject(projectRoot: string, opts: InitOptions = {}): Promise<void> {
  const log = (msg: string) => console.log(msg);

  let selectedIds: Set<string>;
  if (opts.all) {
    selectedIds = new Set(INSTALLERS.filter((i) => !i.required).map((i) => i.id));
  } else if (opts.minimal) {
    selectedIds = new Set();
  } else if (opts.features && opts.features.length > 0) {
    selectedIds = new Set(opts.features);
  } else if (process.stdin.isTTY) {
    selectedIds = await pickInstallers(INSTALLERS);
  } else {
    selectedIds = new Set();
  }

  const ctx: InstallerContext = { projectRoot, selected: selectedIds, log };

  // Always run required installers first, then selected optional ones in declared order.
  const plan = INSTALLERS.filter((i) => i.required || selectedIds.has(i.id));
  for (const installer of plan) {
    log(chalk.cyan(`\n  → ${installer.label}`));
    try {
      await installer.run(ctx);
    } catch (err: any) {
      log(chalk.red(`  ✗ ${installer.id} failed: ${err.message}`));
    }
  }

  log('');
  log(chalk.cyan(`  Notch initialized with ${plan.length} module(s).`));
  log(chalk.gray(`  Edit .notch.md to customize behavior. Run "notch" to start.\n`));
}
