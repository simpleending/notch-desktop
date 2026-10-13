/**
 * Notch CLI — /plugin Command
 *
 * Manage plugins: list, install, remove.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { registerCommand } from './registry.js';
import { pluginManager } from '../plugins/index.js';

const GLOBAL_PLUGINS_DIR = path.join(os.homedir(), '.notch', 'plugins');

registerCommand('/plugin', async (args, ctx) => {
  const parts = args.split(/\s+/);
  const subcommand = parts[0] || 'list';
  const target = parts.slice(1).join(' ');

  switch (subcommand) {
    case 'list':
    case 'ls': {
      const plugins = pluginManager.list();
      if (plugins.length === 0) {
        console.log(chalk.gray('  No plugins installed.\n'));
        console.log(chalk.gray('  Install one: /plugin install <npm-package-or-git-url>\n'));
        return;
      }
      console.log(chalk.gray('\n  Installed plugins:\n'));
      for (const p of plugins) {
        const toolCount = p.tools.length;
        const hookCount = p.hooks.length;
        const meta = [
          toolCount > 0 ? `${toolCount} tool${toolCount > 1 ? 's' : ''}` : '',
          hookCount > 0 ? `${hookCount} hook${hookCount > 1 ? 's' : ''}` : '',
        ].filter(Boolean).join(', ');
        console.log(`  ${chalk.green('●')} ${chalk.white(p.name)} ${chalk.gray(`v${p.version}`)}${meta ? chalk.gray(` (${meta})`) : ''}`);
        if (p.description) {
          console.log(chalk.gray(`    ${p.description}`));
        }
      }
      console.log('');
      return;
    }

    case 'install':
    case 'add': {
      if (!target) {
        console.log(chalk.gray('  Usage: /plugin install <npm-package-or-git-url>\n'));
        return;
      }

      await fs.mkdir(GLOBAL_PLUGINS_DIR, { recursive: true });
      const pluginDir = path.join(GLOBAL_PLUGINS_DIR, path.basename(target).replace(/\.git$/, ''));

      console.log(chalk.gray(`  Installing ${target}...`));

      try {
        if (target.includes('/') && !target.startsWith('@')) {
          // Git clone — uses execFileSync args array to prevent injection
          execFileSync('git', ['clone', '--depth', '1', target, pluginDir], {
            encoding: 'utf-8',
            timeout: 60_000,
            stdio: 'pipe',
          });
        } else {
          // npm install into a directory
          await fs.mkdir(pluginDir, { recursive: true });
          execFileSync('npm', ['init', '-y'], {
            cwd: pluginDir, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
          });
          execFileSync('npm', ['install', target], {
            cwd: pluginDir, encoding: 'utf-8', timeout: 120_000, stdio: 'pipe',
          });
        }

        // Install dependencies if present
        try {
          const pkgExists = await fs.access(path.join(pluginDir, 'package.json')).then(() => true).catch(() => false);
          if (pkgExists) {
            execSync('npm install --production', {
              cwd: pluginDir,
              encoding: 'utf-8',
              timeout: 120_000,
              stdio: 'pipe',
            });
          }
        } catch {
          // Dependencies optional
        }

        console.log(chalk.green(`  ✓ Installed to ${pluginDir}`));
        console.log(chalk.gray('  Restart notch to load the plugin.\n'));
      } catch (err: any) {
        console.log(chalk.red(`  Install failed: ${err.message}\n`));
      }
      return;
    }

    case 'remove':
    case 'rm':
    case 'uninstall': {
      if (!target) {
        console.log(chalk.gray('  Usage: /plugin remove <plugin-name>\n'));
        return;
      }

      // Search in global plugins
      const pluginDir = path.join(GLOBAL_PLUGINS_DIR, target);
      try {
        await fs.access(pluginDir);
        await fs.rm(pluginDir, { recursive: true, force: true });
        console.log(chalk.green(`  ✓ Removed ${target}`));
        console.log(chalk.gray('  Restart notch to apply.\n'));
      } catch {
        console.log(chalk.red(`  Plugin not found: ${target}\n`));
      }
      return;
    }

    default:
      console.log(chalk.gray('  Usage: /plugin <list|install|remove> [name]\n'));
  }
});
