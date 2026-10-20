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
import { readGitHubCliToken } from '../github/gh.js';

const GITHUB_API = 'https://api.github.com';

async function getToken(signal?: AbortSignal): Promise<string | null> {
  return readGitHubCliToken(process.env, signal);
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
  owner: z.string().regex(/^[A-Za-z0-9-]+$/).describe('Repository owner (user or org)'),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/).refine(value => value !== '.' && value !== '..').describe('Repository name'),
  // PR fields
  title: z.string().optional().describe('PR or issue title'),
  body: z.string().optional().describe('PR or issue body/description'),
  head: z.string().optional().describe('PR source branch'),
  base: z.string().optional().describe('PR target branch (defaults to the repository default branch)'),
  // Issue fields
  labels: z.array(z.string()).optional().describe('Labels for issue'),
  // Filter
  state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state'),
  pr_number: z.number().optional().describe('PR number for status check'),
});

async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const signal = AbortSignal.any([...(ctx.abortSignal ? [ctx.abortSignal] : []), AbortSignal.timeout(30_000)]);
  try {
    signal.throwIfAborted();
    const token = await getToken(signal);
    signal.throwIfAborted();
    if (!token) return { content: 'GitHub is not signed in. Run notch github login or sign in from the IDE GitHub settings. You can also set GH_TOKEN.', isError: true };
    const ghFetch = async (endpoint: string, opts: RequestInit = {}): Promise<Response> => {
      signal.throwIfAborted();
      return fetch(`${GITHUB_API}${endpoint}`, { ...opts, signal, headers: {
        Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10', Authorization: `Bearer ${token}`,
      } });
    };
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
        const realIssues: any[] = [];
        let page = 1;
        let more = false;
        do {
          const res = await ghFetch(`/repos/${args.owner}/${args.repo}/issues?state=${state}&per_page=100&page=${page}`);
          if (!res.ok) return { content: `GitHub API error: ${res.status}`, isError: true };
          const rows = await res.json() as any[];
          realIssues.push(...rows.filter(issue => !issue.pull_request));
          more = /rel="next"/.test(res.headers.get('link') || '');
          page += 1;
        } while (realIssues.length < 15 && more);
        if (!realIssues.length) return { content: `No ${state} issues.` };
        more ||= realIssues.length > 15;
        const lines = realIssues.slice(0, 15).map((i: any) => {
          const labels = i.labels.map((l: any) => l.name).join(', ');
          return `#${i.number} [${i.state}] ${i.title}${labels ? ` [${labels}]` : ''} by @${i.user.login}`;
        });
        return { content: lines.join('\n') + (more ? '\nShowing the first 15 issues; more issues are available.' : '') };
      }

      case 'create_pr': {
        if (!args.title || !args.head) {
          return { content: 'title and head branch are required for create_pr', isError: true };
        }
        let base = args.base;
        if (!base) {
          const info = await ghFetch(`/repos/${args.owner}/${args.repo}`);
          if (!info.ok) return { content: `Cannot resolve the repository default branch: GitHub API error ${info.status}`, isError: true };
          const repo = await info.json() as { default_branch?: string };
          base = repo.default_branch;
          if (!base) return { content: 'The repository has no default branch. Push an initial commit first.', isError: true };
        }
        const res = await ghFetch(`/repos/${args.owner}/${args.repo}/pulls`, {
          method: 'POST',
          body: JSON.stringify({
            title: args.title,
            body: args.body ?? '',
            head: args.head,
            base,
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
    return { content: signal.aborted ? (ctx.abortSignal?.aborted ? 'GitHub request cancelled.' : 'GitHub request timed out. Try again.') : `GitHub error: ${err.message}`, isError: true };
  }
}

export const githubTool: NotchTool<typeof parameters> = {
  name: 'github',
  description: 'GitHub operations — create PRs, list issues, check PR status, view repo info. Local commit and push uses git commit_and_push. Uses the GitHub sign-in in Settings or GH_TOKEN.',
  parameters,
  execute,
};
