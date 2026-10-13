/**
 * Notch CLI — Bundled Skill: debug-assist
 *
 * Walks a structured triage when a test, build, or deploy is failing.
 * Ships a `triage.md` decision tree so the agent follows a consistent
 * playbook: read the error, narrow to the call site, check recent commits,
 * reproduce locally, then form a hypothesis.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { registerSkill } from '../registry.js';
import type { Skill } from '../types.js';

const TRIAGE_MD = `# Debug Triage Decision Tree

Follow the branches in order. Don't skip ahead — each step cheaply rules
out a class of cause before the next, more expensive step.

## Step 0 — What exactly broke?

Before doing anything, restate in one sentence what is failing and how you
know. "The CI build failed" is NOT a restatement — *which* step, *which*
assertion, *which* stack frame. If the user hasn't supplied the verbatim
error text, ask or go find it.

## Step 1 — Read the error top to bottom

- First line of the stack trace is rarely the root cause. Read the whole
  stack. The *first frame in user code* (skip node_modules, runtime,
  framework) is where to start.
- Distinguish the *error type* from the *error message*. \`TypeError:
  Cannot read properties of undefined (reading 'foo')\` has two signals:
  something is \`undefined\`, and it's accessed at \`.foo\`.
- Note the file path and line number. That's your anchor.

## Step 2 — Is it a known category?

Before spelunking, eyeball the category. Common ones:

- **Async/await bug**: \`undefined\` / \`Promise { <pending> }\` on a property
  → someone forgot \`await\`.
- **Type coercion**: \`NaN\`, \`[object Object]\`, silent \`==\` vs \`===\`
  mismatches.
- **Module resolution**: \`Cannot find module\`, \`ERR_MODULE_NOT_FOUND\` →
  extension missing in import, ESM/CJS mix, wrong \`exports\` field.
- **Env / config drift**: works locally, fails on CI → env var, path,
  case-sensitivity, Node version.
- **Race condition**: flaky test (fails 1/5 runs) → shared mutable state
  or missing \`await\` in test setup.
- **Recent dep upgrade**: error mentions a library → check \`package.json\`
  diff.

If you can confidently name the category, jump to the matching remediation
in Step 5. Otherwise continue.

## Step 3 — Find the call site

- \`Grep\` for the error message verbatim first — maybe the code throws it
  explicitly and the line tells you why.
- \`Read\` the file+line from the stack trace. Read ±20 lines of context.
- Identify the variable or expression that's producing the bad value.

## Step 4 — Check recent commits

If Step 3 doesn't scream, check \`git log -- <failing-file>\`. Compare with
\`git log --since='7 days ago' --stat\`. A fresh commit in the same area is
your prime suspect. \`git blame -L <line>,<line> <file>\` pins the commit
that last touched the failing line.

## Step 5 — Minimal reproduction

If the bug isn't obvious from reading, reproduce it with the smallest
possible input:

- For failing tests: run the single test in isolation (\`vitest -t\`,
  \`jest --testNamePattern\`), not the whole suite.
- For build failures: isolate the file (\`tsc --noEmit path/to/file.ts\`).
- For runtime: write a 5-line script that calls the failing function
  directly with the values from the stack.

A reproduction you can run in under 2 seconds is worth an hour of
staring.

## Step 6 — Form ONE hypothesis, test it

State a specific hypothesis: "I believe X is happening because Y." Then
design the cheapest test that would falsify it. Log a value, bisect a
commit, toggle a flag. *Do not* change code to "see if it fixes it" —
that's guessing.

## Step 7 — Fix, but verify the root

When you believe you've found the root cause:

1. Explain *why* it happened, not just what changed. A fix without a
   cause story is a symptom patch.
2. Ask whether the same root cause has other manifestations. One race
   usually has siblings.
3. Write a regression test *first*, confirm it fails, then ship the fix.

## Remediation cheat sheet

- \`Cannot read properties of undefined\` → upstream returned undefined
  without you checking. Add the check or the \`await\`.
- \`Cannot find module\` → check import extension (\`.js\` in ESM!), check
  \`exports\` field, check case sensitivity.
- \`Maximum call stack exceeded\` → recursion without a base case, or
  circular import resolving differently in test vs prod.
- \`EACCES\` / \`EPERM\` → file mode, wrong directory, or CI sandbox.
- \`ECONNREFUSED\` → service not running, wrong port, or localhost vs
  127.0.0.1 mismatch.
- TS \`Type X is not assignable to Y\` where the types look identical →
  two copies of the same library's types (check \`npm ls <lib>\`).
`;

const PROMPT = `You are helping the user diagnose a failing test, build, or deploy.
Follow the triage decision tree in \`triage.md\` (in the base directory
above) EXACTLY in order. Each step has a purpose — don't skip ahead even
if you have a hunch.

## Your walkthrough

1. **Step 0 — Restate the failure.** One sentence. If the user didn't
   supply the verbatim error, ask for it or go read the log / test
   output first. Do not proceed without concrete error text.

2. **Step 1 — Read the error.** Quote the error type + first user-code
   frame. Name the file and line.

3. **Step 2 — Categorize.** Match against the cheat sheet. If you can
   confidently name the category, say so and jump to remediation.
   Otherwise keep going.

4. **Step 3 — Find the call site.** \`Read\` the file at the failing line.
   Show the relevant code snippet (minimal context).

5. **Step 4 — Recent commits.** Run \`git log --oneline -- <file>\` for
   the failing file. Call out any commits from the last week.

6. **Step 5 — Reproduction.** Describe the smallest repro you'd run.
   If you can run it yourself safely, do so. If it requires destructive
   ops or services the user has to start, tell them the exact command
   and stop there.

7. **Step 6 — Hypothesis.** State ONE specific hypothesis and the
   cheapest falsifying test. Then run that test.

8. **Step 7 — Root cause + fix.** Explain *why* it happened. Propose
   the fix. Flag any sibling bugs that share the root. Suggest a
   regression test.

## Output format

Use section headers matching the steps above. Be terse — no filler. If
a step doesn't apply (e.g., no recent commits because the repo is one
day old), say "N/A — <reason>" in one line and move on.

Do NOT apply a fix without the user's explicit approval. This skill
diagnoses; it does not auto-patch.
`;

export const debugAssistSkill: Skill = {
  id: 'debug-assist',
  name: 'Debug Triage',
  description: 'Diagnose a failing test, build, or deploy using a structured decision tree.',
  prompt: PROMPT,
  files: {
    'triage.md': TRIAGE_MD,
  },
  allowedTools: ['read', 'grep', 'glob', 'bash'],
};

registerSkill(debugAssistSkill);
