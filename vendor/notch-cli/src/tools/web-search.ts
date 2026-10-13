/**
 * Notch CLI — Web Search Tool
 *
 * Performs a web search via the Tavily Search API and returns ranked results
 * as Markdown. Complements `web_fetch` (which retrieves a known URL) by letting
 * the agent discover URLs and synthesized answers from a natural-language query.
 *
 * Requires `TAVILY_API_KEY` in the environment. Get a free key at
 * https://tavily.com/. See https://docs.tavily.com/api-reference/endpoint/search
 * for the upstream API contract.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT = 30_000;
const MAX_TOTAL_CONTENT = 8 * 1024; // 8 KB
const SNIPPET_CHARS = 240;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 20;

const parameters = z.object({
  query: z.string().min(1).describe('The search query (a natural-language question or keywords).'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS)
    .optional()
    .default(DEFAULT_RESULTS)
    .describe(`Maximum number of results to return (1-${MAX_RESULTS}, default ${DEFAULT_RESULTS}).`),
  search_depth: z
    .enum(['basic', 'advanced'])
    .optional()
    .default('basic')
    .describe('Search depth. "advanced" is slower but higher quality; "basic" is faster.'),
  include_domains: z
    .array(z.string())
    .optional()
    .describe('If set, restrict results to these domains (e.g. ["docs.python.org"]).'),
  exclude_domains: z
    .array(z.string())
    .optional()
    .describe('If set, omit results from these domains.'),
});

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
  query?: string;
}

function snippet(text: string | undefined, n: number): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= n) return clean;
  return clean.slice(0, n).trimEnd() + '...';
}

export const webSearchTool: NotchTool<typeof parameters> = {
  name: 'web_search',
  description:
    'Search the web via Tavily and return ranked results with titles, URLs, and snippets. ' +
    'Use this to discover relevant pages, find current information, or answer factual questions. ' +
    'Pair with `web_fetch` to read full page contents. Requires TAVILY_API_KEY.',
  parameters,
  async execute(params, _ctx): Promise<ToolResult> {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return {
        content:
          'Web search unavailable: TAVILY_API_KEY not set. Get a free key at https://tavily.com/.',
        isError: true,
      };
    }

    const {
      query,
      max_results = DEFAULT_RESULTS,
      search_depth = 'basic',
      include_domains,
      exclude_domains,
    } = params;

    const body: Record<string, unknown> = {
      api_key: apiKey,
      query,
      max_results,
      search_depth,
      include_answer: true,
      include_raw_content: false,
    };
    if (include_domains && include_domains.length > 0) {
      body.include_domains = include_domains;
    }
    if (exclude_domains && exclude_domains.length > 0) {
      body.exclude_domains = exclude_domains;
    }

    let response: Response;
    try {
      response = await globalThis.fetch(TAVILY_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Notch-CLI/0.1 (AI coding assistant)',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT),
      });
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        return {
          content: `Web search timed out after ${SEARCH_TIMEOUT / 1000}s (query: "${query}").`,
          isError: true,
        };
      }
      return {
        content: `Web search failed: ${e.message ?? String(err)}`,
        isError: true,
      };
    }

    if (!response.ok) {
      let bodySnippet = '';
      try {
        bodySnippet = (await response.text()).slice(0, 500);
      } catch {
        // ignore
      }
      return {
        content:
          `Web search failed: HTTP ${response.status} ${response.statusText}` +
          (bodySnippet ? `\n${bodySnippet}` : ''),
        isError: true,
      };
    }

    let data: TavilyResponse;
    try {
      data = (await response.json()) as TavilyResponse;
    } catch (err: unknown) {
      const e = err as { message?: string };
      return {
        content: `Web search returned invalid JSON: ${e.message ?? String(err)}`,
        isError: true,
      };
    }

    const results = data.results ?? [];
    if (results.length === 0) {
      const answerLine = data.answer ? `Answer: ${data.answer}\n\n` : '';
      return { content: `${answerLine}No results for "${query}".` };
    }

    const lines: string[] = [`Web search results for "${query}":`, ''];
    if (data.answer) {
      lines.push(`Answer: ${data.answer}`);
      lines.push('');
    }

    results.forEach((r, i) => {
      const idx = i + 1;
      const title = r.title?.trim() || '(untitled)';
      const url = r.url?.trim() || '(no url)';
      const snip = snippet(r.content, SNIPPET_CHARS);
      lines.push(`**[${idx}]** ${title} — ${url}`);
      if (snip) {
        lines.push(`  > ${snip}`);
      }
    });

    let out = lines.join('\n');
    if (out.length > MAX_TOTAL_CONTENT) {
      out =
        out.slice(0, MAX_TOTAL_CONTENT) +
        `\n\n... (truncated, ${out.length} chars total)`;
    }

    return { content: out };
  },
};
