/**
 * Notch CLI — Memory Store
 *
 * File-based memory system that persists across sessions.
 * Stores memories as markdown files with YAML frontmatter.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateText, type LanguageModel } from 'ai';

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  filename: string;
  updated?: string;
}

const MEMORY_DIR = path.join(os.homedir(), '.notch', 'memory');
const INDEX_FILE = path.join(MEMORY_DIR, 'MEMORY.md');
const SUMMARY_FILE = path.join(MEMORY_DIR, 'SUMMARY.md');
const SUMMARY_FILENAME = path.basename(SUMMARY_FILE);
const DEFAULT_PROMPT_CHAR_BUDGET = Number(process.env.NOTCH_MEMORY_PROMPT_CHARS ?? 6000);
const MAX_SINGLE_MEMORY_CHARS = Number(process.env.NOTCH_MEMORY_ITEM_CHARS ?? 4000);
const MAX_COMPACTION_INPUT_CHARS = Number(process.env.NOTCH_MEMORY_COMPACT_INPUT_CHARS ?? 30000);

export interface SaveMemoryOptions {
  /** Keep existing same-name memories intact by adding a suffix. */
  unique?: boolean;
}

export interface MemoryPromptStats {
  rawCount: number;
  rawChars: number;
  summaryChars: number;
  promptBudget: number;
  overBudget: boolean;
}

export interface MemoryCompactionResult {
  summaryPath: string;
  rawCount: number;
  summaryChars: number;
  usedModel: boolean;
}

/**
 * Ensure the memory directory exists.
 */
async function ensureDir(): Promise<void> {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
}

/**
 * Save a memory to disk.
 */
export function getMemoryDir(): string {
  return MEMORY_DIR;
}

export function getMemorySummaryPath(): string {
  return SUMMARY_FILE;
}

/**
 * Save a memory to disk.
 */
export async function saveMemory(
  memory: Omit<Memory, 'filename'>,
  options: SaveMemoryOptions = {},
): Promise<string> {
  await ensureDir();

  const slug = memory.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'memory';
  let filename = `${memory.type}_${slug}.md`;
  if (options.unique) {
    filename = await uniqueFilename(memory.type, slug);
  }
  const filePath = path.join(MEMORY_DIR, filename);
  const content = clampMemoryContent(memory.content);

  const fileContent = [
    '---',
    `name: ${oneLine(memory.name)}`,
    `description: ${oneLine(memory.description)}`,
    `type: ${memory.type}`,
    `updated: ${new Date().toISOString().split('T')[0]}`,
    '---',
    '',
    content,
  ].join('\n');

  await fs.writeFile(filePath, fileContent, 'utf-8');
  await updateIndex();

  return filename;
}

/**
 * Load all memories from disk.
 */
export async function loadMemories(): Promise<Memory[]> {
  await ensureDir();

  const files = await fs.readdir(MEMORY_DIR);
  const memories: Memory[] = [];

  for (const file of files) {
    if (!file.endsWith('.md') || file === 'MEMORY.md' || file === SUMMARY_FILENAME) continue;

    try {
      const content = await fs.readFile(path.join(MEMORY_DIR, file), 'utf-8');
      const memory = parseMemoryFile(content, file);
      if (memory) memories.push(memory);
    } catch {
      // Skip unreadable files
    }
  }

  return memories;
}

/**
 * Load memories of a specific type.
 */
export async function loadMemoriesByType(type: MemoryType): Promise<Memory[]> {
  const all = await loadMemories();
  return all.filter((m) => m.type === type);
}

/**
 * Delete a memory by filename.
 */
export async function deleteMemory(filename: string): Promise<boolean> {
  try {
    await fs.unlink(path.join(MEMORY_DIR, filename));
    await updateIndex();
    return true;
  } catch {
    return false;
  }
}

/**
 * Search memories by keyword.
 */
export async function searchMemories(query: string): Promise<Memory[]> {
  const all = await loadMemories();
  const q = query.toLowerCase();
  return all.filter(
    (m) =>
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q) ||
      m.content.toLowerCase().includes(q),
  );
}

/**
 * Format memories for injection into the system prompt.
 */
