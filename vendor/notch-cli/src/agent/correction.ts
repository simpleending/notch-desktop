/**
 * Notch CLI — Correction Pipeline
 *
 * Three-layer system that makes weaker models (Ollama, LM Studio, sub-7B)
 * reliably produce tool calls:
 *
 *   Layer 1: Intent Gate — cheap classification pass (~50 tokens) that asks
 *            "does this need a tool call?" before the main generation.
 *
 *   Layer 2: Correction Pass — when the model's output looks like a failed
 *            tool call, feeds it back with a tight rewrite prompt.
 *
 *   Layer 3: Template Format — fill-in-the-blank approach for models that
 *            truly can't produce structured JSON.
 *
 * Ported from Ashe's Rust implementation (nimbus/native/ashe/src/correction.rs)
 * for use in both the CLI and cloud agent runtimes.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { LanguageModel, ModelMessage } from 'ai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorrectionConfig {
  /** Run the intent gate before main generation. */
  intentGate: boolean;
  /** Max correction attempts when the model fumbles a tool call. */
  maxCorrectionAttempts: number;
  /** Use the template (fill-in-the-blank) format for tool descriptions. */
  useTemplateFormat: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description?: string; required?: boolean }>;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type IntentResult = 'yes' | 'no' | 'unclear';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const CORRECTION_PRESETS = {
  /** No correction — for capable models (Claude, GPT-4, etc.) */
  disabled: (): CorrectionConfig => ({
    intentGate: false,
    maxCorrectionAttempts: 0,
    useTemplateFormat: false,
  }),

  /** Light correction — for mid-tier models (Qwen 14B+, Llama 70B) */
  capable: (): CorrectionConfig => ({
    intentGate: false,
    maxCorrectionAttempts: 1,
    useTemplateFormat: false,
  }),

  /** Full correction — for small models (7B-14B) */
  smallModel: (): CorrectionConfig => ({
    intentGate: true,
    maxCorrectionAttempts: 2,
    useTemplateFormat: false,
  }),

  /** Maximum scaffolding — for tiny models (sub-7B) */
  tinyModel: (): CorrectionConfig => ({
    intentGate: true,
    maxCorrectionAttempts: 3,
    useTemplateFormat: true,
  }),
} as const;

// ---------------------------------------------------------------------------
// Intent Gate
// ---------------------------------------------------------------------------

const INTENT_GATE_PROMPT = `You are a classifier. Given the user's message and the list of available tools, decide: does this message require calling a tool to answer properly?

Reply with EXACTLY one word: YES or NO

Available tools: {tool_names}

User message: {user_message}`;

/**
 * Cheap classification pass (~50 tokens) that asks the model whether the
 * user's message requires a tool call. Returns 'yes', 'no', or 'unclear'.
 *
 * When the gate says YES but the main generation produces no tool calls,
 * we know it's a format failure (not a reasoning failure) and can route
 * to the correction pipeline with higher confidence.
 */
export async function intentGate(
  model: LanguageModel,
  userMessage: string,
  toolNames: string[],
): Promise<IntentResult> {
  const { generateText } = await import('ai');

  const prompt = INTENT_GATE_PROMPT
    .replace('{tool_names}', toolNames.join(', '))
    .replace('{user_message}', userMessage.slice(0, 500));

  try {
    const result = await generateText({
      model,
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 10,
      temperature: 0,
    });

    const answer = result.text.trim().toUpperCase();
    if (answer.startsWith('YES')) return 'yes';
    if (answer.startsWith('NO')) return 'no';
    return 'unclear';
  } catch {
    return 'unclear';
  }
}

// ---------------------------------------------------------------------------
// Failed Tool Call Detection
// ---------------------------------------------------------------------------

/**
 * Heuristic that detects when a model tried to call a tool but failed to
 * produce valid structured output. Requires 2+ weak signals or 1 strong
 * signal to reduce false positives.
 *
 * Signals:
 *   - Contains a known tool name
 *   - Contains JSON-like fragments ({ "name":, "arguments":, etc.)
 *   - Contains natural-language intent descriptions ("I'll use", "Let me call")
 *   - Contains partial XML tags (<tool_call, <function_call, etc.)
 *   - Contains markdown code blocks with JSON
 */
