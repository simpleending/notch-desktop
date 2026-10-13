/**
 * Notch CLI — Structured Output Schema
 *
 * When `--output-schema <file>` is passed in headless mode, the CLI appends a
 * schema instruction to the system prompt and tries to extract a JSON object
 * matching that schema from the model's final message. Emits a
 * `structured-output` event in JSON mode and writes the value to
 * `--output-last-message` if given.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

export interface OutputSchemaConfig {
  schema: unknown;
  raw: string;
  validate: ValidateFunction;
}

export async function loadOutputSchema(filePath: string): Promise<OutputSchemaConfig> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const schema = JSON.parse(raw);
  if (typeof schema !== 'boolean' && (schema === null || Array.isArray(schema) || typeof schema !== 'object')) {
    throw new Error('Output schema must be a JSON Schema object or boolean.');
  }
  const dialect = typeof schema === 'object' ? schema.$schema : undefined;
  const Validator = dialect?.includes('2020-12') ? Ajv2020 : dialect?.includes('2019-09') ? Ajv2019 : Ajv;
  const ajv = new Validator({ allErrors: true });
  const validate = ajv.compile(schema);
  if ('$async' in validate && validate.$async) throw new Error('Async output schemas are not supported.');
  return { schema, raw, validate };
}

export function schemaInstructions(schema: OutputSchemaConfig): string {
  return (
    `\n\n## Required Final Output\n` +
    `Your final assistant message MUST end with a fenced JSON block matching this JSON Schema:\n` +
    '```json\n' + schema.raw.trim() + '\n```\n' +
    `Emit the JSON inside a \`\`\`json … \`\`\` fence. Do not include commentary inside the fence. ` +
    `All required fields must be present. Produce the JSON block on the final turn only.`
  );
}

/**
 * Extract the last ```json``` fenced block from a string and parse it.
 * Returns null if not found or if parsing fails.
 */
export function extractStructuredOutput(text: string): unknown | null {
  const regex = /```json\s*\n([\s\S]*?)\n```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = regex.exec(text)) !== null) {
    last = match[1] ?? null;
  }
  if (!last) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

/** Validate parsed output before emitting success. Never coerce or remove data. */
export function validateStructuredOutput(text: string, config: OutputSchemaConfig):
  { ok: true; value: unknown } | { ok: false; error: string } {
  const blocks = [...text.matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n```/gi)];
  const json = blocks.at(-1)?.[1] ?? text.trim();
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { return { ok: false, error: 'Model did not emit valid JSON for --output-schema.' }; }
  if (!config.validate(value)) {
    const details = (config.validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
    return { ok: false, error: `Output does not match --output-schema: ${details}` };
  }
  return { ok: true, value };
}
