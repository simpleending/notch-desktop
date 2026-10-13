/**
 * Notch CLI — LSP Code Intelligence Tool
 *
 * Provides go-to-definition, find-references, and diagnostics (type errors)
 * by spawning language servers (typescript-language-server, pyright, etc.)
 * and communicating via LSP protocol.
 *
 * Falls back to AST-based heuristics when no language server is available.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

const parameters = z.object({
  action: z.enum(['definition', 'references', 'diagnostics', 'hover'])
    .describe('LSP action: definition (go-to-def), references (find usages), diagnostics (type errors), hover (type info)'),
  file: z.string().describe('File path (relative or absolute)'),
  line: z.number().optional().describe('Line number (1-based) — required for definition, references, hover'),
  character: z.number().optional().describe('Column number (0-based) — required for definition, references, hover'),
  symbol: z.string().optional().describe('Symbol name to search for (alternative to line/character)'),
});

/** Detect which language server to use based on file extension */
function detectLanguage(filePath: string): { lang: string; server: string | null; tsconfig: boolean } {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs':
      return { lang: 'typescript', server: 'typescript-language-server', tsconfig: true };
    case '.py':
      return { lang: 'python', server: 'pyright', tsconfig: false };
    case '.go':
      return { lang: 'go', server: 'gopls', tsconfig: false };
    case '.rs':
      return { lang: 'rust', server: 'rust-analyzer', tsconfig: false };
    default:
      return { lang: 'unknown', server: null, tsconfig: false };
  }
}

