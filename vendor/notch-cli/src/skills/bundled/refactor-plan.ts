/**
 * Notch CLI — Bundled Skill: refactor-plan
 *
 * Produces a numbered refactor plan — small atomic steps, tests preserved
 * at each step, risk called out. Does NOT execute the refactor.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { registerSkill } from '../registry.js';
import type { Skill } from '../types.js';

const PRINCIPLES_MD = `# Refactor Planning Principles

A refactor that ships is better than a beautiful one that doesn't. Every
principle below is in service of that.

## 1. Small, atomic steps

Each step in the plan should:

- Compile, lint, and pass tests on its own.
- Be revertable as a single commit without cascading damage.
- Touch one concern: renaming, extracting, inlining, moving — not three
  at once.

Heuristic: if a step's diff touches more than ~200 lines or more than
~5 files, it's probably two steps.

## 2. Preserve tests at every step

Do NOT pause tests and "fix them at the end." That hides whether each
step is actually correct. If a step requires changing test shapes,
schedule a *prior* step that adjusts tests to the new shape while the
old behavior still works (often via a shim).

Green bar at every commit, no exceptions.

## 3. One concern at a time

A refactor is not the time to:

- Fix a bug (do that first or after, in its own commit)
- Optimize performance (separate pass)
- Add a feature (absolutely not)

If you find a bug mid-refactor, file it and keep refactoring. Mixing
invalidates the "pure refactor, no behavior change" contract and makes
review untrustworthy.

## 4. Move-then-rename, not rename-then-move

When both are needed, physically relocate the code first (preserving the
old name), verify everything still works, THEN rename. This keeps VCS
rename detection working, which gives you blame history for free.

## 5. Introduce the new shape alongside the old

Pattern: \`OldThing\` → add \`NewThing\` that wraps / delegates to
\`OldThing\` → migrate callers one at a time → delete \`OldThing\`.

This lets each caller migrate in its own commit and keeps the build
green the whole way.

## 6. Strangler fig for large refactors

For a refactor touching >20 files, don't big-bang it. Build the new
implementation behind a flag or behind the new API, migrate module by
module, and remove the old implementation in a final cleanup commit.

## 7. Make state changes reversible

If a step changes on-disk data (schema migration, config format), the
NEXT commit should be able to run on databases that ran either the old
or new code. Coordinate deployments: ship the forward-compatible reader
first, run the migration, THEN ship the writer that depends on it.

## 8. Tests as refactor witnesses

For risky refactors, add *characterization tests* before you start:
tests that pin down current behavior (even quirks) so you notice if the
refactor changes semantics. Delete them at the end if they duplicate
what's already covered.

## 9. Write the deprecation before the removal

If public types change, ship the deprecation in one commit, migrate
internal callers in another, remove in a third. Even if all three ship
in the same release, the separate commits make review tractable.

## 10. Calibrate risk per step

Not all steps are equal. For the plan you produce, label each step
with a risk level:

- **L (low)** — pure mechanical change, compiler enforces correctness
  (rename, move). Unlikely to break anything the tests don't catch.
- **M (medium)** — semantic-ish change, tests should catch most issues
  but review worthwhile (extracting a function, consolidating duplicates).
- **H (high)** — behavior-adjacent, tests may not cover (changing
  control flow, replacing a library, altering error paths). Requires
  manual verification beyond CI.

A plan that's all-L is usually too timid (the refactor isn't doing
much). A plan with back-to-back H steps is usually too aggressive —
insert verification/reversibility steps between them.

## 11. Know when to stop

A refactor plan has a budget. If Step 7 of your plan is "and then also
clean up this unrelated thing," cut it. Ship the focused refactor.
The unrelated thing is a separate ticket.
`;

const PROMPT = `You are producing a refactor plan. You will NOT execute the refactor —
only plan it. The user will review, adjust, and execute themselves.

Read \`principles.md\` (in the base directory above) first. Your plan
must visibly reflect those principles, not just name-check them.

## Input

The user supplies the target: a file, a module, a class, or a described
concern ("extract all DB access into a repository layer"). If the target
is ambiguous, ask one clarifying question and stop — don't speculate.

## Investigation (before writing the plan)

- \`Read\` the target code in full, not skimmed.
- \`Grep\` for every caller / consumer — the plan's step count depends on
  how many call sites exist.
- Check tests (\`Grep\` for imports of the target modules in test files).
  Note what's covered and what isn't. Gaps affect your risk labels.

## Plan format

Output a numbered list. Each step has this shape:

    Step N — <imperative verb phrase>  [risk: L|M|H]

    What:  <one sentence of what changes>
    Why:   <one sentence of why this is its own step>
    Files: <bullet list of files touched, or 'various — see below'>
    Tests: <which tests must pass; any test changes included in THIS step>
    Check: <how you verify the step worked before moving on>

Between logical phases, add a brief prose paragraph explaining the
transition — why the next phase needs a separate commit, not a
continuation of the current one.

## Rules for your plan

- Start with any characterization tests needed to pin current behavior
  (reference principle 8). If the existing test coverage is thick,
  skip this step and say so explicitly.
- End with a cleanup step that deletes the old shape, IF the refactor
  introduces a new one (principle 5).
- Every step independently compiles and passes tests (principle 2).
- No step mixes bug fixes or feature work with refactor work
  (principle 3).
- Label risk honestly — don't call an H step an M because "we'll be
  careful." The label is for the reader, not for your ego.
- Finish with a short "Out of scope" paragraph: things you noticed
  that would be nice to clean up but are NOT in this plan (principle
  11). Keep it to 2–4 bullets max.
- If the refactor would cross a public API boundary, call it out in a
  final "Compatibility notes" paragraph — deprecations, versioning,
  consumer migration guidance.

Do NOT write code diffs. Do NOT apply edits. The user will take this
plan and execute it (or hand it to another agent). Your job is to
produce a plan they can trust.
`;

export const refactorPlanSkill: Skill = {
  id: 'refactor-plan',
  name: 'Refactor Plan',
  description: 'Produce a numbered, risk-labeled refactor plan without executing it.',
  prompt: PROMPT,
  files: {
    'principles.md': PRINCIPLES_MD,
  },
  allowedTools: ['read', 'grep', 'glob'],
};

registerSkill(refactorPlanSkill);
