import { Command } from 'commander';
import { THEME_IDS } from './ui/themes.js';

/** Shared options: the lightweight launcher and full runtime must parse identically. */
export function createCliProgram(version: string): Command {
return new Command()
  .name('notch')
  .description('Notch CLI — AI-powered coding assistant by Driftrail')
  .addHelpText('after', '\nQuick start:\n  notch models     Download and run a Hugging Face model sized to your memory\n  notch setup      Choose Ollama, OpenRouter, OpenAI, or Anthropic\n  notch doctor     Check configuration and connectivity\n  notch ollama list\n  notch --list-coding-models\n')
  .version(version)
  .argument('[prompt...]', 'One-shot prompt (runs once and exits)')
  .option('-m, --model <model>', 'Model id, preferably provider/model (for example openrouter/anthropic/claude-sonnet-4.6)')
  .option('--base-url <url>', 'Override the provider base URL (for custom OpenAI-compatible endpoints)')
  .option('--api-key <key>', 'API key for the active provider (prefer provider env vars such as OPENROUTER_API_KEY)')
  .option('--provider <id>', 'Provider id (openai, anthropic, openrouter, google, deepseek, together, fireworks, groq, ollama, lmstudio, vllm, custom).')
  .option('--list-providers', 'List built-in providers and their API-key env vars, then exit')
  .option('--list-coding-models', 'List current OpenRouter programming models, then exit')
  .option('--no-repo-map', 'Disable automatic repository mapping')
  .option('--no-markdown', 'Disable markdown rendering in output')
  .option('--max-iterations <n>', 'Max tool-call rounds per turn (default: 25)')
  .option('-y, --yes', 'Auto-confirm destructive actions')
  .option('--trust', 'Trust mode — auto-allow all tool calls')
  .option('--access <mode>', 'Access profile: approve (default), read-only, full-access')
  .option('--dry-run', 'Preview tools that may change state; built-in reads still execute')
  .option('--theme <theme>', `UI color theme (${THEME_IDS.join(', ')})`)
  .option('--resume', 'Resume the last session for this project')
  .option('--session <id>', 'Resume a specific session by ID')
  .option('--cwd <dir>', 'Set working directory')
  .option('--json', 'Emit JSONL event stream on stdout (headless/CI mode)')
  .option('--output-schema <file>', 'Path to JSON Schema constraining the final structured output')
  .option('--output-last-message <file>', 'Write the final assistant message to this file on exit')
  .option('--guardian', 'Enable Guardian risk scoring when a provider-backed guardian model is configured')
  .option('--coordinator', 'Coordinator mode: top-level agent can only spawn/continue/stop workers (plus read/grep/glob). All real work is delegated.')
  .option('--no-auto-dream', 'Disable the background memory-consolidation daemon (default: enabled in REPL)')
  .option('--no-update', 'Disable the background update check on launch (equivalent to NOTCH_AUTO_UPDATE=0)')
  .option('--update-channel <name>', 'npm dist-tag to follow for updates (latest | next | beta)')
  .option(
    '--image <path>',
    'Attach an image (file path, URL, or data URL). Repeatable.',
    (val: string, prev: string[]) => (prev ? [...prev, val] : [val]),
    [] as string[],
  )
  ;
}
