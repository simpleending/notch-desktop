/**
 * Notch CLI — GitHub Tool
 *
 * Creates PRs, lists issues, views repo info via GitHub API.
 * Uses the user's GitHub token from env or git credential helper.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult, ToolContext } from './types.js';

const GITHUB_API = 'https://api.github.com';

async function gitHubExecutable(): Promise<string | null> {
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (root) candidates.push(path.join(root, 'GitHub CLI', name));
    }
  }
  candidates.push(name);
  for (const file of candidates) {
    if (path.basename(file).toLowerCase() !== name) continue;
    if (file === name) return file;
    try { await fs.access(file); return file; } catch { /* Try the next install location. */ }
  }
  return null;
}

async function getToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  const executable = await gitHubExecutable();
  if (!executable) return null;
  try {
    const token = await new Promise<string>((resolve, reject) => {
      const env = { ...process.env };
      delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.GH_ENTERPRISE_TOKEN; delete env.GITHUB_ENTERPRISE_TOKEN;
      execFile(executable, ['auth', 'token', '--hostname', 'github.com'], { windowsHide: true, timeout: 15_000, env }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()));
    });
    if (/^[\w.-]+$/.test(token) && token.length >= 8 && token.length <= 300) return token;
  } catch { /* The GitHub CLI is not signed in. */ }
  return null;
}

async function ghFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    ...(opts.headers as Record<string, string> ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return fetch(`${GITHUB_API}${path}`, { ...opts, headers });
}

const parameters = z.object({
  action: z.enum([
    'create_pr',
    'list_prs',
    'list_issues',
    'repo_info',
    'create_issue',
    'pr_status',
  ]).describe('The GitHub operation to perform'),
  owner: z.string().describe('Repository owner (user or org)'),
  repo: z.string().describe('Repository name'),
  // PR fields
  title: z.string().optional().describe('PR or issue title'),
  body: z.string().optional().describe('PR or issue body/description'),
  head: z.string().optional().describe('PR source branch'),
  base: z.string().optional().describe('PR target branch (default: main)'),
  // Issue fields
  labels: z.array(z.string()).optional().describe('Labels for issue'),
  // Filter
  state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state'),
  pr_number: z.number().optional().describe('PR number for status check'),
});

