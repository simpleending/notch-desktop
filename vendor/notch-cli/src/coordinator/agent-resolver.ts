/**
 * Notch CLI — Agent Resolver
 * ===========================
 * Given a free-form task description, pick the best-fit builtin subagent to
 * delegate to. Ports the intent of Codex's `codex-rs/core/src/agent/agent_resolver.rs`
 * — a keyword+capability match that nudges the top-level agent toward the
 * scholar that actually fits the job, instead of always using the generic
 * fallback.
 *
 * Why this matters: when a coordinator spawns the generic subagent for a
 * task that perfectly matches Archimedes (profiling) or Hypatia (math), the
 * worker does the right thing but with a less-focused prompt and wider tool
 * set. The resolver is a tiny heuristic that removes that accidental
 * generalism.
 *
 * The resolver is NOT authoritative — it returns a ranked list of
 * candidates. Callers (the `agent_spawn` tool, /delegate slash command,
 * planner) decide whether to use the top pick, present a chooser, or fall
 * back to 'general'. When the top score is below `MIN_CONFIDENCE`, we
 * surface 'general' explicitly as the recommendation.
 */

import { listBuiltinAgents, type BuiltinAgent } from '../agent/builtins/index.js';

export interface ResolverHit {
  agent: BuiltinAgent;
  score: number;
  reasons: string[];
}

export interface ResolverResult {
  /** Top-ranked agent. When no builtin hits, this is null; fall back to 'general'. */
  best: ResolverHit | null;
  /** All candidates with score > 0, newest-to-oldest. */
  ranked: ResolverHit[];
  /** Whether the caller should trust `best` or downgrade to 'general'. */
  confident: boolean;
}

/**
 * Per-scholar keyword taxonomy. Keep these NARROW — one wrong match sends a
 * task to the wrong specialist for the rest of the run. Scores are summed
 * across matches, so multiple cheap hits can add up.
 */
interface RoleHint {
  name: string;
  /** Weight-1 keywords — conceptual match. */
  concepts: string[];
  /** Weight-2 keywords — task-shape match. */
  tasks: string[];
  /** Weight-3 keywords — strong explicit signal ("profile", "benchmark"). */
  strong: string[];
}

const ROLE_HINTS: RoleHint[] = [
  {
    name: 'archimedes',
    concepts: ['performance', 'speed', 'latency', 'memory', 'cpu', 'throughput', 'cost'],
    tasks: ['optimize', 'benchmark', 'measure', 'slow', 'faster', 'hot path', 'profiling'],
    strong: ['profile', 'bench', 'o(n', 'big-o', 'hotspot'],
  },
  {
    name: 'euclid',
    concepts: ['proof', 'invariant', 'correctness', 'theorem', 'algorithm'],
    tasks: ['prove', 'verify', 'derive', 'axiom', 'formal'],
    strong: ['property test', 'invariant', 'induction', 'lemma'],
  },
  {
    name: 'hypatia',
    concepts: ['math', 'formula', 'statistics', 'probability', 'linear algebra', 'numerical'],
    tasks: ['compute', 'calculate', 'regression', 'distribution', 'matrix'],
    strong: ['eigenvalue', 'gradient', 'ODE', 'PDE', 'markov'],
  },
  {
    name: 'kepler',
    concepts: ['orbits', 'pattern', 'trend', 'time series', 'dataset'],
    tasks: ['analyze', 'pattern', 'forecast', 'anomaly'],
    strong: ['time-series', 'anomaly detection', 'seasonality'],
  },
  {
    name: 'plato',
    concepts: ['architecture', 'design', 'tradeoff', 'principle', 'philosophy'],
    tasks: ['design', 'refactor', 'tradeoff', 'pattern', 'architect'],
    strong: ['architectural decision', 'adr', 'design doc'],
  },
  {
    name: 'ptolemy',
    concepts: ['map', 'survey', 'inventory', 'catalog', 'codebase', 'dependency'],
    tasks: ['survey', 'map out', 'enumerate', 'list all', 'find every'],
    strong: ['dependency graph', 'module map', 'inventory'],
  },
  {
    name: 'pythagoras',
    concepts: ['test', 'assertion', 'edge case', 'spec', 'contract'],
    tasks: ['test', 'write tests', 'cover', 'assert', 'spec'],
    strong: ['unit test', 'integration test', 'coverage gap'],
  },
  {
    name: 'awaiter',
    concepts: ['wait', 'poll', 'watch', 'monitor', 'long-running'],
    tasks: ['wait for', 'watch the', 'poll', 'until'],
    strong: ['long running', 'deployment watch', 'cron'],
  },
];

const MIN_CONFIDENCE = 2; // need at least one task-weight hit or two concept hits

/** Score a task description against one role, returning {score, reasons}. */
function scoreRole(description: string, hint: RoleHint): { score: number; reasons: string[] } {
  const lower = description.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  for (const kw of hint.strong) {
    if (lower.includes(kw)) {
      score += 3;
      reasons.push(`strong:"${kw}"`);
    }
  }
  for (const kw of hint.tasks) {
    if (lower.includes(kw)) {
      score += 2;
      reasons.push(`task:"${kw}"`);
    }
  }
  for (const kw of hint.concepts) {
    if (lower.includes(kw)) {
      score += 1;
      reasons.push(`concept:"${kw}"`);
    }
  }
  return { score, reasons };
}

/**
 * Resolve a task description to the best-fit builtin subagent.
 *
 * The resolver is stateless and keyword-based — it never calls the model.
 * A 30-line function returning a ranked list is the right blast radius:
 * good enough to nudge routing in 80% of cases, trivial to audit, and
 * easy for users to override by passing the explicit subagent name.
 */
export function resolveAgent(description: string): ResolverResult {
  const agents = listBuiltinAgents();
  const byName = new Map<string, BuiltinAgent>();
  for (const a of agents) byName.set(a.name, a);

  const ranked: ResolverHit[] = [];
  for (const hint of ROLE_HINTS) {
    const agent = byName.get(hint.name);
    if (!agent) continue; // builtin not loaded — skip silently
    const { score, reasons } = scoreRole(description, hint);
    if (score > 0) ranked.push({ agent, score, reasons });
  }
  ranked.sort((a, b) => b.score - a.score);

  const best = ranked[0] ?? null;
  const confident = best !== null && best.score >= MIN_CONFIDENCE;

  return { best, ranked, confident };
}

/**
 * Convenience for tools: the caller's preferred name wins over the resolver.
 * Returns the agent to spawn OR null (meaning "use 'general'"). This is the
 * entry point the `agent_spawn` tool's `builtin_name` branch should call
 * when no explicit name was passed.
 */
export function pickAgentOrGeneral(taskDescription: string): BuiltinAgent | null {
  const result = resolveAgent(taskDescription);
  return result.confident ? result.best!.agent : null;
}