export async function formatMemoriesForPrompt(options: { maxChars?: number } = {}): Promise<string> {
  const memories = await loadMemories();
  const summary = await loadMemorySummary();
  if (memories.length === 0 && !summary) return '';
  const maxChars = Math.max(1000, options.maxChars ?? DEFAULT_PROMPT_CHAR_BUDGET);

  const byType = new Map<MemoryType, Memory[]>();
  for (const m of memories) {
    const list = byType.get(m.type) ?? [];
    list.push(m);
    byType.set(m.type, list);
  }

  const sections: string[] = ['\n## Memory (bounded local context)\n'];
  let usedChars = sections.join('\n').length;

  const push = (line: string): boolean => {
    const next = `${line}\n`;
    if (usedChars + next.length > maxChars) return false;
    sections.push(line);
    usedChars += next.length;
    return true;
  };

  if (summary) {
    push('### Summary');
    push(summary.slice(0, Math.min(summary.length, Math.floor(maxChars * 0.55))));
    push('');
  }

  const typeLabels: Record<MemoryType, string> = {
    user: 'User Profile',
    feedback: 'Behavioral Guidance',
    project: 'Project Context',
    reference: 'External References',
  };

  for (const [type, label] of Object.entries(typeLabels) as [MemoryType, string][]) {
    const mems = byType.get(type);
    if (!mems || mems.length === 0) continue;
    if (!push(`### ${label}`)) break;
    for (const m of mems) {
      if (!push(`- **${m.name}**: ${m.content.slice(0, 280)}`)) {
        push('- Additional memories omitted from this prompt budget.');
        return sections.join('\n');
      }
    }
    if (!push('')) break;
  }

  return sections.join('\n');
}

export async function getMemoryPromptStats(promptBudget = DEFAULT_PROMPT_CHAR_BUDGET): Promise<MemoryPromptStats> {
  const memories = await loadMemories();
  const summary = await loadMemorySummary();
  const rawChars = memories.reduce((sum, memory) => sum + memory.content.length, 0);
  return {
    rawCount: memories.length,
    rawChars,
    summaryChars: summary.length,
    promptBudget,
    overBudget: rawChars + summary.length > promptBudget * 2,
  };
}

export async function compactMemoriesWithModel(
  model: LanguageModel,
  options: { targetChars?: number } = {},
): Promise<MemoryCompactionResult> {
  const memories = await loadMemories();
  if (memories.length === 0) {
    await ensureDir();
    await fs.writeFile(SUMMARY_FILE, '# Notch Memory Summary\n\nNo saved memories yet.\n', 'utf-8');
    return { summaryPath: SUMMARY_FILE, rawCount: 0, summaryChars: 0, usedModel: false };
  }

  const targetChars = Math.max(1000, options.targetChars ?? DEFAULT_PROMPT_CHAR_BUDGET);
  const rawText = memoriesToCompactionText(memories).slice(0, MAX_COMPACTION_INPUT_CHARS);
  let summary = '';
  let usedModel = true;

  try {
    const result = await generateText({
      model,
      instructions:
        'You maintain a local memory summary for a coding CLI agent. ' +
        'Condense saved memories into durable, high-signal Markdown. ' +
        'Keep stable user preferences, workflow constraints, recurring project facts, ' +
        'important decisions, and lessons learned. Drop transient chat details, duplicates, ' +
        'stale one-off tasks, and anything too vague to be useful. If memories conflict, ' +
        'prefer the newest or most explicit statement. Output Markdown only.',
      messages: [{
        role: 'user',
        content:
          `Target maximum: ${targetChars} characters.\n\n` +
          'Saved memory files:\n\n' +
          rawText,
      }],
      maxOutputTokens: Math.max(512, Math.ceil(targetChars / 3)),
    });
    summary = result.text.trim();
  } catch {
    usedModel = false;
    summary = deterministicSummary(memories, targetChars);
  }

  if (summary.length > targetChars) {
    summary = `${summary.slice(0, Math.max(0, targetChars - 80)).trimEnd()}\n\n- Summary truncated to fit memory budget.`;
  }

  await ensureDir();
  const fileContent = [
    '# Notch Memory Summary',
    '',
    `_Updated: ${new Date().toISOString()}_`,
    '',
    summary,
    '',
  ].join('\n');
  await fs.writeFile(SUMMARY_FILE, fileContent, 'utf-8');
  await updateIndex();
  return {
    summaryPath: SUMMARY_FILE,
    rawCount: memories.length,
    summaryChars: summary.length,
    usedModel,
  };
}

