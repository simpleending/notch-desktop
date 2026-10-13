/**
 * Notch CLI — Bundled Skill: commit-message
 *
 * Generates a conventional-commit message from the current staged diff.
 * Ships a `templates.md` reference file with worked examples so the agent
 * can match style without re-deriving conventions from scratch each run.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { registerSkill } from '../registry.js';
import type { Skill } from '../types.js';

const TEMPLATES_MD = `# Conventional Commit Templates

Format:
    <type>(<scope>)!: <subject>

    <body>

    <footer>

## Types

- **feat** — new user-facing feature
- **fix** — bug fix
- **perf** — performance improvement (no behavior change)
- **refactor** — code change that neither fixes a bug nor adds a feature
- **docs** — documentation only
- **test** — adding/fixing tests
- **build** — build system / dependencies
- **ci** — CI config
- **chore** — tooling, non-code maintenance
- **revert** — reverts a prior commit

Append \`!\` after the type/scope for breaking changes. Also add a
\`BREAKING CHANGE:\` footer explaining the break.

## Subject rules

- Imperative mood ("add", not "added" / "adds")
- Lowercase first word (unless proper noun)
- No trailing period
- Hard cap: 72 chars. Aim for <= 60.

## Scope

Optional. A short noun pointing at the affected area:
- package / module name (\`auth\`, \`router\`, \`cli\`)
- broad area (\`ui\`, \`api\`, \`deps\`)
- filename stem when the change is clearly one file

Skip scope if the change is broad or doesn't map cleanly. Don't invent one.

## Body

Optional. Wrap at 72 cols. Explain *why*, not *what* (the diff shows what).
Use bullets for multiple distinct points. Reference issues with \`Fixes #123\`
in the footer, not the body.

## Worked examples

### Simple fix
    fix(auth): reject tokens with empty subject claim

    Tokens with "sub": "" were passing validation and resolving to the
    anonymous user. Treat empty sub as invalid.

    Fixes #412

### Feature with scope
    feat(cli): add --json flag to emit structured events

    Enables programmatic consumers to drive the CLI without screen-scraping
    ANSI output. Events are newline-delimited JSON on stdout; human output
    is suppressed when the flag is set.

### Refactor, no behavior change
    refactor(session): extract rollout writer into its own module

### Breaking change
    feat(api)!: require bearer tokens on /v1/plans endpoints

    BREAKING CHANGE: /v1/plans no longer accepts API keys in the query
    string. Send them as Authorization: Bearer <key> instead.

### Chore
    chore(deps): bump typescript to 5.6.2

## Anti-patterns

- Do NOT write \`update code\`, \`misc changes\`, \`wip\`, \`stuff\`.
- Do NOT paste the diff into the body.
- Do NOT use past tense (\`added X\`, \`fixed Y\`).
- Do NOT list every file touched — that's what the diff is for.
- Do NOT include Co-Authored-By unless the user asked.
`;

const PROMPT = `You are generating a single conventional-commit message for the staged
changes in the current working directory.

Steps:
1. Read \`templates.md\` (in the base directory above) for the full format,
   type list, subject rules, and worked examples. Follow them strictly.
2. Run \`git diff --cached --stat\` and \`git diff --cached\` to inspect the
   staged changes. If nothing is staged, run \`git diff --stat\` / \`git diff\`
   on unstaged work and note that you're describing unstaged changes.
3. Pick the single best \`<type>\` for the change. If multiple types genuinely
   apply, pick the one that describes the user-facing intent — \`feat\` beats
   \`refactor\` when a feature landed alongside cleanup.
4. Pick a scope only if one area is clearly dominant.
5. Draft the subject line. Imperative, lowercase, <= 72 chars (aim <= 60).
6. Add a body only if "why" is non-obvious from the subject.
7. Flag breaking changes with \`!\` and a \`BREAKING CHANGE:\` footer.

Output contract:
- Emit ONLY the commit message. No preamble ("Here's your message:"), no
  trailing commentary, no code fences, no quotes around it.
- No markdown. Plain text.
- Subject on line 1. If a body is present, a blank line, then the body.

If the diff is empty or too large to describe faithfully, say so in one
line and stop — do not fabricate a message.
`;

export const commitMessageSkill: Skill = {
  id: 'commit-message',
  name: 'Commit Message',
  description: 'Generate a conventional-commit message from the staged diff.',
  prompt: PROMPT,
  files: {
    'templates.md': TEMPLATES_MD,
  },
  allowedTools: ['bash', 'read', 'grep'],
};

registerSkill(commitMessageSkill);
