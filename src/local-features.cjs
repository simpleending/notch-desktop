const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MAX_TEXT = 2 * 1024 * 1024;
function text(value, maximum, label, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || Buffer.byteLength(value) > maximum || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return value;
}
function identity(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid document ID.');
  return value;
}

// Each plugin receives its own OS-user profile directory from the existing plugin host.
function openLibrary(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const databasePath = path.join(directory, 'local-library.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL, updatedAt TEXT NOT NULL)');
  const read = id => {
    const row = db.prepare('SELECT * FROM documents WHERE id=?').get(identity(id));
    if (!row) throw new Error('This document no longer exists. Refresh the list.');
    return { ...row };
  };
  return {
    list({ query = '' } = {}) {
      text(query, 256, 'search', true);
      return { directory, databasePath, documents: db.prepare('SELECT id,title,revision,updatedAt,substr(body,1,180) AS excerpt FROM documents WHERE instr(lower(title),lower(?)) OR instr(lower(body),lower(?)) ORDER BY updatedAt DESC,id').all(query, query).map(row => ({ ...row })) };
    },
    read({ id }) { return read(id); },
    save({ id, title, body, revision }) {
      text(title, 1024, 'title'); text(body, MAX_TEXT, 'document text', true);
      if (id !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('Invalid document revision.');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (id !== undefined && read(id).revision !== revision) throw new Error('This document changed in another window. Reopen it before saving; your draft is still here.');
        const next = { id: id === undefined ? randomUUID() : identity(id), title: title.trim(), body, revision: id === undefined ? 1 : revision + 1, updatedAt: new Date().toISOString() };
        db.prepare('INSERT INTO documents VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,revision=excluded.revision,updatedAt=excluded.updatedAt').run(next.id, next.title, next.body, next.revision, next.updatedAt);
        db.exec('COMMIT'); return next;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    remove({ id, revision }) {
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid document revision.');
      const result = db.prepare('DELETE FROM documents WHERE id=? AND revision=?').run(identity(id), revision);
      if (result.changes !== 1) throw new Error('This document changed or was removed. Refresh before deleting.');
      return { removed: true };
    },
    close() { db.close(); },
  };
}

async function activate(context, kind) {
  const library = kind === 'index' ? null : openLibrary(context.storagePath);
  const service = kind === 'knowledge' ? 'knowledge-center' : kind === 'sites' ? 'sites' : 'index-settings';
  const methods = library ? Object.fromEntries(['list', 'read', 'save', 'remove'].map(method => [method, input => library[method](input)])) : {
    snapshot: async () => ({ projects: await context.api.workspace.listProjects() }),
  };
  try {
    const registration = context.api.node.registerService({ name: service, methods });
    context.subscriptions.push({ dispose() { registration.dispose(); library?.close(); } });
  } catch (error) { library?.close(); throw error; }
}
module.exports = { activate, openLibrary };
