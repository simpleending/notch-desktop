/**
 * Notch CLI — LSP Code Intelligence Tool
 *
 * Provides go-to-definition, find-references, and diagnostics (type errors)
 * using installed compilers and source-search heuristics.
 * This tool does not establish a language-server protocol session.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

const execFileAsync = promisify(execFile);

const parameters = z.object({
  action: z.enum(['definition', 'references', 'diagnostics', 'hover'])
    .describe('LSP action: definition (go-to-def), references (find usages), diagnostics (type errors), hover (type info)'),
  file: z.string().describe('File path (relative or absolute)'),
  line: z.number().int().positive().optional().describe('Line number (1-based) — required for definition, references, hover'),
  character: z.number().int().nonnegative().optional().describe('Column number (0-based) — required for definition, references, hover'),
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
async function isAvailable(cmd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(which, [cmd], { timeout: 3000, windowsHide: true, signal });
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/**
 * Use TypeScript compiler API via tsc for diagnostics.
 * Faster and more reliable than spawning the full language server.
 */
async function tsDiagnostics(filePath: string, cwd: string, signal?: AbortSignal): Promise<string> {
  let compiler: string;
  try { compiler = createRequire(path.join(cwd, 'package.json')).resolve('typescript/bin/tsc'); }
  catch { throw new Error('TypeScript is not installed in this project. Install its development dependencies before checking diagnostics.'); }
  const project = await fs.stat(path.join(cwd, 'tsconfig.json')).then(s => s.isFile(), error => { if (error.code === 'ENOENT') return false; throw error; });
  try {
    // Run the installed compiler directly; npx.cmd cannot be execFile'd on Windows.
    const { stdout: result } = await execFileAsync(process.execPath, [compiler, '--noEmit', '--pretty', 'false', ...(project ? ['--project', cwd] : [filePath])], {
      cwd, encoding: 'utf-8', windowsHide: true, signal, timeout: 30_000, maxBuffer: 5 * 1024 ** 2,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    return result.trim() || 'No type errors found.';
  } catch (err: any) {
    signal?.throwIfAborted();
    const output = err.stdout || err.stderr || '';
    if (typeof err.code === 'number' && !err.signal && output.includes('error TS')) {
      // Parse and format errors
      const lines = output.split('\n').filter((l: string) => l.includes('error TS'));
      return lines.slice(0, 20).join('\n') || 'No type errors found.';
    }
    throw err;
  }
}

/**
 * Find definition using grep-based heuristic.
 * Looks for class/function/const/let/var/type/interface/export declarations.
 */
async function findDefinition(symbol: string, cwd: string, signal?: AbortSignal, ripgrep = 'rg'): Promise<string> {
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
    const { stdout: result } = await execFileAsync(ripgrep, [
      '--no-require-git', '--no-heading', '--line-number',
      '-e', combinedPattern,
      '--type-add', 'code:*.{ts,tsx,js,jsx,py,go,rs}',
      '--type', 'code',
      '-m', '10',
      '.',
    ], { cwd, encoding: 'utf-8', windowsHide: true, signal, timeout: 10_000, maxBuffer: 1024 * 1024 });
    return result.trim() || `No definition found for "${symbol}"`;
  } catch (error: any) {
    signal?.throwIfAborted();
    if (error.code === 1) return `No definition found for "${symbol}"`;
    if (error.code !== 'ENOENT') throw error;
    // Fallback without ripgrep
    try {
      const { stdout: result } = await execFileAsync('grep', [
        '-rn', '-E', combinedPattern,
        '--include=*.ts', '--include=*.tsx', '--include=*.js',
        '--include=*.py', '--include=*.go', '--include=*.rs',
        '.',
      ], { cwd, encoding: 'utf-8', windowsHide: true, signal, timeout: 10_000, maxBuffer: 1024 * 1024 });
      const lines = result.trim().split('\n').slice(0, 10).join('\n');
      return lines || `No definition found for "${symbol}"`;
    } catch (error: any) {
      signal?.throwIfAborted();
      if (error.code !== 1) throw error;
      return `No definition found for "${symbol}"`;
    }
  }
}

/**
 * Find references using grep-based heuristic.
 */
async function findReferences(symbol: string, cwd: string, signal?: AbortSignal, ripgrep = 'rg'): Promise<string> {
  // Validate symbol to prevent injection — only allow valid identifiers
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(symbol)) {
    return `Invalid symbol name: "${symbol}"`;
  }

  try {
    const { stdout: result } = await execFileAsync(ripgrep, [
      '--no-require-git', '--no-heading', '--line-number',
      '-w', symbol,
      '--type-add', 'code:*.{ts,tsx,js,jsx,py,go,rs}',
      '--type', 'code',
      '-m', '30',
      '.',
    ], { cwd, encoding: 'utf-8', windowsHide: true, signal, timeout: 10_000, maxBuffer: 1024 * 1024 });
    const lines = result.trim().split('\n');
    return `Found ${lines.length} reference(s) for "${symbol}":\n\n${lines.join('\n')}`;
  } catch (error: any) {
    signal?.throwIfAborted();
    if (error.code === 1) return `No references found for "${symbol}"`;
    if (error.code !== 'ENOENT') throw error;
    try {
      const { stdout: result } = await execFileAsync('grep', [
        '-rn', '-w', symbol,
        '--include=*.ts', '--include=*.tsx', '--include=*.js',
        '--include=*.py', '--include=*.go', '--include=*.rs',
        '.',
      ], { cwd, encoding: 'utf-8', windowsHide: true, signal, timeout: 10_000, maxBuffer: 1024 * 1024 });
      const lines = result.trim().split('\n').slice(0, 30);
      return `Found ${lines.length} reference(s) for "${symbol}":\n\n${lines.join('\n')}`;
    } catch (error: any) {
      signal?.throwIfAborted();
      if (error.code !== 1) throw error;
      return `No references found for "${symbol}"`;
    }
  }
}

