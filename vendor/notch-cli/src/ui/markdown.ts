/**
 * Notch CLI — Markdown Renderer
 *
 * Renders markdown to styled terminal output. Theme-aware.
 * Lightweight alternative to marked-terminal — no extra dependencies.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { theme } from './themes.js';

/**
 * Render markdown string to terminal-styled output.
 * Handles: headers, bold, italic, code blocks, inline code, lists, links, horizontal rules.
 */
export function renderMarkdown(text: string): string {
  const t = theme();
  const lines = text.split('\n');
  const output: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeLines: string[] = [];

  for (const line of lines) {
    // Code block boundaries
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        const border = t.border('  ' + '\u2500'.repeat(60));
        if (codeBlockLang) {
          output.push(t.border(`  \u250c\u2500 ${codeBlockLang} ` + '\u2500'.repeat(Math.max(0, 56 - codeBlockLang.length))));
        } else {
          output.push(border);
        }
        for (const cl of codeLines) {
          output.push(t.mdCode(`  \u2502 ${cl}`));
        }
        output.push(border);
        inCodeBlock = false;
        codeLines = [];
        codeBlockLang = '';
      } else {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      output.push(t.border('\u2500'.repeat(60)));
      continue;
    }

    // Headers
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      output.push('');
      output.push(t.mdH1(h1[1]!));
      output.push(t.border('\u2500'.repeat(h1[1]!.length)));
      continue;
    }

    const h2 = line.match(/^## (.+)/);
    if (h2) {
      output.push('');
      output.push(t.mdH2(h2[1]!));
      continue;
    }

    const h3 = line.match(/^### (.+)/);
    if (h3) {
      output.push(t.mdH3(h3[1]!));
      continue;
    }

    const h4 = line.match(/^#{4,} (.+)/);
    if (h4) {
      output.push(t.bold(h4[1]!));
      continue;
    }

    // Unordered list
    const ul = line.match(/^(\s*)[*-] (.+)/);
    if (ul) {
      const indent = ul[1]!;
      const content = renderInline(ul[2]!);
      output.push(`${indent}  \u2022 ${content}`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^(\s*)\d+\. (.+)/);
    if (ol) {
      const indent = ol[1]!;
      const content = renderInline(ol[2]!);
      const num = line.match(/^(\s*)(\d+)\./)?.[2] ?? '1';
      output.push(`${indent}  ${t.dim(num + '.')} ${content}`);
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const content = renderInline(line.replace(/^>\s?/, ''));
      output.push(t.border(`  \u2502 `) + chalk.italic(content));
      continue;
    }

    // Regular line
    output.push(renderInline(line));
  }

  // Handle unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    for (const cl of codeLines) {
      output.push(t.mdCode(`  ${cl}`));
    }
  }

  return output.join('\n');
}

/**
 * Apply inline markdown formatting to a line.
 */
function renderInline(text: string): string {
  const t = theme();
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, chalk.bold.italic('$1'))
    .replace(/\*\*(.+?)\*\*/g, chalk.bold('$1'))
    .replace(/__(.+?)__/g, chalk.bold('$1'))
    .replace(/\*(.+?)\*/g, chalk.italic('$1'))
    .replace(/_(.+?)_/g, chalk.italic('$1'))
    .replace(/~~(.+?)~~/g, chalk.strikethrough('$1'))
    .replace(/`([^`]+)`/g, (_m, code: string) => t.mdInlineCode(` ${code} `))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
      `${t.mdLink(label)} ${t.dim(`(${url})`)}`
    );
}

/**
 * Stream-friendly markdown: apply inline formatting to a text chunk.
 */
export function renderInlineChunk(text: string): string {
  return renderInline(text);
}