export function looksLikeFailedToolCall(
  text: string,
  toolNames: string[],
): boolean {
  if (!text || text.length < 10) return false;

  let weakSignals = 0;
  let strongSignals = 0;

  // Signal: contains a known tool name
  const lowerText = text.toLowerCase();
  for (const name of toolNames) {
    if (lowerText.includes(name.toLowerCase())) {
      weakSignals++;
      break;
    }
  }

  // Signal: JSON-like fragments
  const jsonPatterns = [
    /\{\s*"name"\s*:/,
    /\{\s*"tool"\s*:/,
    /\{\s*"function"\s*:/,
    /"arguments"\s*:\s*\{/,
    /"parameters"\s*:\s*\{/,
  ];
  for (const pat of jsonPatterns) {
    if (pat.test(text)) {
      strongSignals++;
      break;
    }
  }

  // Signal: natural-language intent
  const intentPatterns = [
    /\b(?:i'll|let me|i need to|i should|i want to|i will)\s+(?:use|call|invoke|run|execute)\b/i,
    /\b(?:calling|using|invoking|running)\s+(?:the\s+)?(?:tool|function)\b/i,
  ];
  for (const pat of intentPatterns) {
    if (pat.test(text)) {
      weakSignals++;
      break;
    }
  }

  // Signal: partial XML tags
  const xmlPatterns = [
    /<tool_call/i,
    /<function_call/i,
    /<function=[\w.-]+>/i,
    /<tool_use/i,
    /<\|tool▁call\|>/,
    /<\|plugin\|>/,
  ];
  for (const pat of xmlPatterns) {
    if (pat.test(text)) {
      strongSignals++;
      break;
    }
  }

  // Signal: markdown code block with JSON-ish content
  if (/```(?:json|tool)?\s*\n?\s*\{/.test(text)) {
    weakSignals++;
  }

  return strongSignals >= 1 || weakSignals >= 2;
}

// ---------------------------------------------------------------------------
// Correction Pass
// ---------------------------------------------------------------------------

const CORRECTION_PROMPTS = [
  // Attempt 1: XML format (most models have seen this in training)
  `Your previous response tried to call a tool but the format was wrong.

Your output was:
---
{raw_output}
---

To call a tool, you MUST use this exact format:
<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

Available tools: {tool_names}

Rewrite your response with the correct tool call format. Output ONLY the tool call, nothing else.`,

  // Attempt 2: bare JSON (simpler)
  `Your output was not a valid tool call. Rewrite it as a single JSON object:

{"name": "TOOL_NAME", "arguments": {"key": "value"}}

Available tools: {tool_names}
Your failed output: {raw_output_short}

Reply with ONLY the JSON object.`,

  // Attempt 3: ask directly (simplest possible)
  `Which tool do you want to call? Reply with the tool name and arguments as JSON.
Tools: {tool_names}
JSON:`,
];

/**
 * When the model's output looks like a failed tool call, feeds it back
 * with progressively simpler correction prompts. Each attempt costs
 * ~100-200 tokens.
 *
 * Returns parsed tool calls if correction succeeds, or null if all
 * attempts fail.
 */
export async function correctionPass(
  model: LanguageModel,
  rawOutput: string,
  toolNames: string[],
  conversationMessages: ModelMessage[],
  maxAttempts: number,
): Promise<ParsedToolCall[] | null> {
  const { generateText } = await import('ai');

  for (let i = 0; i < Math.min(maxAttempts, CORRECTION_PROMPTS.length); i++) {
    const promptTemplate = CORRECTION_PROMPTS[i];
    if (!promptTemplate) continue;
    const prompt = promptTemplate
      .replace('{raw_output}', rawOutput.slice(0, 1500))
      .replace('{raw_output_short}', rawOutput.slice(0, 500))
      .replace('{tool_names}', toolNames.join(', '));

    try {
      const result = await generateText({
        model,
        messages: [
          ...conversationMessages.slice(-4), // keep recent context
          { role: 'user', content: prompt },
        ],
        maxOutputTokens: 500,
        temperature: 0,
      });

      const parsed = extractToolCallsFromText(result.text, toolNames);
      if (parsed.length > 0) return parsed;
    } catch {
      // Continue to next attempt
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Template Format
// ---------------------------------------------------------------------------

/**
 * Generates fill-in-the-blank instructions for models that can't produce
 * structured JSON. The model fills in a simple template instead.
 *
 * Example output:
 *   TOOL: Read
 *   ARG_file_path: src/main.ts
 *   ARG_offset: 1
 */
export function templateFormatInstructions(tools: ToolSchema[]): string {
  if (tools.length === 0) return '';

  const lines = [
    'To call a tool, use this exact format (one tool per block):',
    '',
  ];

  for (const tool of tools) {
    lines.push(`TOOL: ${tool.name}`);
    for (const [paramName, param] of Object.entries(tool.parameters)) {
      const req = param.required ? ' (required)' : ' (optional)';
      lines.push(`ARG_${paramName}: <${param.type}>${req}`);
    }
    lines.push('');
  }

  lines.push('To respond without calling a tool, just write your response normally.');
  lines.push('Do NOT mix tool calls with regular text in the same message.');

  return lines.join('\n');
}

/**
 * Parses the template format output into tool calls.
 *
 * Handles:
 *   TOOL: Read
 *   ARG_file_path: src/main.ts
 *   ARG_offset: 1
 */
export function extractTemplateToolCalls(
  text: string,
  toolNames: string[],
): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const toolNameSet = new Set(toolNames.map(n => n.toLowerCase()));

  // Qwen3-Coder can emit its native function/parameter notation as plain
  // text when a provider misses the opening tool marker. Recover complete
  // calls only, never fenced documentation examples or unknown functions.
  if (!text.includes('```') && /<\/tool_call>\s*$/i.test(text)) {
    const names = new Map(toolNames.map(name => [name.toLowerCase(), name]));
    const qwenCalls: ParsedToolCall[] = [];
    const functions = /<function=([\w.-]+)>\s*([\s\S]*?)<\/function>/gi;
    let functionMatch;
    while ((functionMatch = functions.exec(text)) !== null) {
      const name = names.get(functionMatch[1]!.toLowerCase());
      if (!name) continue;
      const args: Record<string, unknown> = {};
      const parameters = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/gi;
      let parameterMatch;
      while ((parameterMatch = parameters.exec(functionMatch[2]!)) !== null) {
        const key = parameterMatch[1]!;
        if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
        const raw = parameterMatch[2]!.trim().replace(/&(lt|gt|amp|quot|apos);/g, (_match, entity: string) =>
          ({ lt:'<', gt:'>', amp:'&', quot:'"', apos:"'" }[entity] ?? _match));
        try { args[key] = JSON.parse(raw); } catch { args[key] = coerceValue(raw); }
      }
      if (Object.keys(args).length) qwenCalls.push({ id:`correction-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,name,args });
    }
    if (qwenCalls.length) return qwenCalls;
  }

  const lines = text.split('\n');
  let currentTool: string | null = null;
  let currentArgs: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    // Match TOOL: <name>
    const toolMatch = trimmed.match(/^TOOL:\s*(.+)$/i);
    if (toolMatch && toolMatch[1]) {
      // Flush previous tool if any
      if (currentTool && toolNameSet.has(currentTool.toLowerCase())) {
        calls.push({
          id: `correction-${Date.now()}-${calls.length}`,
          name: currentTool,
          args: currentArgs,
        });
      }
      currentTool = toolMatch[1].trim();
      currentArgs = {};
      continue;
    }

    // Match ARG_<key>: <value>
    const argMatch = trimmed.match(/^ARG_(\w+):\s*(.+)$/i);
    if (argMatch && currentTool && argMatch[1] && argMatch[2]) {
      const key = argMatch[1];
      const rawValue = argMatch[2].trim();
      currentArgs[key] = coerceValue(rawValue);
    }
  }

  // Flush last tool
  if (currentTool && toolNameSet.has(currentTool.toLowerCase())) {
    calls.push({
      id: `correction-${Date.now()}-${calls.length}`,
      name: currentTool,
      args: currentArgs,
    });
  }

  return calls;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce a string value to the appropriate JS type. */
function coerceValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;

  // Try number
  const num = Number(raw);
  if (!Number.isNaN(num) && raw !== '') return num;

  // Try JSON (for objects/arrays)
  if ((raw.startsWith('{') && raw.endsWith('}')) ||
      (raw.startsWith('[') && raw.endsWith(']'))) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }

  return raw;
}

/**
 * Extract tool calls from free-form text. Tries multiple strategies:
 *   1. JSON objects with "name" and "arguments" fields
 *   2. <tool_call> XML tags containing JSON
 *   3. Markdown code blocks containing JSON
 *   4. Template format (TOOL: / ARG_:)
 */
export function extractToolCallsFromText(
  text: string,
  toolNames: string[],
): ParsedToolCall[] {
  const toolNameSet = new Set(toolNames.map(n => n.toLowerCase()));

  // Strategy 1: <tool_call> XML tags
  const xmlRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let match;
  const xmlCalls: ParsedToolCall[] = [];
  while ((match = xmlRegex.exec(text)) !== null) {
    const captured = match[1];
    if (captured) {
      const parsed = tryParseToolJson(captured, toolNameSet);
      if (parsed) xmlCalls.push(parsed);
    }
  }
  if (xmlCalls.length > 0) return xmlCalls;

  // Strategy 2: markdown code blocks
  const codeBlockRegex = /```(?:json|tool)?\s*\n?([\s\S]*?)\n?\s*```/g;
  const codeCalls: ParsedToolCall[] = [];
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const captured = match[1];
    if (captured) {
      const parsed = tryParseToolJson(captured, toolNameSet);
      if (parsed) codeCalls.push(parsed);
    }
  }
  if (codeCalls.length > 0) return codeCalls;

  // Strategy 3: bare JSON objects
  const jsonRegex = /\{[^{}]*"name"\s*:\s*"[^"]+"\s*[,}][\s\S]*?\}/g;
  const jsonCalls: ParsedToolCall[] = [];
  while ((match = jsonRegex.exec(text)) !== null) {
    const parsed = tryParseToolJson(match[0], toolNameSet);
    if (parsed) jsonCalls.push(parsed);
  }
  if (jsonCalls.length > 0) return jsonCalls;

  // Strategy 4: template format
  const templateCalls = extractTemplateToolCalls(text, toolNames);
  if (templateCalls.length > 0) return templateCalls;

  return [];
}

/** Try to parse a JSON string as a tool call. */
function tryParseToolJson(
  jsonStr: string,
  toolNameSet: Set<string>,
): ParsedToolCall | null {
  try {
    const obj = JSON.parse(jsonStr.trim());
    const name = obj.name ?? obj.tool ?? obj.function;
    if (!name || typeof name !== 'string') return null;
    if (!toolNameSet.has(name.toLowerCase())) return null;

    const args = obj.arguments ?? obj.parameters ?? obj.args ?? {};
    return {
      id: `correction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      args: typeof args === 'object' ? args : {},
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auto-detect correction preset from model ID
// ---------------------------------------------------------------------------

const CAPABLE_PATTERNS = [
  /claude/i, /gpt-4/i, /gpt-3\.5/i, /o[1-4]/i,
  /gemini-(?:pro|ultra|2)/i, /deepseek-(?:v3|r1)/i,
];

const SMALL_PATTERNS = [
  /qwen.*(?:7b|14b|32b)/i, /llama.*(?:8b|13b|70b)/i,
  /mistral.*(?:7b|8x7b)/i, /gemma.*(?:7b|9b|27b)/i,
  /codestral/i, /deepseek-coder/i,
];

const TINY_PATTERNS = [
  /qwen.*(?:0\.5b|1\.5b|3b|4b)/i, /llama.*(?:1b|3b)/i,
  /gemma.*(?:2b|4b)/i, /phi.*(?:1|2|3)/i,
  /tinyllama/i, /stablelm/i,
];

/**
 * Auto-detect the appropriate correction preset based on model ID.
 * Falls back to `capable` (light correction) for unknown models.
 */
export function autoDetectPreset(modelId: string): CorrectionConfig {
  if (!modelId) return CORRECTION_PRESETS.capable();

  for (const pat of CAPABLE_PATTERNS) {
    if (pat.test(modelId)) return CORRECTION_PRESETS.disabled();
  }
  for (const pat of TINY_PATTERNS) {
    if (pat.test(modelId)) return CORRECTION_PRESETS.tinyModel();
  }
  for (const pat of SMALL_PATTERNS) {
    if (pat.test(modelId)) return CORRECTION_PRESETS.smallModel();
  }

  // Unknown model — light correction as safe default
  return CORRECTION_PRESETS.capable();
}