/**
 * Get hover/type info using grep + context.
 */
async function getHoverInfo(symbol: string, filePath: string, line: number, cwd: string, signal?: AbortSignal, ripgrep = 'rg'): Promise<string> {
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
    const def = await findDefinition(symbol, cwd, signal, ripgrep);

    return `## Context at ${filePath}:${line}\n\`\`\`\n${context}\n\`\`\`\n\n## Definition\n${def}`;
  } catch (err: any) {
    signal?.throwIfAborted();
    return `Could not get hover info: ${err.message}`;
  }
}

/**
 * Get diagnostics using language-specific tools.
 */
async function getDiagnostics(filePath: string, cwd: string, signal?: AbortSignal): Promise<string> {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const { lang } = detectLanguage(absPath);

  switch (lang) {
    case 'typescript':
      return tsDiagnostics(absPath, cwd, signal);

    case 'python': {
      if (await isAvailable('pyright', signal)) {
        try {
          const { stdout: result } = await execFileAsync('pyright', [absPath], {
            cwd, encoding: 'utf-8', windowsHide: true, signal, timeout: 30_000,
          });
          return result.trim() || 'No errors found.';
        } catch (err: any) {
          signal?.throwIfAborted();
          if (typeof err.code !== 'number' || err.signal) throw err;
          return err.stdout || err.stderr || 'Pyright check failed.';
        }
      }
      // Fall back to python -m py_compile
      try {
        await execFileAsync('python', ['-m', 'py_compile', absPath], {
          cwd, encoding: 'utf-8', windowsHide: true, signal, timeout: 10_000,
        });
        return 'No syntax errors found.';
      } catch (err: any) {
        signal?.throwIfAborted();
        if (typeof err.code !== 'number' || err.signal) throw err;
        return err.stderr || err.stdout || 'Syntax check failed.';
      }
    }

    case 'go': {
      try {
        const { stdout: result } = await execFileAsync('go', ['vet', absPath], {
          cwd, encoding: 'utf-8', windowsHide: true, signal, timeout: 15_000,
        });
        return result.trim() || 'No issues found.';
      } catch (err: any) {
        signal?.throwIfAborted();
        if (typeof err.code !== 'number' || err.signal) throw err;
        return err.stderr || err.stdout || 'Go vet failed.';
      }
    }

    case 'rust': {
      try {
        const { stdout: result } = await execFileAsync('cargo', ['check', '--message-format', 'short'], {
          cwd, encoding: 'utf-8', windowsHide: true, signal, timeout: 60_000,
        });
        const lines = result.trim().split('\n').slice(0, 30).join('\n');
        return lines || 'No issues found.';
      } catch (err: any) {
        signal?.throwIfAborted();
        if (typeof err.code !== 'number' || err.signal) throw err;
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
    'Uses installed compilers and grep-based heuristics, not a persistent language server. ' +
    'Actions: definition (go-to-def), references (find usages), diagnostics (type errors), hover (type info). ' +
    'Provide either line/character position or a symbol name.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const filePath = params.file;
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);

    try {
      ctx.abortSignal?.throwIfAborted();
      switch (params.action) {
        case 'definition': {
          const symbol = params.symbol || await extractSymbol(absPath, params.line, params.character);
          if (!symbol) {
            return { content: 'Provide a symbol name or line/character position.', isError: true };
          }
          const result = await findDefinition(symbol, ctx.cwd, ctx.abortSignal, ctx.ripgrepPath);
          return { content: result };
        }

        case 'references': {
          const symbol = params.symbol || await extractSymbol(absPath, params.line, params.character);
          if (!symbol) {
            return { content: 'Provide a symbol name or line/character position.', isError: true };
          }
          const result = await findReferences(symbol, ctx.cwd, ctx.abortSignal, ctx.ripgrepPath);
          return { content: result };
        }

        case 'diagnostics': {
          const result = await getDiagnostics(filePath, ctx.cwd, ctx.abortSignal);
          return { content: result };
        }

        case 'hover': {
          const symbol = params.symbol || await extractSymbol(absPath, params.line, params.character);
          if (!symbol) {
            return { content: 'Provide a symbol name or line/character position.', isError: true };
          }
          const result = await getHoverInfo(symbol, filePath, params.line ?? 1, ctx.cwd, ctx.abortSignal, ctx.ripgrepPath);
          return { content: result };
        }

        default:
          return { content: `Unknown action: ${params.action}`, isError: true };
      }
    } catch (err: any) {
      return { content: ctx.abortSignal?.aborted ? 'Code intelligence cancelled.' : `LSP error: ${err.message}`, isError: true };
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
