import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
export const cliEntry = path.join(path.dirname(require.resolve('@freesyntax/notch-cli/package.json')), 'dist/index.js');

/** Run the published harness without shell interpolation or renderer access to Node. */
export function runCli(args, { cwd = process.cwd(), signal, onOutput, executable = process.execPath, entry = cliEntry } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [entry, ...args], { cwd, signal, windowsHide: true,
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure;
    const fail = error => { failure ??= error; };
    child.once('error', fail);
    const receive = (stream, chunk) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout += text; else stderr += text;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 16 * 2 ** 20) { child.kill(); fail(new Error('CLI output exceeded 16 MiB.')); return; }
      try { onOutput?.({ stream, text }); } catch (error) { child.kill(); fail(error); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => receive('stdout', chunk)); child.stderr.on('data', chunk => receive('stderr', chunk));
    child.once('close', code => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(stderr.trim() || `Notch exited with status ${code}.`));
      else resolve({ stdout, stderr });
    });
  });
}

export async function localModels({ runner, ...options } = {}) {
  if (runner && !['ollama', 'mlx'].includes(runner)) throw new Error('Choose ollama or mlx.');
  const result = await runCli(['models', 'recommend', '--json', ...(runner ? ['--runner', runner] : [])], options);
  const catalog = JSON.parse(result.stdout);
  if (!catalog.hardware || !Array.isArray(catalog.models)) throw new Error('Notch returned an invalid model catalog.');
  return catalog;
}

export function installLocalModel(repo, runner, options) {
  if (!/^[\w](?:[\w.-]*[\w])?\/[\w](?:[\w.-]*[\w])?$/.test(repo)) throw new Error('Choose a public owner/model repository.');
  if (!['ollama', 'mlx'].includes(runner)) throw new Error('Choose ollama or mlx.');
  // Invoke only after the UI confirms the selected model/runtime download.
  return runCli(['models', 'install', '--model', repo, '--runner', runner, '--yes', '--no-launch'], options);
}

export function unloadLocalModel(options) { return runCli(['models', 'unload'], options); }
