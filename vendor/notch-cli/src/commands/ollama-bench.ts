/**
 * Notch CLI — `notch ollama bench`
 *
 * Runs a prompt against N Ollama models in series and reports a ranked
 * table of first-token latency, throughput, total time, and token
 * counts. Useful for picking the fastest local model for a given
 * machine — something `ollama launch` doesn't ship.
 *
 * Writes structured results to `.notch/ollama-bench.json` so successive
 * runs can be diffed (e.g. after a kernel upgrade or a new quant).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { streamText, type ModelMessage } from 'ai';
import {
  detectDaemon,
  listModels,
  pullModel,
  type OllamaPullEvent,
} from '../providers/ollama.js';
import { resolveByokModel } from '../providers/index.js';
import {
  resolveEndpoint,
  renderProgressLine,
  printNotReachable,
  type ParsedFlags,
} from './ollama-launch.js';

/** Single-model bench outcome. */
export interface BenchResult {
  model: string;
  /** ms until the first streamed text chunk arrived. */
  firstTokenMs: number;
  /** ms until the stream closed. */
  totalMs: number;
  /** Wall-clock tokens per second (completion tokens ÷ seconds). */
  tokensPerSec: number;
  promptTokens: number;
  completionTokens: number;
  /** Full output text — truncated to 200 chars in the table. */
  output: string;
  /** Only populated on failure. */
  error?: string;
}

const DEFAULT_PROMPT = 'Write a 5-line Python function that returns the n-th Fibonacci number.';

/** Default head-to-head set when the user doesn't pass --model. */
const DEFAULT_BENCH_MODELS = [
  'qwen3-coder:30b',
  'llama3.2:latest',
  'gpt-oss:20b',
];

/**
 * Count tokens as best we can. The stream result from @ai-sdk/openai
 * already surfaces usage when the provider returns it (Ollama does for
 * OpenAI-compat). When usage is missing we fall back to a whitespace
 * split — coarse, but sufficient for head-to-head comparisons on the
 * same prompt.
 */
function approximateTokens(text: string): number {
  if (!text) return 0;
  return Math.round(text.split(/\s+/).filter(Boolean).length / 0.75);
}

async function ensureModelPresent(
  modelName: string,
  baseUrl: string,
  apiKey: string | undefined,
  allowPull: boolean,
): Promise<boolean> {
  try {
    const installed = await listModels(baseUrl, { apiKey });
    if (installed.some((m) => m.name === modelName)) return true;
  } catch {
    return false;
  }
  if (!allowPull) return false;
  console.log(chalk.gray(`\n  Pulling ${modelName} (not installed)...\n`));
  const lastStatus = { label: '' };
  try {
    for await (const ev of pullModel(modelName, baseUrl, { apiKey })) {
      renderProgressLine(ev as OllamaPullEvent, lastStatus);
    }
  } catch (err: unknown) {
    process.stdout.write('\n');
    console.error(chalk.red(`  Pull failed: ${(err as Error).message}`));
    return false;
  }
  return true;
}

async function runOne(
  model: string,
  prompt: string,
  baseUrl: string,
  apiKey: string | undefined,
  isCloud: boolean,
): Promise<BenchResult> {
  const providerId = isCloud ? 'ollama-cloud' : 'ollama';
  const { model: languageModel } = resolveByokModel({
    provider: providerId,
    model,
    apiKey,
    baseUrl,
  });

  const messages: ModelMessage[] = [{ role: 'user', content: prompt }];
  const started = Date.now();
  let firstTokenAt = 0;
  let output = '';

  try {
    const stream = streamText({ model: languageModel, messages, onError() {} });
    for await (const chunk of stream.textStream) {
      if (!firstTokenAt) firstTokenAt = Date.now();
      output += chunk;
    }
    const finished = Date.now();
    const usage = await stream.usage;
    const promptTokens = usage?.inputTokens ?? approximateTokens(prompt);
    const completionTokens = usage?.outputTokens ?? approximateTokens(output);
    const totalMs = finished - started;
    const firstTokenMs = firstTokenAt ? firstTokenAt - started : totalMs;
    const seconds = Math.max(0.001, totalMs / 1000);
    return {
      model,
      firstTokenMs,
      totalMs,
      tokensPerSec: completionTokens / seconds,
      promptTokens,
      completionTokens,
      output,
    };
  } catch (err: unknown) {
    return {
      model,
      firstTokenMs: 0,
      totalMs: Date.now() - started,
      tokensPerSec: 0,
      promptTokens: 0,
      completionTokens: 0,
      output: '',
      error: (err as Error).message,
    };
  }
}

