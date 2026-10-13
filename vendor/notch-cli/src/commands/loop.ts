/**
 * Notch CLI — /loop Command
 *
 * Run a slash command on a recurring interval.
 * Usage: /loop 5m /status      — run /status every 5 minutes
 *        /loop stop             — stop the active loop
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand, dispatchCommand, type CommandContext } from './registry.js';

let activeLoop: {
  timer: ReturnType<typeof setInterval>;
  command: string;
  intervalMs: number;
} | null = null;

/** Stop any active loop — call on session exit to prevent timer leaks. */
export function stopActiveLoop(): void {
  if (activeLoop) {
    clearInterval(activeLoop.timer);
    activeLoop = null;
  }
}

/**
 * Parse a duration string like "30s", "5m", "1h" into milliseconds.
 */
function parseDuration(s: string): number | null {
  const match = s.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  switch (match[2]) {
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    default: return null;
  }
}

function formatDuration(ms: number): string {
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

registerCommand('/loop', async (args, ctx) => {
  // /loop stop
  if (args === 'stop' || args === 'cancel') {
    if (activeLoop) {
      clearInterval(activeLoop.timer);
      console.log(chalk.gray(`  Stopped loop: ${activeLoop.command} (was every ${formatDuration(activeLoop.intervalMs)})\n`));
      activeLoop = null;
    } else {
      console.log(chalk.gray('  No active loop.\n'));
    }
    return;
  }

  // /loop status
  if (args === 'status' || !args) {
    if (activeLoop) {
      console.log(chalk.gray(`  Active loop: ${chalk.white(activeLoop.command)} every ${formatDuration(activeLoop.intervalMs)}\n`));
      console.log(chalk.gray('  Stop with: /loop stop\n'));
    } else {
      console.log(chalk.gray('  No active loop.\n'));
      console.log(chalk.gray('  Usage: /loop <interval> <command>'));
      console.log(chalk.gray('  Example: /loop 5m /status\n'));
    }
    return;
  }

  // Parse: /loop 5m /status
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    console.log(chalk.gray('  Usage: /loop <interval> <command>'));
    console.log(chalk.gray('  Example: /loop 5m /status'));
    console.log(chalk.gray('  Intervals: 30s, 5m, 1h\n'));
    return;
  }

  const intervalMs = parseDuration(parts[0]!);
  if (!intervalMs) {
    console.log(chalk.red(`  Invalid interval: ${parts[0]}`));
    console.log(chalk.gray('  Use formats like: 30s, 5m, 1h\n'));
    return;
  }

  if (intervalMs < 10_000) {
    console.log(chalk.red('  Minimum interval is 10s.\n'));
    return;
  }

  const command = parts.slice(1).join(' ');
  if (!command.startsWith('/')) {
    console.log(chalk.red('  Command must start with /\n'));
    return;
  }

  // Stop existing loop
  if (activeLoop) {
    clearInterval(activeLoop.timer);
  }

  // Start new loop
  const timer = setInterval(async () => {
    console.log(chalk.gray(`\n  [loop] Running: ${command}`));
    try {
      const handled = await dispatchCommand(command, ctx);
      if (!handled) {
        console.log(chalk.gray(`  [loop] Unknown command: ${command}`));
      }
    } catch (err: any) {
      console.log(chalk.red(`  [loop] Error: ${err.message}`));
    }
  }, intervalMs);

  activeLoop = { timer, command, intervalMs };

  console.log(chalk.green(`  ✓ Loop started: ${chalk.white(command)} every ${formatDuration(intervalMs)}`));
  console.log(chalk.gray('  Stop with: /loop stop\n'));
});
