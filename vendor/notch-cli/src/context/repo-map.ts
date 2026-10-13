/**
 * Notch CLI — Repository Map
 *
 * Builds a lightweight structural index of the codebase. Extracts function signatures,
 * class definitions, exports, and import relationships to give the
 * model structural awareness without sending full file contents.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';

export interface RepoMapEntry {
  path: string;
  /** Top-level exports, function signatures, class names */
  symbols: string[];
  /** Imports from other project files */
  imports: string[];
  /** File size in lines */
  lines: number;
}

export interface RepoMap {
  root: string;
  entries: RepoMapEntry[];
  /** Human-readable summary for injection into system prompt */
  summary: string;
}

// Regex patterns for extracting symbols from different languages
const PATTERNS: Record<string, RegExp[]> = {
  ts: [
    /^export\s+(default\s+)?(async\s+)?function\s+(\w+)/gm,
    /^export\s+(default\s+)?class\s+(\w+)/gm,
    /^export\s+(const|let|var)\s+(\w+)/gm,
    /^export\s+(default\s+)?interface\s+(\w+)/gm,
    /^export\s+(default\s+)?type\s+(\w+)/gm,
    /^export\s+(default\s+)?enum\s+(\w+)/gm,
  ],
  js: [
    /^export\s+(default\s+)?(async\s+)?function\s+(\w+)/gm,
    /^export\s+(default\s+)?class\s+(\w+)/gm,
    /^export\s+(const|let|var)\s+(\w+)/gm,
    /^module\.exports\s*=\s*{([^}]+)}/gm,
  ],
  py: [
    /^def\s+(\w+)\s*\(/gm,
    /^class\s+(\w+)/gm,
    /^(\w+)\s*=\s*/gm,
  ],
  rs: [
    /^pub\s+(async\s+)?fn\s+(\w+)/gm,
    /^pub\s+struct\s+(\w+)/gm,
    /^pub\s+enum\s+(\w+)/gm,
    /^pub\s+trait\s+(\w+)/gm,
  ],
};

const IMPORT_PATTERN = /(?:import|from)\s+['"]([^'"]+)['"]/g;

function getPatterns(filePath: string): RegExp[] {
  const ext = path.extname(filePath).slice(1);
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return PATTERNS.ts!;
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return PATTERNS.js!;
  if (ext === 'py') return PATTERNS.py!;
  if (ext === 'rs') return PATTERNS.rs!;
  return [];
}

function extractSymbols(content: string, patterns: RegExp[]): string[] {
  const symbols: string[] = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(content)) !== null) {
      // Get the last capture group (the symbol name)
      const name = match[match.length - 1];
      if (name && name.length < 100) {
        symbols.push(name.trim());
      }
    }
  }
  return [...new Set(symbols)];
}

function extractImports(content: string, projectRoot: string, filePath: string): string[] {
  const imports: string[] = [];
  const re = new RegExp(IMPORT_PATTERN.source, IMPORT_PATTERN.flags);
  let match;
  while ((match = re.exec(content)) !== null) {
    const importPath = match[1]!;
    // Only include project-local imports (starting with . or not a package)
    if (importPath.startsWith('.') || importPath.startsWith('/')) {
      imports.push(importPath);
    }
  }
  return imports;
}

/**
 * Build a repo map for the given directory.
 * Scans source files and extracts structural information.
 */
export async function buildRepoMap(root: string): Promise<RepoMap> {
  const files = await glob('**/*.{ts,tsx,js,jsx,mjs,py,rs}', {
    cwd: root,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/.next/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/__pycache__/**',
      '**/target/**',
      '**/.venv/**',
      '**/venv/**',
      '**/*.test.*',
      '**/*.spec.*',
      '**/*.d.ts',
      '**/*.config.*',       // vite.config, tailwind.config, etc.
      '**/*.setup.*',        // vitest.setup, jest.setup
      '**/postcss.config.*',
      '**/tsconfig.*',
      '**/.eslintrc.*',
      '**/.prettierrc.*',
      '**/env.d.ts',
      '**/vite-env.d.ts',
      '**/global.d.ts',
      '**/globals.d.ts',
      '**/next-env.d.ts',
      '**/migrations/**',
      '**/generated/**',
      '**/*.min.*',
      '**/vendor/**',
      '**/public/**',
      '**/coverage/**',
      '**/.cache/**',
      '**/lock.*',
      '**/*-lock.*',
    ],
    nodir: true,
  });

  const entries: RepoMapEntry[] = [];

  // Sort by path depth (shallower files first — more likely to be important)
  files.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  for (const file of files.slice(0, 300)) { // Cap at 300 files for performance
    const fullPath = path.resolve(root, file);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n').length;
      const patterns = getPatterns(file);
      const symbols = extractSymbols(content, patterns);
      const imports = extractImports(content, root, file);

      if (symbols.length > 0 || imports.length > 0) {
        entries.push({ path: file, symbols, imports, lines });
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Build summary
  const summaryLines = entries.map((e) => {
    const syms = e.symbols.length > 0 ? `: ${e.symbols.join(', ')}` : '';
    return `  ${e.path} (${e.lines}L)${syms}`;
  });

  const summary = [
    `Repository structure (${entries.length} source files):`,
    ...summaryLines,
  ].join('\n');

  return { root, entries, summary };
}

/**
 * Generate a condensed repo map suitable for inclusion in a system prompt.
 * Keeps it under a target token budget.
 */
export function condensedRepoMap(map: RepoMap, maxChars: number = 8000): string {
  if (map.summary.length <= maxChars) return map.summary;

  // Truncate by dropping symbols from less important files
  const lines = [`Repository structure (${map.entries.length} source files):`];
  let charCount = lines[0]!.length;

  for (const entry of map.entries) {
    const line = `  ${entry.path} (${entry.lines}L)`;
    if (charCount + line.length + 1 > maxChars) {
      lines.push(`  ... and ${map.entries.length - lines.length + 1} more files`);
      break;
    }
    lines.push(line);
    charCount += line.length + 1;
  }

  return lines.join('\n');
}