function formatRow(r: BenchResult): string {
  const name = r.model.padEnd(28);
  const ttft = `${r.firstTokenMs.toString().padStart(5)} ms`;
  const total = `${r.totalMs.toString().padStart(6)} ms`;
  const tps = `${r.tokensPerSec.toFixed(1).padStart(6)} tok/s`;
  const toks = `${r.promptTokens}→${r.completionTokens}`;
  if (r.error) {
    return `  ${chalk.red('✗')} ${chalk.white(name)} ${chalk.red(r.error.slice(0, 70))}`;
  }
  return `  ${chalk.green('✓')} ${chalk.white(name)} ${chalk.gray(ttft)}  ${chalk.gray(total)}  ${chalk.cyan(tps)}  ${chalk.gray(toks.padEnd(12))}`;
}

async function persistBench(projectRoot: string, results: BenchResult[], prompt: string): Promise<string> {
  const outDir = path.join(projectRoot, '.notch');
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'ollama-bench.json');
  const payload = {
    ts: new Date().toISOString(),
    prompt,
    results: results.map((r) => ({
      model: r.model,
      firstTokenMs: r.firstTokenMs,
      totalMs: r.totalMs,
      tokensPerSec: Number(r.tokensPerSec.toFixed(2)),
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      error: r.error,
    })),
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return file;
}

export async function runOllamaBench(
  flags: ParsedFlags,
  opts: { projectRoot: string },
): Promise<number> {
  const { baseUrl, apiKey, mode } = await resolveEndpoint(flags);
  if (!(await detectDaemon(baseUrl, { apiKey }))) {
    printNotReachable(baseUrl, mode);
    return 1;
  }

  // --model=a,b,c OR --model a --model b (parseFlags already coalesces).
  // When neither flag nor positional supplies models, fall back to defaults.
  const modelsArg = flags.model ?? '';
  const fromFlag = modelsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const models = fromFlag.length > 0 ? fromFlag : DEFAULT_BENCH_MODELS;

  const prompt = flags.positional.join(' ').trim() || DEFAULT_PROMPT;

  console.log('');
  console.log(chalk.cyan(`  Ollama bench — ${models.length} model(s) @ ${baseUrl}`));
  console.log(chalk.gray(`  Prompt: ${prompt}`));
  console.log('');

  const results: BenchResult[] = [];
  for (const model of models) {
    // Only attempt pull on local — cloud aliases can't be "pulled".
    if (mode === 'local') {
      const present = await ensureModelPresent(model, baseUrl, apiKey, flags.yes);
      if (!present) {
        results.push({
          model,
          firstTokenMs: 0,
          totalMs: 0,
          tokensPerSec: 0,
          promptTokens: 0,
          completionTokens: 0,
          output: '',
          error: 'not installed (pass -y to auto-pull)',
        });
        continue;
      }
    }
    process.stdout.write(chalk.gray(`  running ${model}... `));
    const result = await runOne(model, prompt, baseUrl, apiKey, mode === 'cloud');
    results.push(result);
    process.stdout.write('\r\x1b[K');
  }

  // Rank by tokens/sec descending; failures sort to the bottom.
  const ranked = [...results].sort((a, b) => {
    if (a.error && !b.error) return 1;
    if (!a.error && b.error) return -1;
    return b.tokensPerSec - a.tokensPerSec;
  });

  const header = `  ${'  ' /* pad for ✓/✗ */}${'model'.padEnd(28)} ${'ttft'.padStart(8)}  ${'total'.padStart(9)}  ${'throughput'.padStart(12)}  ${'tokens (p→c)'}`;
  console.log(chalk.gray(header));
  console.log(chalk.gray(`  ${'-'.repeat(header.length - 2)}`));
  for (const r of ranked) console.log(formatRow(r));

  try {
    const saved = await persistBench(opts.projectRoot, ranked, prompt);
    console.log('');
    console.log(chalk.gray(`  Saved: ${saved}`));
    console.log('');
  } catch (err: unknown) {
    console.warn(chalk.yellow(`  ! Could not persist bench: ${(err as Error).message}`));
  }

  const anyFailed = ranked.some((r) => r.error);
  return anyFailed ? 1 : 0;
}
