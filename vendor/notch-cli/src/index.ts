#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { createCliProgram } from './cli-options.js';

const require = createRequire(import.meta.url);
const version: string = require('../package.json').version;
const args = process.argv.slice(2);

// Keep setup and discovery independent of agent/plugin initialization. Full
// inference dependencies are loaded only when a command needs the runtime.
switch (args[0]) {
  case 'models': {
    if (args[1] === 'coding' || args[1] === 'openrouter') { await import('./runtime.js'); break; }
    const { runLocalModelsCli } = await import('./commands/local-models.js');
    const result = await runLocalModelsCli(args.slice(1));
    process.exitCode = result.code;
    if (result.launch) {
      process.argv = [process.execPath, process.argv[1]!, '--cwd', result.launch];
      await import('./runtime.js');
    }
    break;
  }
  case 'setup': {
    const { runSetupCli } = await import('./commands/setup.js');
    process.exitCode = await runSetupCli(args.slice(1));
    break;
  }
  case 'doctor': {
    const options = new Command('notch doctor')
      .option('--cwd <dir>', 'Project directory', process.cwd())
      .option('--json', 'Machine-readable diagnostics')
      .parse(args.slice(1), { from: 'user' }).opts();
    const { runDiagnostics, formatDiagnostics } = await import('./commands/doctor.js');
    const results = await runDiagnostics(options.cwd);
    console.log(options.json ? JSON.stringify(results) : formatDiagnostics(results));
    process.exitCode = results.some(result => result.status === 'fail') ? 1 : 0;
    break;
  }
  case 'update': {
    const { runUpdateCli } = await import('./commands/update.js');
    await runUpdateCli(args.slice(1));
    break;
  }
  case 'ollama': {
    const { runOllamaCli } = await import('./commands/ollama-launch.js');
    process.exitCode = await runOllamaCli(args.slice(1), process.cwd());
    break;
  }
  case 'config': {
    const { runConfigCli } = await import('./commands/config-set.js');
    process.exitCode = await runConfigCli(args.slice(1), process.cwd());
    break;
  }
  default: {
    // A literal prompt after `--` must never be interpreted as a launcher flag.
    const separator = args.indexOf('--');
    const options = separator < 0 ? args : args.slice(0, separator);
    if (options.some(arg => ['--version', '-V', '--help', '-h'].includes(arg))) {
      createCliProgram(version).parse(process.argv);
    } else {
      await import('./runtime.js');
    }
  }
}
