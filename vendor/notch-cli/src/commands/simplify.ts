/**
 * Notch CLI — /simplify Command
 *
 * Fans out 3 review subagents (Reuse, Quality, Efficiency) in parallel over
 * the current diff, then aggregates findings into a single report. Optionally
 * dispatches one fixer subagent to apply the suggestions.
 *
 * Scope arg (optional):
 *   (none)       → `git diff` (uncommitted working-tree changes)
 *   staged       → `git diff --cached`
 *   last-commit  → `git show HEAD`
 *   <path>       → `git diff -- <path>` (falls back to file contents if untracked)
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { spawnParallel, nextSubagentId, type SubagentConfig, type SubagentResult } from '../agent/subagent.js';
import { renderMarkdown } from '../ui/markdown.js';
import { registerCommand } from './registry.js';

// ─── Tunables ──────────────────────────────────────────────────────────

const MAX_DIFF_BYTES = 60_000;          // diff content included in reviewer prompts
const MAX_REVIEWER_BYTES = 4_000;       // per-reviewer text in combined report
const TRUNCATION_MARKER = '\n...truncated';
const REVIEWER_TIMEOUT_ITERATIONS = 8;  // reviewers don't need the full 15

// ─── Reviewer prompts (paraphrased from leaked claude-code simplify.ts) ─

const REUSE_PROMPT = (diff: string, scopeLabel: string) => `You are the **Code Reuse reviewer**. Your one job is to find places where the diff reinvents logic that already exists in the codebase.

Use your read, grep, and glob tools to confirm each finding before reporting it — do not speculate. Common hunting grounds: utility directories, shared modules, files adjacent to the changed ones, and anything exported from a common index barrel.

## Checklist (walk through every item)
1. **Duplicated helper** — a new function that matches an existing utility by signature or purpose. Name the existing function and its path.
2. **Inline reinvention** — hand-rolled string manipulation, manual path handling, custom env checks, ad-hoc type guards, home-grown debounce/throttle/retry, re-implemented JSON parsing guards.
3. **Near-duplicate of another file in the diff** — two hunks doing almost the same thing with minor variation; flag both and propose a shared abstraction.
4. **Constant re-declaration** — a literal string or magic number that already exists as a named constant or enum.
5. **Imported-but-unused equivalent** — the file already imports a helper that would cover the new code.

## Diff under review (scope: ${scopeLabel})
\`\`\`diff
${diff}
\`\`\`

## Required output format
Respond with EXACTLY this structure and nothing else:

## Findings
- [severity] description (location)

Where:
- \`severity\` is one of \`critical\`, \`high\`, \`medium\`, \`low\`
- \`location\` is \`path/to/file.ts:lineRange\` when possible
- Each bullet names the existing utility to reuse (with its path) — a finding without a concrete replacement is not a reuse finding

If you find nothing, output exactly:

## Findings
- (none)

Do not argue with the diff, speculate about intent, or suggest unrelated work.`;

const QUALITY_PROMPT = (diff: string, scopeLabel: string) => `You are the **Code Quality reviewer**. Your one job is to flag hacky patterns in the diff.

This codebase explicitly rejects premature abstraction, dead code, and half-baked wiring (see the "never half-baked" rule in our contributor notes). Keep findings grounded in the diff — do not invent problems.

## Checklist (walk through every item)
1. **Redundant state** — new state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls.
2. **Parameter sprawl** — a new parameter bolted onto a function instead of restructuring existing ones, or a boolean flag that splits behavior two ways.
3. **Copy-paste with slight variation** — two near-duplicate blocks in the diff that should be unified.
4. **Leaky abstraction** — internal details exposed that should stay encapsulated, or a new call site that reaches across an existing layer boundary.
5. **Stringly-typed code** — raw string literals where the codebase already has a constant, string-union type, or branded type.
6. **Unnecessary nesting** — wrapper components, extra \`if\` nesting that could be early-return, or guard clauses duplicated at multiple levels.
7. **Dead branches / unused exports** — conditions that can never be true given the other conditions, exported symbols with no importer, TODO comments masking incomplete work.
8. **Unclear naming** — single-letter identifiers outside tight loops, negated booleans named as affirmatives, abbreviations that aren't project jargon.
9. **Missing edge cases** — obvious \`null\`/\`undefined\`/empty-array/zero/large-input paths not handled.
10. **Premature abstraction** — a factory, generic, or indirection added for a single call site.
11. **Unnecessary comments** — comments narrating WHAT the code does, restating identifier names, or referencing the task/caller. Keep only non-obvious WHY.

## Diff under review (scope: ${scopeLabel})
\`\`\`diff
${diff}
\`\`\`

## Required output format
Respond with EXACTLY this structure and nothing else:

## Findings
- [severity] description (location)

Where:
- \`severity\` is one of \`critical\`, \`high\`, \`medium\`, \`low\`
- \`location\` is \`path/to/file.ts:lineRange\` when possible
- Each bullet proposes a concrete change — not "consider refactoring" but "inline X into Y" or "delete Z"

If you find nothing, output exactly:

## Findings
- (none)

Do not argue with intent, suggest unrelated features, or recommend rewrites of untouched code.`;

const EFFICIENCY_PROMPT = (diff: string, scopeLabel: string) => `You are the **Efficiency reviewer**. Your one job is to flag performance and resource issues in the diff.

Stay pragmatic — micro-optimizations on a cold-path CLI command are not findings. Focus on hot paths, loops, I/O, and anything that scales with input size.

## Checklist (walk through every item)
1. **N+1 patterns** — a loop that issues one file read / DB query / HTTP request per item when a batch call exists.
2. **Redundant loops** — two passes over the same array that could be one, or repeated \`array.find\` inside a loop that should be a \`Map\` lookup.
3. **Redundant I/O** — re-reading the same file, re-fetching the same endpoint, or re-parsing the same JSON within a single invocation.
4. **Missed concurrency** — independent async operations awaited sequentially when \`Promise.all\` would work.
5. **Async-over-sync misuse** — \`await\` inside a tight CPU loop, or sync blocking calls (\`readFileSync\`, \`execSync\`) on a hot path.
6. **Hot-path bloat** — new blocking work added to startup, per-request handlers, per-render, or per-keystroke paths.
7. **Oversized data shapes** — loading entire files / datasets when a slice would do, JSON.parse on multi-MB strings, unbounded accumulators.
8. **Recurring no-op updates** — store/state writes inside polling loops or event handlers that fire with identical values (missing change-detection guard).
9. **Unnecessary existence checks** — \`if (fs.existsSync(p)) fs.readFile(p, ...)\` (TOCTOU); operate directly and catch the error.
10. **Leaks** — event listeners added without removal, intervals/timeouts without clear, unbounded caches, open file handles.
11. **Premature buffering** — collecting a stream into an array before processing when streaming would suffice.

## Diff under review (scope: ${scopeLabel})
\`\`\`diff
${diff}
\`\`\`

## Required output format
Respond with EXACTLY this structure and nothing else:

## Findings
- [severity] description (location)

Where:
- \`severity\` is one of \`critical\`, \`high\`, \`medium\`, \`low\`
- \`location\` is \`path/to/file.ts:lineRange\` when possible
- Each bullet states the concrete fix (e.g. "replace the for-await with Promise.all over the file reads")

If you find nothing, output exactly:

## Findings
- (none)

Do not speculate about runtime benchmarks or suggest migrations of untouched code.`;

// ─── Helpers ───────────────────────────────────────────────────────────

type Scope = { kind: 'working' | 'staged' | 'last-commit' | 'path'; label: string; target?: string };

function parseScope(arg: string): Scope {
  const trimmed = arg.trim();
  if (!trimmed) return { kind: 'working', label: 'uncommitted (working tree)' };
  if (trimmed === 'staged') return { kind: 'staged', label: 'staged changes' };
  if (trimmed === 'last-commit') return { kind: 'last-commit', label: 'HEAD commit' };
  return { kind: 'path', label: `path: ${trimmed}`, target: trimmed };
}

function collectDiff(scope: Scope, cwd: string): { diff: string; stat: string } {
  const runGit = (args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 5 * 1024 * 1024,
    }).trim();

  if (scope.kind === 'working') {
    return { diff: runGit(['diff']), stat: runGit(['diff', '--stat']) };
  }
  if (scope.kind === 'staged') {
    return { diff: runGit(['diff', '--cached']), stat: runGit(['diff', '--cached', '--stat']) };
  }
  if (scope.kind === 'last-commit') {
    return { diff: runGit(['show', 'HEAD']), stat: runGit(['show', '--stat', '--format=', 'HEAD']) };
  }
  // path scope — restrict git pathspec with the `--` separator
  const target = scope.target!;
  const diff = runGit(['diff', '--', target]);
  if (diff) {
    return { diff, stat: runGit(['diff', '--stat', '--', target]) };
  }
  // Untracked or unchanged — fall back to file contents so the reviewers still have material
  const absolute = path.resolve(cwd, target);
  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
    const contents = fs.readFileSync(absolute, 'utf-8');
    const synthetic = `--- /dev/null\n+++ b/${target}\n` + contents.split('\n').map((l) => '+' + l).join('\n');
    return { diff: synthetic, stat: `${target} | ${contents.split('\n').length} lines (file snapshot — no diff)` };
  }
  return { diff: '', stat: '' };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + TRUNCATION_MARKER;
}

function countFindings(text: string): number {
  // Lines that look like "- [severity] ..."
  const matches = text.match(/^\s*-\s*\[(critical|high|medium|low)\]/gim);
  if (!matches) return 0;
  return matches.length;
}

function extractFindingsSection(text: string): string {
  // Keep only the "## Findings" block if present; otherwise return the whole text
  const idx = text.search(/^##\s+Findings/m);
  if (idx < 0) return text.trim();
  return text.slice(idx).trim();
}

// ─── Command ───────────────────────────────────────────────────────────

registerCommand('/simplify', async (args, ctx) => {
  if (!ctx.model || !ctx.toolContext) {
    console.log(chalk.red('  /simplify requires an active model and tool context (run from an interactive session).\n'));
    return;
  }

  const scope = parseScope(args);
  const confirm = ctx.confirm ?? ctx.toolContext.confirm;

  let diff: string;
  let stat: string;
  try {
    ({ diff, stat } = collectDiff(scope, ctx.cwd));
  } catch (err: any) {
    console.log(chalk.red(`  Could not collect diff for ${scope.label}: ${err.message}\n`));
    return;
  }

  if (!diff) {
    console.log(chalk.gray('  Nothing to simplify.\n'));
    return;
  }

  const truncatedDiff = diff.length > MAX_DIFF_BYTES
    ? diff.slice(0, MAX_DIFF_BYTES) + TRUNCATION_MARKER
    : diff;

  console.log(chalk.gray(`\n  Simplify — scope: ${scope.label}`));
  if (stat) {
    for (const line of stat.split('\n')) console.log(chalk.gray(`    ${line}`));
  }
  console.log(chalk.gray('\n  Spawning 3 reviewers in parallel (reuse, quality, efficiency)...\n'));

  const onStatus = (id: string, status: string) => {
    console.log(chalk.gray(`    [${id}] ${status}`));
  };

  const baseConfig = {
    type: 'general' as const,
    model: ctx.model,
    toolContext: ctx.toolContext,
    maxIterations: REVIEWER_TIMEOUT_ITERATIONS,
    onStatus,
  };

  const configs: SubagentConfig[] = [
    {
      ...baseConfig,
      id: nextSubagentId('general') + '-reuse',
      prompt: REUSE_PROMPT(truncatedDiff, scope.label),
    },
    {
      ...baseConfig,
      id: nextSubagentId('general') + '-quality',
      prompt: QUALITY_PROMPT(truncatedDiff, scope.label),
    },
    {
      ...baseConfig,
      id: nextSubagentId('general') + '-efficiency',
      prompt: EFFICIENCY_PROMPT(truncatedDiff, scope.label),
    },
  ];

  let results: SubagentResult[];
  try {
    results = await spawnParallel(configs);
  } catch (err: any) {
    console.log(chalk.red(`\n  Reviewers crashed: ${err.message}\n`));
    return;
  }

  const [reuseResult, qualityResult, efficiencyResult] = results;
  const labelFor = (id: string) =>
    id.endsWith('-reuse') ? 'Reuse' : id.endsWith('-quality') ? 'Quality' : 'Efficiency';

  const sections = results.map((r) => {
    const label = labelFor(r.id);
    if (r.error) {
      return { label, findings: 0, body: `_Reviewer failed: ${r.error}_` };
    }
    const body = truncate(extractFindingsSection(r.text || '## Findings\n- (none)'), MAX_REVIEWER_BYTES);
    return { label, findings: countFindings(body), body };
  });

  const totalFindings = sections.reduce((n, s) => n + s.findings, 0);

  // Build combined markdown report
  const reportLines: string[] = [];
  reportLines.push(`# Simplify Report`);
  reportLines.push('');
  reportLines.push(`**Scope:** ${scope.label}`);
  reportLines.push(`**Summary:** 3 reviewers found ${totalFindings} total suggestion${totalFindings === 1 ? '' : 's'}.`);
  reportLines.push('');
  for (const s of sections) {
    reportLines.push(`## ${s.label} (${s.findings})`);
    reportLines.push('');
    reportLines.push(s.body);
    reportLines.push('');
  }

  let report = reportLines.join('\n');
  // Hard cap the whole report at ~16KB
  if (report.length > 16_000) {
    report = report.slice(0, 16_000) + TRUNCATION_MARKER;
  }

  console.log(renderMarkdown(report));
  console.log('');

  if (totalFindings === 0) {
    console.log(chalk.green('  Code is already clean — nothing to apply.\n'));
    return;
  }

  const apply = confirm ? await confirm('  Apply findings automatically?') : false;
  if (!apply) {
    console.log(chalk.gray('  Skipped — report only.\n'));
    return;
  }

  console.log(chalk.gray('\n  Dispatching fixer subagent...\n'));
  const fixerPrompt = `You are the Simplify fixer. Apply the findings below to the working tree.

Rules:
- Use your edit/write tools to make the changes. Do NOT commit.
- Fix each finding directly. If a finding is a false positive or would regress behavior, note it in your final summary and skip it — do not argue.
- Preserve existing tests. If a change breaks an obvious invariant, adjust the adjacent test; otherwise leave tests alone.
- When done, emit a short summary: \`## Applied\` with one bullet per fix, and \`## Skipped\` with one bullet per skipped finding and why.

Scope under repair: ${scope.label}

${report}`;

  try {
    const [fixerResult] = await spawnParallel([
      {
        ...baseConfig,
        id: nextSubagentId('general') + '-fixer',
        prompt: fixerPrompt,
        maxIterations: 20,
      },
    ]);
    const summary = truncate(fixerResult!.text || '_Fixer returned no summary_', 6_000);
    console.log(renderMarkdown(summary));
    if (fixerResult!.error) {
      console.log(chalk.red(`\n  Fixer reported an error: ${fixerResult!.error}\n`));
    } else {
      console.log(chalk.green('\n  Fixer finished. Review changes with git diff before committing.\n'));
    }
  } catch (err: any) {
    console.log(chalk.red(`\n  Fixer crashed: ${err.message}\n`));
  }

  // Avoid unused-var lint on the destructure above — keep the references so future
  // per-reviewer logic can re-enter this block without re-shaping the code.
  void reuseResult;
  void qualityResult;
  void efficiencyResult;
});
