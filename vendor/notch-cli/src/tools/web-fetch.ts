/**
 * Notch CLI — Web Fetch Tool
 *
 * Fetches web pages and returns their text content.
 * Useful for reading documentation, API references, and web resources.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';
import { loadWebSettings } from '../web/settings.js';
import { boundedText, webContent, webUrl } from '../web/content.js';

const MAX_CONTENT_LENGTH = 50_000;
const FETCH_TIMEOUT = 15_000;

const parameters = z.object({
  url: z.string().describe('URL to fetch'),
  max_length: z.number().int().min(1).max(MAX_CONTENT_LENGTH).optional().default(MAX_CONTENT_LENGTH).describe('Max characters to return'),
});

/**
 * Strip HTML tags and extract readable text content.
 */
function htmlToText(html: string): string {
  return html
    // Remove script and style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    // Convert block elements to newlines
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|pre|hr)[^>]*>/gi, '\n')
    // Convert list items
    .replace(/<li[^>]*>/gi, '\n- ')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export const webFetchTool: NotchTool<typeof parameters> = {
  name: 'web_fetch',
  description:
    'Fetch a web page and return its text content. Useful for reading documentation, ' +
    'API references, error lookups, and other web resources. Strips HTML to plain text.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const { url } = params;
    const maxLen = params.max_length ?? MAX_CONTENT_LENGTH;

    // Basic URL validation
    try {
      webUrl(url);
    } catch {
      return { content: `Invalid URL: ${url}`, isError: true };
    }

    try {
      const settings = await (ctx.webSettings?.() ?? loadWebSettings());
      if (!settings.enabled) return { content: 'Web research is disabled. Enable it in Settings → Appearance → Web research or /settings web.', isError: true };
      const response = await fetch(url, {
        signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT), ...(ctx.abortSignal ? [ctx.abortSignal] : [])]),
        headers: {
          'User-Agent': 'Notch-CLI/0.1 (AI coding assistant)',
          'Accept': 'text/html,application/json,text/plain',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        return {
          content: `HTTP ${response.status} ${response.statusText} for ${url}`,
          isError: true,
        };
      }

      const contentType = response.headers.get('content-type') ?? '';
      const raw = await boundedText(response);

      let text: string;
      if (contentType.includes('application/json')) {
        // Pretty-print JSON
        try {
          text = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          text = raw;
        }
      } else if (contentType.includes('text/html')) {
        text = htmlToText(raw);
      } else {
        text = raw;
      }

      // Truncate if needed
      if (text.length > maxLen) {
        text = text.slice(0, maxLen) + `\n\n... (truncated, ${text.length} chars total)`;
      }

      return { content: webContent(`Fetched page (${response.status})`, response.url || url, text) };
    } catch (err: any) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return { content: `Timeout fetching ${url} (${FETCH_TIMEOUT / 1000}s limit)`, isError: true };
      }
      return { content: `Fetch error for ${url}: ${err.message}`, isError: true };
    }
  },
};
