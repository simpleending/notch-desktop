/**
 * Notch CLI — Guardian Risk Assessor
 *
 * A second, independent model call that scores a proposed tool action against
 * the Notch Guardian risk taxonomy (see `guardian-policy.md`). Runs in parallel
 * with the normal permission flow and NEVER blocks on failure — timeouts,
 * parse errors, and upstream outages all degrade to the standard prompt UX.
 *
 * The guardian model is intentionally the smallest/fastest tier (Solace Lite).
 * It is wired independently of the main chat model so the primary agent's
 * judgement cannot coerce the safety verdict.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { GUARDIAN_POLICY_EMBEDDED } from './guardian-policy.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuardianSeverity = 'low' | 'medium' | 'high' | 'critical';
export type GuardianAction = 'auto-allow' | 'prompt' | 'deny';

export interface GuardianInput {
  /** Tool name being proposed (e.g. "shell", "write", "edit"). */
  tool: string;
  /** Arguments passed to the tool. */
  args: Record<string, unknown>;
  /** Optional free-form context (user message, active task, etc.). */
  context?: string;
}

export interface RiskAssessment {
  category: string;
  severity: GuardianSeverity;
  justification: string;
  recommended_action: GuardianAction;
  specific_concerns: string[];
}

// ---------------------------------------------------------------------------
// Zod schema for the model's structured output
// ---------------------------------------------------------------------------

const AssessmentSchema = z.object({
  category: z.string().min(1).max(120),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  justification: z.string().min(1).max(600),
  recommended_action: z.enum(['auto-allow', 'prompt', 'deny']),
  specific_concerns: z.array(z.string().max(240)).max(12).default([]),
});

// ---------------------------------------------------------------------------
// Policy loading (file first, embedded fallback)
// ---------------------------------------------------------------------------

let cachedPolicy: string | null = null;

async function loadPolicy(): Promise<string> {
  if (cachedPolicy) return cachedPolicy;
  // Prefer the on-disk .md so humans can edit it without a rebuild. Fall back
  // to the embedded TS copy when the file can't be located (bundled dist/).
  try {
    const here = fileURLToPath(import.meta.url);
    const mdPath = path.join(path.dirname(here), 'guardian-policy.md');
    const raw = await fs.readFile(mdPath, 'utf-8');
    if (raw.length > 200) {
      cachedPolicy = raw;
      return raw;
    }
  } catch {
    // File not found or not readable — use embedded.
  }
  cachedPolicy = GUARDIAN_POLICY_EMBEDDED;
  return cachedPolicy;
}

// ---------------------------------------------------------------------------
// Session cache — same (tool, args) => same verdict, no repeat model calls
// ---------------------------------------------------------------------------

const sessionCache = new Map<string, RiskAssessment>();

function cacheKey(input: GuardianInput): string {
  return JSON.stringify({ tool: input.tool, args: input.args });
}

/** Clear the cache — useful between sessions or in tests. */
export function resetGuardianCache(): void {
  sessionCache.clear();
}

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 5000;

function timeoutFallback(reason: string): RiskAssessment {
  return {
    category: 'Low-Risk Actions',
    severity: 'medium',
    justification: reason,
    recommended_action: 'prompt',
    specific_concerns: [],
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const OUTPUT_INSTRUCTION = `
## Your Response

Return ONLY a single JSON object — no markdown fences, no prose before or after.
The object MUST match this TypeScript type exactly:

type Assessment = {
  category: "Data Exfiltration" | "Credential Probing" | "Persistent Security Weakening" | "Destructive Actions" | "Low-Risk Actions";
  severity: "low" | "medium" | "high" | "critical";
  justification: string;   // one sentence, <= 240 chars, cite the specific rule you applied
  recommended_action: "auto-allow" | "prompt" | "deny";
  specific_concerns: string[];  // 0–6 short bullets, each <= 240 chars
};

Severity → recommended_action mapping (you MUST obey this):
- "low"       → "auto-allow"
- "medium"    → "prompt"
- "high"      → "prompt"
- "critical"  → "deny"

If you are uncertain, return "medium" + "prompt". Do NOT invent new severity or
action values. Do NOT wrap the JSON in markdown. Output the raw object only.
`;

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Strip ```json fences if the model couldn't resist them.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced?.[1] ?? trimmed;
  // Grab the first {...} block in case the model added stray prose.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return JSON.parse(body);
  }
  return JSON.parse(body.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score a proposed tool call. Returns a RiskAssessment; NEVER throws.
 * On timeout, parse error, or model failure returns a `medium`/`prompt`
 * fallback so the caller falls back to the normal confirmation UX.
 */
export async function assessRisk(
  input: GuardianInput,
  model: LanguageModel,
): Promise<RiskAssessment> {
  // Session cache — guardian should not re-score an identical (tool, args).
  const key = cacheKey(input);
  const cached = sessionCache.get(key);
  if (cached) return cached;

  let policy: string;
  try {
    policy = await loadPolicy();
  } catch {
    policy = GUARDIAN_POLICY_EMBEDDED;
  }

  const system = `${policy}\n${OUTPUT_INSTRUCTION}`;
  const userPayload = {
    tool: input.tool,
    args: input.args,
    context: input.context ?? null,
  };
  const user = `Score this proposed tool call:\n\n\`\`\`json\n${JSON.stringify(
    userPayload,
    null,
    2,
  )}\n\`\`\``;

  // Race the model against a hard 5s timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let rawText: string;
  try {
    const result = await generateText({
      model,
      system,
      prompt: user,
      maxOutputTokens: 512,
      temperature: 0,
      abortSignal: controller.signal,
    });
    rawText = result.text ?? '';
  } catch (err: any) {
    clearTimeout(timer);
    const reason =
      err?.name === 'AbortError' || controller.signal.aborted
        ? 'Guardian timeout — defaulting to prompt.'
        : `Guardian unavailable (${err?.message ?? 'unknown error'}) — defaulting to prompt.`;
    const fallback = timeoutFallback(reason);
    // Don't cache failures — next call may succeed.
    return fallback;
  } finally {
    clearTimeout(timer);
  }

  // Parse + validate.
  let parsed: unknown;
  try {
    parsed = extractJson(rawText);
  } catch {
    return timeoutFallback(
      'Guardian returned non-JSON — defaulting to prompt.',
    );
  }

  const validated = AssessmentSchema.safeParse(parsed);
  if (!validated.success) {
    return timeoutFallback(
      'Guardian returned a malformed verdict — defaulting to prompt.',
    );
  }

  // Enforce the severity -> action mapping even if the model disagreed.
  const assessment = normalizeAction(validated.data);
  sessionCache.set(key, assessment);
  return assessment;
}

function normalizeAction(a: RiskAssessment): RiskAssessment {
  let recommended: GuardianAction = a.recommended_action;
  switch (a.severity) {
    case 'low':
      recommended = 'auto-allow';
      break;
    case 'critical':
      recommended = 'deny';
      break;
    case 'medium':
    case 'high':
      if (recommended !== 'prompt') recommended = 'prompt';
      break;
  }
  return { ...a, recommended_action: recommended };
}
