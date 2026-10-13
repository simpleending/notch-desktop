/**
 * Notch CLI — Read Tool
 *
 * Reads file contents with line numbers. Supports offset/limit for large files.
 * Handles images (returns base64 metadata) and PDFs (basic text extraction).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const BINARY_EXTENSIONS = new Set(['.pdf', '.zip', '.tar', '.gz', '.wasm', '.exe', '.dll', '.so', '.dylib']);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB limit for text files
const MAX_LINES = 2000;

const parameters = z.object({
  path: z.string().describe('Relative or absolute path to the file to read'),
  offset: z.number().optional().describe('Line number to start reading from (1-based)'),
  limit: z.number().optional().describe('Maximum number of lines to read'),
});

/**
 * Read an image file — returns metadata and base64 data URI.
 */
async function readImage(filePath: string, ext: string): Promise<ToolResult> {
  try {
    const stat = await fs.stat(filePath);
    const buf = await fs.readFile(filePath);
    const mimeType = ext === '.svg' ? 'image/svg+xml'
      : ext === '.png' ? 'image/png'
      : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp'
      : ext === '.bmp' ? 'image/bmp'
      : ext === '.ico' ? 'image/x-icon'
      : 'image/jpeg';

    // For SVGs, return the text content directly
    if (ext === '.svg') {
      const svgText = buf.toString('utf-8');
      return {
        content: `Image: ${filePath} (${(stat.size / 1024).toFixed(1)} KB, SVG)\n\n${svgText.slice(0, 10_000)}`,
      };
    }

    const base64 = buf.toString('base64');
    return {
      content: `Image: ${filePath} (${(stat.size / 1024).toFixed(1)} KB, ${ext})\ndata:${mimeType};base64,${base64.slice(0, 200)}... [${base64.length} chars total]\n\n(Image data is available. Describe what changes to make if needed.)`,
    };
  } catch (err: any) {
    return { content: `Error reading image ${filePath}: ${err.message}`, isError: true };
  }
}

/**
 * Read a PDF file — extracts text line by line.
 * Uses a simple heuristic text extraction since we avoid heavy dependencies.
 */
async function readPDF(filePath: string): Promise<ToolResult> {
  try {
    const stat = await fs.stat(filePath);
    const buf = await fs.readFile(filePath);

    // Simple PDF text extraction — look for text between stream markers
    const text = buf.toString('latin1');
    const textChunks: string[] = [];

    // Extract text from PDF streams (basic approach)
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;
    while ((match = streamRegex.exec(text)) !== null) {
      // Extract readable ASCII from stream content
      const chunk = match[1]!
        .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (chunk.length > 10) {
        textChunks.push(chunk);
      }
    }

    // Also try to extract text operators (Tj, TJ)
    const tjRegex = /\(((?:[^)\\]|\\.)*)\)\s*Tj/g;
    while ((match = tjRegex.exec(text)) !== null) {
      const decoded = match[1]!.replace(/\\(.)/g, '$1');
      if (decoded.trim().length > 0) {
        textChunks.push(decoded.trim());
      }
    }

    if (textChunks.length === 0) {
      return {
        content: `PDF: ${filePath} (${(stat.size / 1024).toFixed(1)} KB)\n\n(Could not extract text — the PDF may be image-based or encrypted. Consider using an external tool for OCR.)`,
      };
    }

    const extractedText = textChunks.join('\n').slice(0, 50_000);
    return {
      content: `PDF: ${filePath} (${(stat.size / 1024).toFixed(1)} KB)\n\nExtracted text:\n${extractedText}`,
    };
  } catch (err: any) {
    return { content: `Error reading PDF ${filePath}: ${err.message}`, isError: true };
  }
}

export const readTool: NotchTool<typeof parameters> = {
  name: 'read',
  description:
    'Read file contents with line numbers. Use offset/limit for large files. ' +
    'Supports text files, images (returns metadata + base64), and PDFs (basic text extraction). ' +
    'Returns numbered lines like "  1\\tline content".',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const filePath = path.isAbsolute(params.path)
      ? params.path
      : path.resolve(ctx.cwd, params.path);

    const ext = path.extname(filePath).toLowerCase();

    try {
      // Check file exists
      await fs.access(filePath);

      // Image files — return metadata
      if (IMAGE_EXTENSIONS.has(ext)) {
        return await readImage(filePath, ext);
      }

      // PDF files — basic text extraction
      if (ext === '.pdf') {
        return await readPDF(filePath);
      }

      // Other known binary — just report metadata
      if (BINARY_EXTENSIONS.has(ext)) {
        const stat = await fs.stat(filePath);
        return {
          content: `Binary file: ${filePath} (${(stat.size / 1024).toFixed(1)} KB, ${ext})`,
        };
      }

      // Check file size before reading
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        return {
          content: `File too large: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)} MB). Use offset/limit to read portions.`,
          isError: true,
        };
      }

      // Check read cache
      const cacheKey = `${filePath}:${params.offset ?? 0}:${params.limit ?? 0}`;
      if (ctx._readCache?.has(cacheKey)) {
        return { content: ctx._readCache.get(cacheKey)! };
      }

      // Text files — standard read with line numbers
      const raw = await fs.readFile(filePath, 'utf-8');
      const allLines = raw.split('\n');
      const offset = Math.max(0, (params.offset ?? 1) - 1);
      const limit = params.limit ?? MAX_LINES;
      const lines = allLines.slice(offset, offset + limit);

      const numbered = lines
        .map((line, i) => {
          const lineNum = String(offset + i + 1).padStart(5);
          return `${lineNum}\t${line}`;
        })
        .join('\n');

      const result = allLines.length > offset + limit
        ? `${numbered}\n\n(${allLines.length - offset - limit} more lines. Use offset=${offset + limit + 1} to continue.)`
        : numbered;

      // Cache the result
      ctx._readCache?.set(cacheKey, result);

      return { content: result };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { content: `File not found: ${filePath}`, isError: true };
      }
      return { content: `Error reading ${filePath}: ${err.message}`, isError: true };
    }
  },
};