export function extractMemoryCandidate(text: string): string | null {
  const trimmed = text.trim();
  const patterns = [
    /\bremember\s+(?:that\s+)?(.{8,800})$/i,
    /\bfor future reference[:,]?\s*(.{8,800})$/i,
    /\bkeep in mind[:,]?\s*(.{8,800})$/i,
    /\bplease note[:,]?\s*(.{8,800})$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate.replace(/[.!?]*$/, '.');
  }
  return null;
}

export async function rememberUserPreference(text: string): Promise<string> {
  const content = text.trim();
  const words = content.toLowerCase().replace(/[^a-z0-9\s]+/g, '').split(/\s+/).filter(Boolean);
  const name = words.slice(0, 8).join(' ') || 'user preference';
  return saveMemory({
    name,
    description: content.slice(0, 100),
    type: 'user',
    content,
  }, { unique: true });
}

/** Parse a memory file with YAML frontmatter */
function parseMemoryFile(raw: string, filename: string): Memory | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1]!;
  const content = fmMatch[2]!.trim();

  const name = extractField(frontmatter, 'name') ?? filename;
  const description = extractField(frontmatter, 'description') ?? '';
  const type = (extractField(frontmatter, 'type') ?? 'project') as MemoryType;
  const updated = extractField(frontmatter, 'updated') ?? undefined;

  return { name, description, type, content, filename, updated };
}

function extractField(frontmatter: string, field: string): string | null {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? null;
}

/** Rebuild the MEMORY.md index file */
async function updateIndex(): Promise<void> {
  const memories = await loadMemories();

  const lines = [
    '# Notch Memory Index',
    '',
    `_${memories.length} memories stored. Auto-generated — do not edit._`,
    '',
  ];

  const byType = new Map<MemoryType, Memory[]>();
  for (const m of memories) {
    const list = byType.get(m.type) ?? [];
    list.push(m);
    byType.set(m.type, list);
  }

  for (const [type, mems] of byType) {
    lines.push(`## ${type}`);
    for (const m of mems) {
      lines.push(`- [${m.filename}](${m.filename}) — ${m.description}`);
    }
    lines.push('');
  }

  await fs.writeFile(INDEX_FILE, lines.join('\n'), 'utf-8');
}

async function uniqueFilename(type: MemoryType, slug: string): Promise<string> {
  let filename = `${type}_${slug}.md`;
  let filePath = path.join(MEMORY_DIR, filename);
  try {
    await fs.access(filePath);
  } catch {
    return filename;
  }

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  for (let i = 1; i < 100; i++) {
    filename = `${type}_${slug}_${stamp}_${i}.md`;
    filePath = path.join(MEMORY_DIR, filename);
    try {
      await fs.access(filePath);
    } catch {
      return filename;
    }
  }
  return `${type}_${slug}_${Date.now()}.md`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clampMemoryContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_SINGLE_MEMORY_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SINGLE_MEMORY_CHARS - 80).trimEnd()}\n\n[Memory item truncated to fit local item limit.]`;
}

async function loadMemorySummary(): Promise<string> {
  try {
    const raw = await fs.readFile(SUMMARY_FILE, 'utf-8');
    return raw
      .replace(/^# Notch Memory Summary\s*/i, '')
      .replace(/^_Updated:.*?_\s*/im, '')
      .trim();
  } catch {
    return '';
  }
}

function memoriesToCompactionText(memories: Memory[]): string {
  return memories.map((memory) => [
    `File: ${memory.filename}`,
    `Type: ${memory.type}`,
    `Name: ${memory.name}`,
    memory.updated ? `Updated: ${memory.updated}` : undefined,
    `Description: ${memory.description}`,
    'Content:',
    memory.content,
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');
}

function deterministicSummary(memories: Memory[], targetChars: number): string {
  const lines: string[] = ['## Durable Memory'];
  for (const type of ['user', 'feedback', 'project', 'reference'] as MemoryType[]) {
    const matching = memories.filter((memory) => memory.type === type);
    if (matching.length === 0) continue;
    lines.push('', `### ${type}`);
    for (const memory of matching.slice(-20)) {
      lines.push(`- ${memory.content.slice(0, 240)}`);
      if (lines.join('\n').length >= targetChars) return lines.join('\n').slice(0, targetChars);
    }
  }
  return lines.join('\n').slice(0, targetChars);
}
