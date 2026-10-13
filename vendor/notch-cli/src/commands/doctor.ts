/**
 * Notch CLI — /doctor Command
 *
 * Diagnoses installation health: Node version, git, API connectivity,
 * config files, MCP servers, and disk space.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { registerCommand } from './registry.js';
import { validateConfig, isByokRef, resolveModel } from '../providers/index.js';
import { loadConfig } from '../config.js';
import { parseMCPConfig, MCPClient } from '../mcp/index.js';

interface DiagnosticResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export async function runDiagnostics(cwd: string): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  // 1. Node.js version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0]!, 10);
  if (major >= 20) {
    results.push({ name: 'Node.js', status: 'ok', message: `v${nodeVersion}` });
  } else if (major >= 18) {
    results.push({ name: 'Node.js', status: 'warn', message: `v${nodeVersion} (recommend >= 20)` });
  } else {
    results.push({ name: 'Node.js', status: 'fail', message: `v${nodeVersion} (requires >= 18)` });
  }

  // 2. Git available
  try {
    const gitVersion = execSync('git --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    results.push({ name: 'Git', status: 'ok', message: gitVersion });
  } catch {
    results.push({ name: 'Git', status: 'fail', message: 'Not found. Install git to use git tools.' });
  }

  // 3. API key configured
  try {
    const config = await loadConfig({ projectRoot: cwd });
    // Local inference needs no login. Resolve provider credentials exactly as inference does.
    const providerRouted = config.models.chat.byokProvider || isByokRef(config.models.chat.model);
    try {
      if (providerRouted) resolveModel(config.models.chat);
      else if (!config.models.chat.apiKey) throw new Error('Not set. Run notch setup.');
      results.push({ name: 'Credentials', status: 'ok', message: providerRouted ? 'Provider configured (local providers need no key)' : 'Configured' });
    } catch (error) {
      results.push({ name: 'Credentials', status: 'fail', message: (error as Error).message });
    }

    // 4. API reachable
    try {
      const check = await validateConfig(config.models.chat);
      if (check.ok) {
        results.push({ name: 'API Endpoint', status: 'ok', message: `${config.models.chat.model} reachable` });
      } else {
        results.push({ name: 'API Endpoint', status: 'fail', message: check.error ?? 'Unreachable' });
      }
    } catch (err: any) {
      results.push({ name: 'API Endpoint', status: 'fail', message: err.message });
    }
  } catch (err: any) {
    results.push({ name: 'Config', status: 'fail', message: `Could not load: ${err.message}` });
  }

  // 5. .notch.json exists
  try {
    await fs.access(path.join(cwd, '.notch.json'));
    results.push({ name: '.notch.json', status: 'ok', message: 'Found' });
  } catch {
    results.push({ name: '.notch.json', status: 'warn', message: 'Not found. Run: notch init' });
  }

  // 6. ~/.notch/ directory
  const notchDir = path.join(os.homedir(), '.notch');
  try {
    await fs.access(notchDir);
    results.push({ name: '~/.notch/', status: 'ok', message: 'Exists' });
  } catch {
    results.push({ name: '~/.notch/', status: 'warn', message: 'Not found (will be created on first use)' });
  }

  // 7. .notch.md exists
  try {
    await fs.access(path.join(cwd, '.notch.md'));
    results.push({ name: '.notch.md', status: 'ok', message: 'Found' });
  } catch {
    results.push({ name: '.notch.md', status: 'warn', message: 'Not found. Run: notch init' });
  }

  // 8. MCP servers
  try {
    const configRaw = await fs.readFile(path.join(cwd, '.notch.json'), 'utf-8').catch(() => '{}');
    const mcpConfigs = parseMCPConfig(JSON.parse(configRaw));
    const serverNames = Object.keys(mcpConfigs);
    if (serverNames.length === 0) {
      results.push({ name: 'MCP Servers', status: 'ok', message: 'None configured' });
    } else {
      for (const name of serverNames) {
        try {
          const client = new MCPClient(mcpConfigs[name]!, name);
          await client.connect();
          results.push({ name: `MCP: ${name}`, status: 'ok', message: `${client.tools.length} tools` });
          client.disconnect();
        } catch (err: any) {
          results.push({ name: `MCP: ${name}`, status: 'fail', message: err.message });
        }
      }
    }
  } catch {
    results.push({ name: 'MCP Servers', status: 'ok', message: 'No config to check' });
  }

  // 9. Disk space (best-effort)
  try {
    const sessionsDir = path.join(notchDir, 'sessions');
    const entries = await fs.readdir(sessionsDir).catch(() => []);
    results.push({ name: 'Sessions', status: 'ok', message: `${entries.length} saved` });
  } catch {
    results.push({ name: 'Sessions', status: 'ok', message: '0 saved' });
  }

  return results;
}

export function formatDiagnostics(results: DiagnosticResult[]): string {
  const icons = { ok: chalk.green('✓'), warn: chalk.yellow('!'), fail: chalk.red('✗') };
  const lines = results.map((r) => {
    const icon = icons[r.status];
    const name = r.name.padEnd(16);
    return `  ${icon} ${name} ${chalk.gray(r.message)}`;
  });
  return '\n' + lines.join('\n') + '\n';
}

registerCommand('/doctor', async (_args, ctx) => {
  ctx.log('Running diagnostics...');
  const results = await runDiagnostics(ctx.cwd);
  console.log(formatDiagnostics(results));

  const failCount = results.filter((r) => r.status === 'fail').length;
  const warnCount = results.filter((r) => r.status === 'warn').length;

  if (failCount > 0) {
    console.log(chalk.red(`  ${failCount} issue(s) need attention.\n`));
  } else if (warnCount > 0) {
    console.log(chalk.yellow(`  All clear with ${warnCount} suggestion(s).\n`));
  } else {
    console.log(chalk.green('  Everything looks good!\n'));
  }
});