async function execute(
  args: z.infer<typeof parameters>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const token = await getToken();
  if (!token) {
    return {
      content: 'GitHub is not signed in. Open Settings and choose Sign in with GitHub, or run `notch github login`. You can also set GITHUB_TOKEN.',
      isError: true,
    };
  }

  try {
    switch (args.action) {
      case 'repo_info': {
        const res = await ghFetch(`/repos/${args.owner}/${args.repo}`);
        if (!res.ok) return { content: `GitHub API error: ${res.status} ${await res.text()}`, isError: true };
        const repo = await res.json() as any;
        return {
          content: [
            `Repository: ${repo.full_name}`,
            `Description: ${repo.description || 'None'}`,
            `Stars: ${repo.stargazers_count} | Forks: ${repo.forks_count} | Open issues: ${repo.open_issues_count}`,
            `Default branch: ${repo.default_branch}`,
            `Language: ${repo.language || 'Unknown'}`,
            `Private: ${repo.private}`,
            `URL: ${repo.html_url}`,
          ].join('\n'),
        };
      }

      case 'list_prs': {
        const state = args.state ?? 'open';
        const res = await ghFetch(`/repos/${args.owner}/${args.repo}/pulls?state=${state}&per_page=15`);
        if (!res.ok) return { content: `GitHub API error: ${res.status}`, isError: true };
        const prs = await res.json() as any[];
        if (prs.length === 0) return { content: `No ${state} pull requests.` };
        const lines = prs.map((pr: any) =>
          `#${pr.number} [${pr.state}] ${pr.title} (${pr.head.ref} → ${pr.base.ref}) by @${pr.user.login}`
        );
        return { content: lines.join('\n') };
      }

      case 'list_issues': {
        const state = args.state ?? 'open';
        const res = await ghFetch(`/repos/${args.owner}/${args.repo}/issues?state=${state}&per_page=15`);
        if (!res.ok) return { content: `GitHub API error: ${res.status}`, isError: true };
        const issues = await res.json() as any[];
        // Filter out PRs (GitHub API includes PRs in issues)
        const realIssues = issues.filter((i: any) => !i.pull_request);
        if (realIssues.length === 0) return { content: `No ${state} issues.` };
        const lines = realIssues.map((i: any) => {
          const labels = i.labels.map((l: any) => l.name).join(', ');
          return `#${i.number} [${i.state}] ${i.title}${labels ? ` [${labels}]` : ''} by @${i.user.login}`;
        });
        return { content: lines.join('\n') };
      }

      case 'create_pr': {
        if (!args.title || !args.head) {
          return { content: 'title and head branch are required for create_pr', isError: true };
        }
        const res = await ghFetch(`/repos/${args.owner}/${args.repo}/pulls`, {
          method: 'POST',
          body: JSON.stringify({
            title: args.title,
            body: args.body ?? '',
            head: args.head,
            base: args.base ?? 'main',
          }),
        });
        if (!res.ok) {
          const err = await res.json() as any;
          return { content: `Failed to create PR: ${err.message || res.status}`, isError: true };
        }
        const pr = await res.json() as any;
        return { content: `PR #${pr.number} created: ${pr.html_url}` };
      }

      case 'create_issue': {
        if (!args.title) {
          return { content: 'title is required for create_issue', isError: true };
        }
        const res = await ghFetch(`/repos/${args.owner}/${args.repo}/issues`, {
          method: 'POST',
          body: JSON.stringify({
            title: args.title,
            body: args.body ?? '',
            labels: args.labels ?? [],
          }),
        });
        if (!res.ok) {
          const err = await res.json() as any;
          return { content: `Failed to create issue: ${err.message || res.status}`, isError: true };
        }
        const issue = await res.json() as any;
        return { content: `Issue #${issue.number} created: ${issue.html_url}` };
      }

      case 'pr_status': {
        if (!args.pr_number) {
          return { content: 'pr_number is required for pr_status', isError: true };
        }
        const res = await ghFetch(`/repos/${args.owner}/${args.repo}/pulls/${args.pr_number}`);
        if (!res.ok) return { content: `GitHub API error: ${res.status}`, isError: true };
        const pr = await res.json() as any;

        // Get checks
        const checksRes = await ghFetch(`/repos/${args.owner}/${args.repo}/commits/${pr.head.sha}/check-runs`);
        let checksInfo = '';
        if (checksRes.ok) {
          const checks = await checksRes.json() as any;
          if (checks.check_runs?.length) {
            checksInfo = '\nChecks:\n' + checks.check_runs.map((c: any) =>
              `  ${c.status === 'completed' ? (c.conclusion === 'success' ? '✓' : '✗') : '◌'} ${c.name}: ${c.conclusion ?? c.status}`
            ).join('\n');
          }
        }

        return {
          content: [
            `PR #${pr.number}: ${pr.title}`,
            `State: ${pr.state} | Mergeable: ${pr.mergeable ?? 'checking...'}`,
            `${pr.head.ref} → ${pr.base.ref}`,
            `Author: @${pr.user.login}`,
            `+${pr.additions} -${pr.deletions} (${pr.changed_files} files)`,
            `Reviews: ${pr.requested_reviewers?.length ?? 0} requested`,
            checksInfo,
            `URL: ${pr.html_url}`,
          ].join('\n'),
        };
      }

      default:
        return { content: `Unknown action: ${args.action}`, isError: true };
    }
  } catch (err: any) {
    return { content: `GitHub error: ${err.message}`, isError: true };
  }
}

export const githubTool: NotchTool<typeof parameters> = {
  name: 'github',
  description: 'GitHub operations for pull requests, issues, and repository info. Local commit and push uses the git tool operation commit_and_push. Uses the GitHub CLI sign-in from Settings, or GITHUB_TOKEN. Uses GitHub REST API version 2026-03-10.',
  parameters,
  execute,
};
