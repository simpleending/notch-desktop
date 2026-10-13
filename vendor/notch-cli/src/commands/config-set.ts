/**
 * Notch CLI — `notch config` subcommand.
 *
 * Persistent knob for `.notch.json` that doesn't require entering the REPL:
 *
 *   notch config get                         → dump the current file
 *   notch config get <key>                   → dump one key
 *   notch config set <key> <value>           → shallow-merge + write
 *   notch config unset <key>                 → delete + write
 *   notch config yolo [on|off]               → one-word alias for
 *                                              permissionMode=trust
 *                                              + autoConfirm=true
 *
 * Values are accepted as JSON first (so `true`, `false`, numbers, and
 * JSON objects parse naturally); if that fails they fall through as raw
 * strings. This is how you'd flip on trust mode once and have it stick:
 *
 *   notch config yolo on
 *   notch config set permissionMode trust
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { persistConfigPatch } from '../config.js';

const HELP = `notch config — manage .notch.json settings

Usage:
  notch config get [key]
  notch config set <key> <value>
  notch config unset <key>
  notch config yolo [on|off]        # auto-allow every tool call (sticks)

Examples:
  notch config set permissionMode trust
  notch config set autoConfirm true
  notch config set model pyre
  notch config yolo on
  notch config yolo off
`;

function parseValue(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

async function readCurrent(projectRoot: string): Promise<Record<string, unknown>> {
  const p = path.resolve(projectRoot, '.notch.json');
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* missing / invalid → empty */ }
  return {};
}

export async function runConfigCli(argv: string[], projectRoot: string): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  if (sub === 'get') {
    const key = argv[1];
    const cur = await readCurrent(projectRoot);
    if (!key) {
      process.stdout.write(JSON.stringify(cur, null, 2) + '\n');
      return 0;
    }
    if (key in cur) {
      process.stdout.write(JSON.stringify(cur[key]) + '\n');
      return 0;
    }
    process.stderr.write(`notch: no such key: ${key}\n`);
    return 1;
  }

  if (sub === 'set') {
    const key = argv[1];
    const value = argv.slice(2).join(' ');
    if (!key || value.length === 0) {
      process.stderr.write('usage: notch config set <key> <value>\n');
      return 2;
    }
    const parsed = parseValue(value);
    const merged = await persistConfigPatch(projectRoot, { [key]: parsed });
    process.stdout.write(`${key} = ${JSON.stringify(merged[key])}\n`);
    return 0;
  }

  if (sub === 'unset') {
    const key = argv[1];
    if (!key) {
      process.stderr.write('usage: notch config unset <key>\n');
      return 2;
    }
    await persistConfigPatch(projectRoot, { [key]: undefined });
    process.stdout.write(`removed ${key}\n`);
    return 0;
  }

  if (sub === 'yolo') {
    // `notch config yolo` (no arg) toggles; `on`/`true`/`1` force on;
    // `off`/`false`/`0` force off. Same effect as `/yolo` in the REPL.
    const arg = (argv[1] ?? '').toLowerCase();
    const cur = await readCurrent(projectRoot);
    const currentlyOn = cur.permissionMode === 'trust';
    const turnOn =
      arg === '' ? !currentlyOn :
      (arg === 'on' || arg === 'true' || arg === '1' || arg === 'yes');
    await persistConfigPatch(projectRoot, {
      permissionMode: turnOn ? 'trust' : 'auto',
      autoConfirm: turnOn ? true : undefined,
    });
    process.stdout.write(turnOn
      ? 'YOLO mode ON — every tool call auto-allowed. Saved to .notch.json.\n'
      : 'YOLO mode OFF — prompts restored. Saved to .notch.json.\n');
    return 0;
  }

  process.stderr.write(`notch: unknown config subcommand: ${sub}\n`);
  process.stderr.write(HELP);
  return 2;
}
