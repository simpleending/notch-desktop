/**
 * Notch CLI — GitHub Tool
 *
 * Creates PRs, lists issues, views repo info via GitHub API.
 * Uses the user's GitHub token from env or git credential helper.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { z } from 'zod';
import type { NotchTool, ToolResult, ToolContext } from './types.js';

const GITHUB_API = 'https://api.github.com';

function getToken(): string | null {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

async function ghFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
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
  const token = getToken();
  if (!token) {
    return {
      content: 'No GitHub token found. Set GITHUB_TOKEN or GH_TOKEN environment variable.\nYou can create a token at https://github.com/settings/tokens',
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
  description: 'GitHub operations — create PRs, list issues, check PR status, view repo info. Requires GITHUB_TOKEN env var.',
  parameters,
  execute,
};
