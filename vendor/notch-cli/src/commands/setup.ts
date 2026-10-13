import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { persistConfigPatch } from '../config.js';
import { listModels, showModel } from '../providers/ollama.js';
import { ollamaChatUrl, ollamaRoot } from '../providers/ollama-url.js';
import { findByokProvider, validateByokConfig } from '../providers/byok.js';
import { runProviderKeySetup } from './provider-key-setup.js';

/** Setup stores model preferences in the project; API keys stay in the user's credential store. */
export async function runSetupCli(argv: string[]): Promise<number> {
  const command = new Command('notch setup')
    .description('Choose a model provider and verify the connection; no sign-in required')
    .option('--provider <id>', 'ollama, openrouter, openai, or anthropic')
    .option('--model <id>', 'Installed Ollama tag or provider model id')
    .option('--host <url>', 'Ollama server (default: OLLAMA_HOST or localhost:11434)')
    .option('--cwd <dir>', 'Project directory', process.cwd());
  command.parse(argv, { from: 'user' });
  const flags = command.opts();
  let rl: ReturnType<typeof createInterface> | undefined;
  const ask = async (question: string) => {
    if (!process.stdin.isTTY) throw new Error('Pass --provider and --model for non-interactive setup.');
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    return (await rl.question(question)).trim();
  };
  try {
    const providers = ['ollama', 'openrouter', 'openai', 'anthropic'];
    if (!flags.provider) console.log('Choose your model provider:\n  1. Ollama - local models, no API key\n  2. OpenRouter - one API key, many models\n  3. OpenAI - your OpenAI API key\n  4. Anthropic - your Claude Console API key\n');
    const answer = flags.provider || (await ask('Provider number or name (1): ')) || '1';
    const provider = providers[Number(answer) - 1] || answer.toLowerCase();
    if (!providers.includes(provider)) throw new Error('Choose ollama, openrouter, openai, or anthropic.');
    let model: string = flags.model || '';
    let baseUrl: string | undefined;
    if (provider === 'ollama') {
      const root = ollamaRoot(flags.host);
      const rows = await listModels(root).catch(() => {
        throw new Error(`Cannot reach Ollama at ${root}. Start ollama serve, then retry notch setup.`);
      });
      if (!rows.length) throw new Error('No local models. Run notch models install for Hugging Face choices sized to your available memory.');
      if (!model) {
        rows.forEach((row, i) => console.log(`  ${i + 1}. ${row.name} (${row.parameterSize})`));
        const answer = await ask('Model number or name (1): ');
        model = rows[Number(answer || '1') - 1]?.name || answer;
      }
      const installed = rows.find(row => row.name === model || row.name === `${model}:latest`);
      if (!installed) throw new Error(`Model ${model} is not installed. Run notch ollama pull ${model}.`);
      model = installed.name;
      const info = await showModel(model, root);
      if (info.capabilities && !info.capabilities.includes('tools')) {
        throw new Error(`${model} does not advertise tool calling. Choose a tool-capable coding model.`);
      }
      baseUrl = ollamaChatUrl(root);
    } else {
      if (flags.host) throw new Error('--host is only for Ollama.');
      if (!model && provider === 'openrouter') {
        const { getOpenRouterCodingModels } = await import('../providers/openrouter-models.js');
        const result = await getOpenRouterCodingModels();
        console.log(`OpenRouter coding models (${result.source}):`);
        result.models.forEach((row, i) => console.log(`  ${i + 1}. ${row.id} (${row.contextLength.toLocaleString()} context)`));
        const answer = await ask('Model number or id (1): ');
        model = result.models[Number(answer || '1') - 1]?.id || answer;
      }
      if (!model && provider !== 'openrouter') {
        const info = findByokProvider(provider)!;
        info.models?.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
        const answer = await ask('Model number or id (1): ');
        model = info.models?.[Number(answer || '1') - 1] || answer || info.defaultModel;
      }
      model ||= findByokProvider(provider)!.defaultModel;
      rl?.close(); rl = undefined;
      let check = await validateByokConfig({ provider, model });
      if (!check.ok && process.stdin.isTTY && check.error?.includes('API key')) {
        if (await runProviderKeySetup({ providerId: provider })) return 1;
        check = await validateByokConfig({ provider, model });
      }
      if (!check.ok) throw new Error(check.error);
    }
    await persistConfigPatch(path.resolve(flags.cwd), {
      provider: { provider, model, ...(baseUrl ? { baseUrl } : {}) },
      byok: undefined, model: undefined, baseUrl: undefined, apiKey: undefined,
    });
    console.log(`Ready: ${provider}/${model}\nSaved .notch.json in ${path.resolve(flags.cwd)}\nRun notch in that directory to start coding.`);
    return 0;
  } catch (error) {
    console.error(`Setup failed: ${(error as Error).message}`);
    return 1;
  } finally {
    rl?.close();
  }
}
