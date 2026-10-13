/**
 * Notch CLI — /security-review Command
 *
 * Analyzes recent file changes for common security vulnerabilities.
 * Runs git diff and sends a security-focused prompt through the agent.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execFileSync, execSync } from 'node:child_process';
import chalk from 'chalk';
import { registerCommand } from './registry.js';

/** Validate git revision range to prevent command injection */
function isValidGitRange(range: string): boolean {
  // Allow only safe chars: alphanumeric, dots, tildes, carets, slashes, hyphens, underscores
  return /^[a-zA-Z0-9._~^\/\-]+(\.\.[a-zA-Z0-9._~^\/\-]+)?$/.test(range);
}

registerCommand('/security-review', async (args, ctx) => {
  // Get recent changes — default last 5 commits, or custom range
  const range = args || 'HEAD~5..HEAD';

  if (!isValidGitRange(range)) {
    console.log(chalk.red('  Invalid git range. Use formats like: HEAD~5..HEAD, main..feature, abc123\n'));
    return;
  }

  let diff: string;
  let stat: string;

  try {
    stat = execFileSync('git', ['diff', range, '--stat'], {
      cwd: ctx.cwd,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    diff = execFileSync('git', ['diff', range], {
      cwd: ctx.cwd,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 1024 * 1024 * 5, // 5MB
    }).trim();
  } catch {
    // Fall back to unstaged changes
    try {
      stat = execSync('git diff --stat', {
        cwd: ctx.cwd,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      diff = execSync('git diff', {
        cwd: ctx.cwd,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024 * 5,
      }).trim();
    } catch (err: any) {
      console.log(chalk.red(`  Could not get diff: ${err.message}\n`));
      return;
    }
  }

  if (!diff) {
    console.log(chalk.gray('  No changes to review.\n'));
    return;
  }

  console.log(chalk.gray(`  Reviewing changes...\n`));
  console.log(chalk.gray(`  ${stat}\n`));

  // Truncate diff for context window
  const maxDiffLen = 50_000;
  const truncatedDiff = diff.length > maxDiffLen
    ? diff.slice(0, maxDiffLen) + '\n... (truncated)'
    : diff;

  const prompt = `Perform a thorough security review of these recent code changes. Use your tools to read full files if you need more context.

## Changed Files
${stat}

## Diff
\`\`\`diff
${truncatedDiff}
\`\`\`

## Review Checklist
Analyze for these vulnerability categories:
1. **Secrets & Credentials** — Hardcoded API keys, tokens, passwords, or connection strings
2. **Injection** — SQL injection, command injection, XSS, template injection
3. **Authentication & Authorization** — Broken auth, missing access controls, session issues
4. **Input Validation** — Missing or insufficient input validation at system boundaries
5. **Path Traversal** — Unsanitized file paths that could escape the project root
6. **Dependency Issues** — New dependencies with known vulnerabilities
7. **Cryptography** — Weak algorithms, hardcoded IVs/salts, insecure random
8. **Information Disclosure** — Verbose errors, stack traces in production, debug endpoints
9. **Race Conditions** — TOCTOU, unsafe concurrent access to shared state
10. **Configuration** — Insecure defaults, overly permissive CORS/CSP/permissions

For each finding, provide:
- **Severity**: Critical / High / Medium / Low
- **File and line**: Where the issue is
- **Description**: What the vulnerability is
- **Fix**: How to remediate it

If no issues are found, say so explicitly. Do not fabricate issues.`;

  // Send through the main conversation so the agent can use tools
  ctx.messages.push({ role: 'user', content: prompt });

  try {
    await ctx.runPrompt(prompt, ctx.messages);
  } catch (err: any) {
    console.log(chalk.red(`  Security review failed: ${err.message}\n`));
  }
});
