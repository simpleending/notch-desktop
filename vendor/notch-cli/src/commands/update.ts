/**
 * Notch CLI — /update Command
 *
 * Slash-command surface for the self-updater. Also used by the
 * `notch update` CLI subcommand (runUpdateCli below) so both
 * interactive and headless flows go through the same code path.
 *
 * Usage in REPL:
 *   /update                          Force a check + install on the current channel.
 *   /update --check                  Check only; do not install.
 *   /update --channel <latest|next|beta>
 *                                    Change the persistent update channel.
 *
 * Usage as CLI subcommand:
 *   notch update
 *   notch update --check
 *   notch update --channel next
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand, type CommandContext } from './registry.js';
import {
  PACKAGE_NAME,
  checkForUpdates,
  isValidChannel,
  readSavedChannel,
  restartCli,
  saveChannel,
  type UpdateChannel,
  type UpdateResult,
} from '../ui/update-checker.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);

/**
 * Find the package.json for @freesyntax/notch-cli itself. The CLI is
 * distributed as a single bundled `dist/index.js`, so we can't rely on
 * a hard-coded `../../package.json` relative to the source file. Walk
 * up from the running script's directory looking for a package.json
 * whose `name` matches.
 */
function resolveVersion(): string {
  try {
    const entry = process.argv[1];
    let dir = entry ? path.dirname(entry) : fileURLToPath(new URL('.', import.meta.url));
    const root = path.parse(dir).root;
    while (dir && dir !== root) {
      const candidate = path.join(dir, 'package.json');
      try {
        const pkg = _require(candidate);
        if (pkg && pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') {
          return pkg.version;
        }
      } catch {
        // ignore and keep climbing
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

interface ParsedArgs {
  checkOnly: boolean;
  channel?: UpdateChannel;
  invalidChannel?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { checkOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--check' || a === '-n') {
      out.checkOnly = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--channel') {
      const v = argv[++i];
      if (!v) continue;
      if (isValidChannel(v)) out.channel = v;
      else out.invalidChannel = v;
    } else if (a.startsWith('--channel=')) {
      const v = a.slice('--channel='.length);
      if (isValidChannel(v)) out.channel = v;
      else out.invalidChannel = v;
    }
  }
  return out;
}

function usage(): string {
  return [
    'Usage:',
    '  /update                          Check for a newer version and install it.',
    '  /update --check                  Check only; do not install.',
    '  /update --channel <name>         Set channel (latest | next | beta).',
    '',
    'Env: NOTCH_AUTO_UPDATE=0 disables background checks on launch.',
  ].join('\n');
}

function formatResult(r: UpdateResult): string {
  const head = chalk.gray(`  channel=${r.channel} current=v${r.current}`);
  switch (r.status) {
    case 'up-to-date':
      return [head, chalk.green(`  ✓ Already on the latest version${r.latest ? ` (v${r.latest})` : ''}.`)].join('\n');
    case 'newer-available':
      return [
        head,
        chalk.cyan(`  ↑ v${r.latest} is available. Run /update to install.`),
      ].join('\n');
    case 'installed':
      return [
        head,
        chalk.green(`  ✓ Installed v${r.latest}. Restart Notch to use the new version.`),
      ].join('\n');
    case 'install-failed':
      return [
        head,
        chalk.red(`  ✗ Install failed: ${r.message ?? 'unknown error'}`),
        chalk.gray(`  Retry manually: npm install -g ${PACKAGE_NAME}@${r.latest ?? 'latest'}`),
      ].join('\n');
    case 'check-failed':
      return [head, chalk.yellow(`  ! Could not reach npm registry: ${r.message ?? 'unknown error'}`)].join('\n');
    case 'skipped':
      return [head, chalk.gray(`  · Skipped (${r.message ?? 'disabled'})`)].join('\n');
  }
}

/**
 * Run the update flow. Shared between the slash command and the
 * `notch update` CLI subcommand.
 */
export async function runUpdate(
  args: ParsedArgs,
  opts: { autoInstall: boolean; log: (msg: string) => void },
): Promise<UpdateResult | null> {
  if (args.help) {
    opts.log(usage());
    return null;
  }

  if (args.invalidChannel) {
    opts.log(chalk.red(`  Unknown channel: ${args.invalidChannel}`));
    opts.log(chalk.gray('  Valid channels: latest, next, beta'));
    return null;
  }

  if (args.channel) {
    await saveChannel(args.channel);
    opts.log(chalk.green(`  ✓ Update channel set to '${args.channel}'.`));
    // Continue to run a check against the new channel so the user sees a fresh result.
  }

  const channel = args.channel ?? (await readSavedChannel()) ?? 'latest';
  const version = resolveVersion();
  const result = await checkForUpdates(version, {
    channel,
    force: true,
    autoInstall: !args.checkOnly && opts.autoInstall,
  });
  opts.log(formatResult(result));
  return result;
}

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------

registerCommand('/update', async (argStr: string, ctx: CommandContext) => {
  const parts = argStr.trim().length > 0 ? argStr.trim().split(/\s+/) : [];
  const parsed = parseArgs(parts);

  const result = await runUpdate(parsed, {
    // Inside an interactive REPL we don't auto-restart — print the result and
    // let the user relaunch on their own time.
    autoInstall: !parsed.checkOnly,
    log: ctx.log,
  });

  if (result?.status === 'installed') {
    ctx.log(chalk.gray('  Exit Notch (Ctrl-D or /exit) and relaunch to use the new version.'));
  }
});

// ---------------------------------------------------------------------------
// Headless CLI entry point (used by `notch update`)
// ---------------------------------------------------------------------------

export async function runUpdateCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const result = await runUpdate(parsed, {
    autoInstall: !parsed.checkOnly,
    log: (msg: string) => console.log(msg),
  });
  if (!result) return;
  // In headless mode, if we just installed a new version and the user
  // passed extra args meant for the running session, transparently
  // re-exec into the new binary. The common case is `notch update` on
  // its own, though — in which case we just exit 0.
  if (result.status === 'installed' && process.argv.length > 3) {
    const passthrough = argv.filter(
      (a, i, arr) =>
        a !== '--check' &&
        a !== '--help' &&
        a !== '-h' &&
        a !== '-n' &&
        a !== '--channel' &&
        !(arr[i - 1] === '--channel') &&
        !a.startsWith('--channel='),
    );
    restartCli(passthrough);
  }
  if (result.status === 'install-failed' || result.status === 'check-failed') {
    process.exitCode = 1;
  }
}