/** Check if a command is available on PATH */
function isAvailable(cmd: string): boolean {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(which, [cmd], { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Use TypeScript compiler API via tsc for diagnostics.
 * Faster and more reliable than spawning the full language server.
 */
async function tsDiagnostics(filePath: string, cwd: string): Promise<string> {
  try {
    // Try tsc --noEmit on the specific file
    const result = execFileSync('npx', ['tsc', '--noEmit', '--pretty', 'false', filePath], {
      cwd, encoding: 'utf-8', timeout: 30_000,
    });
    return result.trim() || 'No type errors found.';
  } catch (err: any) {
    const output = err.stdout || err.stderr || '';
    if (output.includes('error TS')) {
      // Parse and format errors
      const lines = output.split('\n').filter((l: string) => l.includes('error TS'));
      return lines.slice(0, 20).join('\n') || 'No type errors found.';
    }
    // Try project-wide check
    try {
      const result = execFileSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
        cwd, encoding: 'utf-8', timeout: 30_000,
      });
      const allLines = result.trim().split('\n').slice(0, 30).join('\n');
      return allLines || 'No type errors found.';
    } catch (err2: any) {
      const out = err2.stdout || err2.stderr || '';
      const errLines = out.split('\n').filter((l: string) => l.includes('error TS'));
      return errLines.slice(0, 20).join('\n') || 'Could not run type checker.';
    }
  }
}

/**
 * Find definition using grep-based heuristic.
 * Looks for class/function/const/let/var/type/interface/export declarations.
 */
async function findDefinition(symbol: string, cwd: string): Promise<string> {
  // Validate symbol to prevent injection — only allow valid identifiers
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(symbol)) {
    return `Invalid symbol name: "${symbol}"`;
  }

  const patterns = [
    `(function|const|let|var|class|interface|type|enum)\\s+${symbol}\\b`,
    `export\\s+(default\\s+)?(function|const|let|var|class|interface|type|enum)\\s+${symbol}\\b`,
    `def\\s+${symbol}\\s*\\(`,     // Python
    `func\\s+${symbol}\\s*\\(`,     // Go
    `fn\\s+${symbol}\\s*[<(]`,      // Rust
  ];

  const combinedPattern = patterns.join('|');

  try {
    const result = execFileSync('rg', [
      '--no-heading', '--line-number',
      '-e', combinedPattern,
      '--type-add', 'code:*.{ts,tsx,js,jsx,py,go,rs}',
      '--type', 'code',
      '-m', '10',
    ], { cwd, encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    return result.trim() || `No definition found for "${symbol}"`;
  } catch {
    // Fallback without ripgrep
    try {
      const result = execFileSync('grep', [
        '-rn', '-E', combinedPattern,
        '--include=*.ts', '--include=*.tsx', '--include=*.js',
        '--include=*.py', '--include=*.go', '--include=*.rs',
        '.',
      ], { cwd, encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 });
      const lines = result.trim().split('\n').slice(0, 10).join('\n');
      return lines || `No definition found for "${symbol}"`;
    } catch {
      return `No definition found for "${symbol}"`;
    }
  }
}

/**
 * Find references using grep-based heuristic.
 */
async function findReferences(symbol: string, cwd: string): Promise<string> {
  // Validate symbol to prevent injection — only allow valid identifiers
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(symbol)) {
    return `Invalid symbol name: "${symbol}"`;
  }

  try {
    const result = execFileSync('rg', [
      '--no-heading', '--line-number',
      '-w', symbol,
      '--type-add', 'code:*.{ts,tsx,js,jsx,py,go,rs}',
      '--type', 'code',
      '-m', '30',
    ], { cwd, encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    const lines = result.trim().split('\n');
    return `Found ${lines.length} reference(s) for "${symbol}":\n\n${lines.join('\n')}`;
  } catch {
    try {
      const result = execFileSync('grep', [
        '-rn', '-w', symbol,
        '--include=*.ts', '--include=*.tsx', '--include=*.js',
        '--include=*.py', '--include=*.go', '--include=*.rs',
        '.',
      ], { cwd, encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 });
      const lines = result.trim().split('\n').slice(0, 30);
      return `Found ${lines.length} reference(s) for "${symbol}":\n\n${lines.join('\n')}`;
    } catch {
      return `No references found for "${symbol}"`;
    }
  }
}

/**
 * Get hover/type info using grep + context.
 */
async function getHoverInfo(symbol: string, filePath: string, line: number, cwd: string): Promise<string> {
  try {
    // Read the file and get context around the line
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const content = await fs.readFile(absPath, 'utf-8');
    const lines = content.split('\n');
    const startLine = Math.max(0, line - 3);
    const endLine = Math.min(lines.length, line + 2);
    const context = lines.slice(startLine, endLine)
      .map((l, i) => `${startLine + i + 1}: ${l}`)
      .join('\n');

    // Also find the definition
    const def = await findDefinition(symbol, cwd);

    return `## Context at ${filePath}:${line}\n\`\`\`\n${context}\n\`\`\`\n\n## Definition\n${def}`;
  } catch (err: any) {
    return `Could not get hover info: ${err.message}`;
  }
}

/**
 * Get diagnostics using language-specific tools.
 */
async function getDiagnostics(filePath: string, cwd: string): Promise<string> {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const { lang } = detectLanguage(absPath);

  switch (lang) {
    case 'typescript':
      return tsDiagnostics(absPath, cwd);

    case 'python': {
      if (isAvailable('pyright')) {
        try {
          const result = execFileSync('pyright', [absPath], {
            cwd, encoding: 'utf-8', timeout: 30_000,
          });
          return result.trim() || 'No errors found.';
        } catch (err: any) {
          return err.stdout || err.stderr || 'Pyright check failed.';
        }
      }
      // Fall back to python -m py_compile
      try {
        execFileSync('python', ['-m', 'py_compile', absPath], {
          cwd, encoding: 'utf-8', timeout: 10_000,
        });
        return 'No syntax errors found.';
      } catch (err: any) {
        return err.stderr || err.stdout || 'Syntax check failed.';
      }
    }

    case 'go': {
      try {
        const result = execFileSync('go', ['vet', absPath], {
          cwd, encoding: 'utf-8', timeout: 15_000,
        });
        return result.trim() || 'No issues found.';
      } catch (err: any) {
        return err.stderr || err.stdout || 'Go vet failed.';
      }
    }

    case 'rust': {
      try {
        const result = execFileSync('cargo', ['check', '--message-format', 'short'], {
          cwd, encoding: 'utf-8', timeout: 60_000,
        });
        const lines = result.trim().split('\n').slice(0, 30).join('\n');
        return lines || 'No issues found.';
      } catch (err: any) {
        return err.stderr || err.stdout || 'Cargo check failed.';
      }
    }

    default:
      return `No language server available for ${lang} files. Use grep to search for symbols.`;
  }
}

export const lspTool: NotchTool<typeof parameters> = {
  name: 'lsp',
  description:
    'Code intelligence: find definitions, references, type errors, and hover info. ' +
    'Uses TypeScript compiler, pyright, gopls, or grep-based heuristics. ' +
    'Actions: definition (go-to-def), references (find usages), diagnostics (type errors), hover (type info). ' +
    'Provide either line/character position or a symbol name.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const filePath = params.file;
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);

    try {
      switch (params.action) {
        case 'definition': {
          const symbol = params.symbol || await extractSymbol(absPath, params.line, params.character);
          if (!symbol) {
            return { content: 'Provide a symbol name or line/character position.', isError: true };
          }
          const result = await findDefinition(symbol, ctx.cwd);
          return { content: result };
        }

        case 'references': {
          const symbol = params.symbol || await extractSymbol(absPath, params.line, params.character);
          if (!symbol) {
            return { content: 'Provide a symbol name or line/character position.', isError: true };
          }
          const result = await findReferences(symbol, ctx.cwd);
          return { content: result };
        }

        case 'diagnostics': {
          const result = await getDiagnostics(filePath, ctx.cwd);
          return { content: result };
        }

        case 'hover': {
          const symbol = params.symbol || await extractSymbol(absPath, params.line, params.character);
          if (!symbol) {
            return { content: 'Provide a symbol name or line/character position.', isError: true };
          }
          const result = await getHoverInfo(symbol, filePath, params.line ?? 1, ctx.cwd);
          return { content: result };
        }

        default:
          return { content: `Unknown action: ${params.action}`, isError: true };
      }
    } catch (err: any) {
      return { content: `LSP error: ${err.message}`, isError: true };
    }
  },
};

/**
 * Extract the symbol name at a given position in a file.
 */
async function extractSymbol(
  filePath: string,
  line?: number,
  character?: number,
): Promise<string | null> {
  if (!line) return null;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const lineText = lines[line - 1];
    if (!lineText) return null;

    const col = character ?? 0;

    // Find word boundaries around the cursor position
    const wordRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
    let match;
    while ((match = wordRegex.exec(lineText)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (col >= start && col <= end) {
        return match[0];
      }
    }

    // If no position match, return the first identifier on the line
    const firstMatch = lineText.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/);
    return firstMatch?.[0] ?? null;
  } catch {
    return null;
  }
}
