/**
 * Notch CLI — Session Persistence
 *
 * Save and resume conversations across CLI restarts.
 * Sessions are stored as JSON in ~/.notch/sessions/.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ModelMessage } from 'ai';
import { normalizeMessages } from '../messages.js';

// Re-export rollout primitives so callers can opt into append-only sessions
// with resumable streams and a fork-safe parent graph.
export {
  Rollout,
  readRollout,
  readIndex,
  listRollouts,
  rebuildMessagesFromRollout,
  hasActiveStream,
  generateSessionId,
  rolloutPath,
  indexPath,
  type RolloutRecord,
  type RolloutIndex,
  type RolloutType,
} from './rollout.js';

// Cross-session index (Codex-style `session_index.rs`, pure-JS so no native
// sqlite bindings ship with the CLI). The index tracks every rollout on
// disk and enables filter/search without scanning the rollouts directory.
export {
  querySessions,
  getSession,
  forgetSession,
  tagSession,
  rebuildIndex,
  upsertSessionIndexEntry,
  indexFilePath,
  deriveEntryFromRollout,
  type SessionIndexEntry,
  type ListOptions,
} from './session-index.js';

// Fork-from-turn (Codex `thread_manager.fork()`). Creates an independent
// child session copied up to a chosen turn.
export {
  forkSession,
  seqOfUserTurn,
  type ForkOptions,
  type ForkResult,
} from './fork.js';

// Rollout tail — stream events from an in-flight session.
export {
  tailRollout,
  type TailOptions,
  type TailController,
} from './tail.js';

const SESSION_DIR = path.join(os.homedir(), '.notch', 'sessions');
const MAX_SESSIONS = 20;

export interface SessionMeta {
  id: string;
  project: string;
  model: string;
  created: string;
  updated: string;
  turns: number;
  preview: string;
}

export interface Session {
  meta: SessionMeta;
  messages: ModelMessage[];
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSION_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return path.join(SESSION_DIR, `${id}.json`);
}

function generateId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${date}-${rand}`;
}

/**
 * Save the current session to disk.
 */
export async function saveSession(
  messages: ModelMessage[],
  project: string,
  model: string,
  existingId?: string,
): Promise<string> {
  await ensureDir();

  const id = existingId ?? generateId();
  const now = new Date().toISOString();

  // Extract preview from first user message
  const firstUser = messages.find((m) => m.role === 'user');
  const preview = firstUser && typeof firstUser.content === 'string'
    ? firstUser.content.slice(0, 80)
    : '(no preview)';

  const userCount = messages.filter((m) => m.role === 'user').length;

  const session: Session = {
    meta: {
      id,
      project,
      model,
      created: existingId ? (await loadSession(existingId))?.meta.created ?? now : now,
      updated: now,
      turns: userCount,
      preview,
    },
    messages,
  };

  await fs.writeFile(sessionPath(id), JSON.stringify(session, null, 2), 'utf-8');

  // Prune old sessions
  await pruneOldSessions();

  return id;
}

/**
 * Load a session by ID.
 */
export async function loadSession(id: string): Promise<Session | null> {
  try {
    const raw = await fs.readFile(sessionPath(id), 'utf-8');
    const session = JSON.parse(raw) as Session;
    return { ...session, messages: normalizeMessages(session.messages) };
  } catch {
    return null;
  }
}

/**
 * List all saved sessions, newest first.
 */
export async function listSessions(): Promise<SessionMeta[]> {
  await ensureDir();

  const files = await fs.readdir(SESSION_DIR);
  const sessions: SessionMeta[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(SESSION_DIR, file), 'utf-8');
      const session = JSON.parse(raw) as Session;
      sessions.push(session.meta);
    } catch {
      // Skip corrupt sessions
    }
  }

  return sessions.sort((a, b) => b.updated.localeCompare(a.updated));
}

/**
 * Load the most recent session for a project.
 */
export async function loadLastSession(project: string): Promise<Session | null> {
  const sessions = await listSessions();
  const match = sessions.find((s) => s.project === project);
  if (!match) return null;
  return loadSession(match.id);
}

/**
 * Delete a session.
 */
export async function deleteSession(id: string): Promise<boolean> {
  try {
    await fs.unlink(sessionPath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep only the most recent MAX_SESSIONS sessions.
 */
async function pruneOldSessions(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length <= MAX_SESSIONS) return;

  const toDelete = sessions.slice(MAX_SESSIONS);
  for (const s of toDelete) {
    await deleteSession(s.id);
  }
}

/**
 * Export a conversation to a markdown file.
 */
export async function exportSession(
  messages: ModelMessage[],
  outputPath: string,
  meta?: { model: string; project: string },
): Promise<string> {
  const lines: string[] = [];

  lines.push('# Notch Conversation Export');
  lines.push('');
  if (meta) {
    lines.push(`- **Model**: ${meta.model}`);
    lines.push(`- **Project**: ${meta.project}`);
  }
  lines.push(`- **Date**: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push('## User');
      lines.push('');
      if (typeof msg.content === 'string') {
        lines.push(msg.content);
      }
      lines.push('');
    } else if (msg.role === 'assistant') {
      lines.push('## Notch');
      lines.push('');
      if (typeof msg.content === 'string') {
        lines.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ('text' in part) {
            lines.push(part.text);
          } else if ('toolName' in part) {
            lines.push(`> Tool call: \`${(part as any).toolName}\``);
          }
        }
      }
      lines.push('');
    } else if (msg.role === 'tool') {
      lines.push('> *Tool results omitted for brevity*');
      lines.push('');
    }
  }

  await fs.writeFile(outputPath, lines.join('\n'), 'utf-8');
  return outputPath;
}
