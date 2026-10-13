import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Writable } from 'node:stream';
import { listByokProviders, findByokProvider, type ByokProvider } from '../providers/index.js';
import { loadSyncedByokKeys, saveLocalByokKey, getByokSyncPath } from '../auth.js';

export interface ProviderKeySetupOptions {
  providerId?: string;
}

function setupProviders(): ByokProvider[] {
  return listByokProviders().filter((provider) =>
    Boolean(provider.apiKeyEnv) && !provider.fallbackApiKey
  );
}

function normalizeProviderId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id === 'custom' ? '__custom__' : id;
}

function keyPreview(value: string): string {
  if (value.length <= 8) return 'set';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function promptText(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Set the provider API key environment variable for non-interactive setup.');
  }
  // Readline handles paste, editing, Enter and Ctrl-C; the output sink hides keys.
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = readline.createInterface({ input, output: muted, terminal: true, historySize: 0 });
  const abort = new AbortController();
  const cancel = () => abort.abort();
  rl.on('SIGINT', cancel);
  rl.on('close', cancel);
  output.write(question);
  try { return (await rl.question('', { signal: abort.signal })).trim(); }
  catch { throw new Error('Cancelled'); }
  finally { rl.close(); muted.end(); output.write('\n'); }
}

async function chooseProviders(providerId?: string): Promise<ByokProvider[]> {
  const providers = setupProviders();
  const normalized = normalizeProviderId(providerId);
  if (normalized) {
    const provider = findByokProvider(normalized);
    if (!provider || !providers.some((candidate) => candidate.id === provider.id)) {
      throw new Error(
        `Provider "${providerId}" is not supported by the key wizard. Use one of: ${providers.map((p) => p.id).join(', ')}`,
      );
    }
    return [provider];
  }

  console.log(chalk.gray('\n  Provider API key setup\n'));
  for (const provider of providers) {
    const envStatus = provider.apiKeyEnv && process.env[provider.apiKeyEnv]
      ? chalk.green('env set')
      : chalk.gray(provider.apiKeyEnv);
    console.log(`  ${chalk.cyan(provider.id.padEnd(13))} ${provider.label.padEnd(24)} ${envStatus}`);
  }

  const answer = await promptText(chalk.gray('\n  Provider id, "all", or Enter for openrouter: '));
  if (!answer) return providers.filter((provider) => provider.id === 'openrouter');
  if (answer.toLowerCase() === 'all') return providers;

  const provider = providers.find((candidate) => candidate.id === normalizeProviderId(answer));
  if (!provider) {
    throw new Error(`Unknown provider "${answer}".`);
  }
  return [provider];
}

async function setupProviderKey(provider: ByokProvider): Promise<boolean> {
  const synced = await loadSyncedByokKeys();
  const cached = synced?.keys?.[provider.id];
  const envValue = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;

  console.log('');
  console.log(chalk.white(`  ${provider.label}`));
  console.log(chalk.gray(`  Env var: ${provider.apiKeyEnv}`));
  if (provider.apiKeyUrl) console.log(chalk.gray(`  Key page: ${provider.apiKeyUrl}`));
  if (envValue) console.log(chalk.gray(`  Current shell: ${keyPreview(envValue)}`));
  if (cached) console.log(chalk.gray(`  Cached key: ${keyPreview(cached)}`));

  const key = await promptSecret(chalk.gray('  Paste API key (hidden; Enter to skip): '));
  if (!key) {
    console.log(chalk.gray('  Skipped.'));
    return false;
  }

  await saveLocalByokKey(provider.id, key);
  console.log(chalk.green(`  Saved ${provider.id} key to ${getByokSyncPath()}`));
  return true;
}

export async function runProviderKeySetup(options: ProviderKeySetupOptions = {}): Promise<number> {
  try {
    const providers = await chooseProviders(options.providerId);
    const saved: string[] = [];

    for (const provider of providers) {
      if (await setupProviderKey(provider)) saved.push(provider.id);
    }

    console.log('');
    if (saved.length === 0) {
      console.log(chalk.gray('  No provider keys changed.\n'));
      return 0;
    }

    console.log(chalk.green(`  Saved ${saved.length} provider key(s): ${saved.join(', ')}`));
    console.log(chalk.gray('  Example: notch --model openrouter/anthropic/claude-sonnet-4.6\n'));
    return 0;
  } catch (err) {
    console.error(chalk.red(`\n  Provider setup failed: ${(err as Error).message}\n`));
    return 1;
  }
}
