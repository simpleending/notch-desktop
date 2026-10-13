/**
 * Notch CLI — Policy Engine
 *
 * Pure evaluator for the JSON policy DSL (policy-dsl.ts). Walks every
 * rule in the policy, applies tool-name gating + AND/NONE clause logic,
 * then reduces the set of matched rules down to a single decision using
 * severity-first, priority-second ordering:
 *
 *   deny > prompt > allow, then priority desc
 *
 * No I/O. All filesystem + loader concerns live in `index.ts`.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { evaluateClause } from './clause-matchers.js';
import {
  DECISION_SEVERITY,
  type MatchClause,
  type PolicyConfig,
  type PolicyDecision,
  type PolicyRule,
  type RuleEvaluation,
} from './policy-dsl.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolApplies(rule: PolicyRule, toolName: string): boolean {
  if (Array.isArray(rule.tool)) {
    return rule.tool.includes('*') || rule.tool.includes(toolName);
  }
  return rule.tool === '*' || rule.tool === toolName;
}

/**
 * Evaluate one rule's clauses. Returns an annotated RuleEvaluation.
 */
function evaluateRule(
  rule: PolicyRule,
  args: Record<string, unknown>,
): RuleEvaluation {
  const matchClauses = rule.match ?? [];
  const notMatchClauses = rule.not_match ?? [];

  let firstMatchFail: number | undefined;
  let matchPassed = true;
  for (let i = 0; i < matchClauses.length; i++) {
    const clause = matchClauses[i] as MatchClause;
    if (!evaluateClause(args, clause)) {
      matchPassed = false;
      firstMatchFail = i;
      break;
    }
  }

  let firstNotMatchHit: number | undefined;
  let notMatchPassed = true;
  for (let i = 0; i < notMatchClauses.length; i++) {
    const clause = notMatchClauses[i] as MatchClause;
    if (evaluateClause(args, clause)) {
      notMatchPassed = false;
      firstNotMatchHit = i;
      break;
    }
  }

  const matched = matchPassed && notMatchPassed;
  const out: RuleEvaluation = {
    rule_id: rule.id,
    match_passed: matchPassed,
    not_match_passed: notMatchPassed,
    matched,
  };
  if (firstMatchFail !== undefined) out.first_match_fail = firstMatchFail;
  if (firstNotMatchHit !== undefined) out.first_not_match_hit = firstNotMatchHit;
  if (matched) {
    out.decision = rule.decision;
    out.justification = rule.justification;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a policy against a tool invocation.
 *
 * Semantics:
 *   1. Filter rules to those whose `tool` matches (or is `'*'`).
 *   2. For each, run its `match` (AND) and `not_match` (NONE) clauses.
 *   3. Keep rules whose clauses all pass.
 *   4. Pick the winner by severity (`deny > prompt > allow`), then
 *      `priority` desc; declaration order used only as last tie-breaker.
 *   5. If no rule matched, return the policy's `default_decision`
 *      (defaults to `'prompt'`).
 *
 * Pure function. Every rule's trace is returned in `all_evaluations` for
 * debugging via `/policy test`.
 */
export function evaluatePolicy(
  policy: PolicyConfig,
  toolName: string,
  args: Record<string, unknown>,
): PolicyDecision {
  const evaluations: RuleEvaluation[] = [];
  let best: { rule: PolicyRule; eval: RuleEvaluation; order: number } | undefined;

  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i] as PolicyRule;
    if (!toolApplies(rule, toolName)) continue;

    const ev = evaluateRule(rule, args);
    evaluations.push(ev);
    if (!ev.matched) continue;

    if (!best) {
      best = { rule, eval: ev, order: i };
      continue;
    }

    const curSev = DECISION_SEVERITY[best.rule.decision];
    const newSev = DECISION_SEVERITY[rule.decision];
    if (newSev > curSev) {
      best = { rule, eval: ev, order: i };
      continue;
    }
    if (newSev < curSev) continue;

    // Same severity — priority tiebreaker (higher wins).
    const curP = best.rule.priority ?? 0;
    const newP = rule.priority ?? 0;
    if (newP > curP) {
      best = { rule, eval: ev, order: i };
      continue;
    }
    if (newP < curP) continue;

    // Fallback: earlier rule wins (stable). No change.
  }

  if (best) {
    return {
      decision: best.rule.decision,
      matched_rule_id: best.rule.id,
      justification: best.rule.justification,
      all_evaluations: evaluations,
    };
  }

  return {
    decision: policy.default_decision ?? 'prompt',
    all_evaluations: evaluations,
  };
}

/**
 * Lightweight schema validator — validates the shape of a policy object
 * (as might be loaded from disk). Returns a list of human-readable errors.
 * Empty array = valid.
 */
export function validatePolicy(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return ['policy must be a JSON object'];
  }
  const p = raw as Record<string, unknown>;
  if (p.schema_version !== 1) {
    errors.push(`schema_version must be 1, got ${JSON.stringify(p.schema_version)}`);
  }
  if (p.default_decision !== undefined && !['allow', 'prompt', 'deny'].includes(p.default_decision as string)) {
    errors.push(`default_decision must be 'allow'|'prompt'|'deny'`);
  }
  if (!Array.isArray(p.rules)) {
    errors.push('rules must be an array');
    return errors;
  }

  const seenIds = new Set<string>();
  p.rules.forEach((r, idx) => {
    const rule = r as Record<string, unknown>;
    const where = `rules[${idx}]`;
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      errors.push(`${where}.id must be a non-empty string`);
    } else if (seenIds.has(rule.id)) {
      errors.push(`${where}.id duplicates an earlier rule: ${rule.id}`);
    } else {
      seenIds.add(rule.id);
    }
    if (typeof rule.tool !== 'string' && !Array.isArray(rule.tool)) {
      errors.push(`${where}.tool must be a string or array of strings`);
    }
    if (!['allow', 'prompt', 'deny'].includes(rule.decision as string)) {
      errors.push(`${where}.decision must be 'allow'|'prompt'|'deny'`);
    }
    if (typeof rule.justification !== 'string') {
      errors.push(`${where}.justification must be a string`);
    }
    for (const field of ['match', 'not_match'] as const) {
      const list = rule[field];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        errors.push(`${where}.${field} must be an array`);
        continue;
      }
      list.forEach((c, ci) => {
        const clause = c as Record<string, unknown>;
        const cwhere = `${where}.${field}[${ci}]`;
        if (typeof clause.kind !== 'string') {
          errors.push(`${cwhere}.kind is required`);
          return;
        }
        const validKinds = [
          'arg_equals',
          'arg_contains',
          'arg_prefix',
          'arg_regex',
          'command_prefix',
          'command_word',
          'path_under',
          'path_basename',
          'host_executable',
        ];
        if (!validKinds.includes(clause.kind as string)) {
          errors.push(`${cwhere}.kind unknown: ${clause.kind}`);
        }
      });
    }
    if (rule.priority !== undefined && typeof rule.priority !== 'number') {
      errors.push(`${where}.priority must be a number`);
    }
  });

  return errors;
}
