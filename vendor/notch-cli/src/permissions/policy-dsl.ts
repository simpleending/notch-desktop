/**
 * Notch CLI — Permission Policy DSL
 *
 * JSON-based permission DSL inspired by OpenAI Codex's execpolicy (codex-rs/execpolicy)
 * `prefix_rule` system but expressed entirely in JSON — no Starlark, no
 * embedded JS. Rules declare the tool they apply to, a decision, a
 * human-readable justification, and `match` / `not_match` clause arrays
 * that are AND/NONE composed over a small set of typed matchers.
 *
 * The evaluation engine (policy-engine.ts) is a pure function. The clause
 * matchers (clause-matchers.ts) never throw — any error during matching
 * resolves to "clause not matched" so a malformed rule can never lock a
 * user out of their tools.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

/**
 * A single permission rule. Rules are evaluated in bulk by the engine;
 * the strictest decision among all matched rules wins (`deny > prompt >
 * allow`), with `priority` breaking ties of equal severity.
 */
export interface PolicyRule {
  /** Identifier for this rule (used in justification + log output). */
  id: string;
  /** What tool this rule applies to. `'*'` matches all tools. */
  tool: string | string[];
  /** Decision when the rule matches. */
  decision: 'allow' | 'prompt' | 'deny';
  /** Human-readable explanation, surfaced in prompts/denials. */
  justification: string;
  /** ALL of these match clauses must be true for the rule to apply. */
  match?: MatchClause[];
  /** ANY of these clauses, when true, EXCLUDES this rule from matching. */
  not_match?: MatchClause[];
  /** Optional priority — higher wins on ties. Default 0. */
  priority?: number;
}

/**
 * A single predicate evaluated against a tool call's `args`. Each variant
 * pulls a named field from `args` (by string key) and checks it against
 * a literal. The matcher returns `false` for any missing/malformed input
 * rather than throwing.
 */
export type MatchClause =
  | { kind: 'arg_equals'; arg: string; value: string | number | boolean }
  | { kind: 'arg_contains'; arg: string; value: string }
  | { kind: 'arg_prefix'; arg: string; value: string }
  | { kind: 'arg_regex'; arg: string; pattern: string; flags?: string }
  | { kind: 'command_prefix'; arg: string; value: string }
  | { kind: 'command_word'; arg: string; value: string }
  | { kind: 'path_under'; arg: string; root: string }
  | { kind: 'path_basename'; arg: string; value: string }
  | { kind: 'host_executable'; arg: string; name: string; allowed_paths?: string[] };

/**
 * Discriminant type literal for a MatchClause variant.
 */
export type MatchClauseKind = MatchClause['kind'];

/**
 * A full policy document — a set of rules plus a fallback decision for
 * the case where no rule matches the incoming tool call.
 */
export interface PolicyConfig {
  /** Schema version. Always `1` today. */
  schema_version: 1;
  /** Ordered list of rules. Order does not affect semantics (priority does). */
  rules: PolicyRule[];
  /** Default decision when no rule matches. Defaults to `'prompt'`. */
  default_decision?: 'allow' | 'prompt' | 'deny';
}

/**
 * Per-rule evaluation trace returned by the engine. Useful for `/policy
 * test` + debugging.
 */
export interface RuleEvaluation {
  rule_id: string;
  /** True if every `match` clause was satisfied. */
  match_passed: boolean;
  /** True if no `not_match` clause was triggered. */
  not_match_passed: boolean;
  /** True iff both of the above are true. */
  matched: boolean;
  /** If matched, the rule's decision + justification (copied through). */
  decision?: 'allow' | 'prompt' | 'deny';
  justification?: string;
  /** First failing clause index within `match` (for diagnostics). */
  first_match_fail?: number;
  /** First triggered clause index within `not_match` (for diagnostics). */
  first_not_match_hit?: number;
}

/**
 * Top-level engine output.
 */
export interface PolicyDecision {
  decision: 'allow' | 'prompt' | 'deny';
  /** The rule that drove the final decision. Undefined for default-only. */
  matched_rule_id?: string;
  /** Justification from the winning rule (if any). */
  justification?: string;
  /** Trace for every rule that applied to this tool. */
  all_evaluations: RuleEvaluation[];
}

/**
 * Severity ordering used by the engine. Higher = stricter.
 */
export const DECISION_SEVERITY: Record<'allow' | 'prompt' | 'deny', number> = {
  allow: 0,
  prompt: 1,
  deny: 2,
};

/**
 * Quick typeguard used by loaders / validators.
 */
export function isPolicyConfig(value: unknown): value is PolicyConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.schema_version !== 1) return false;
  if (!Array.isArray(v.rules)) return false;
  return true;
}
