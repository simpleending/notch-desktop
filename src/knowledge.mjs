import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

export function createKnowledge(directory) {
  const file = path.join(directory, 'app-plugin-data', 'notch.knowledge.center', 'local-library.sqlite');
  return async ({ query = '', id } = {}) => {
    if (typeof query !== 'string' || query.length > 256 || id !== undefined && !/^[a-f\d-]{36}$/i.test(id)) throw Error('Choose a valid knowledge query or document.');
    if (!existsSync(file)) return { documents: [] };
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=3000');
      if (id) { const document = db.prepare('SELECT id,title,substr(body,1,24000) AS body,length(body)>24000 AS truncated,updatedAt FROM documents WHERE id=?').get(id); if (!document) throw Error('This note no longer exists.'); return { document }; }
      return { documents: db.prepare('SELECT id,title,substr(body,1,500) AS excerpt,updatedAt FROM documents WHERE instr(lower(title),lower(?)) OR instr(lower(body),lower(?)) ORDER BY updatedAt DESC LIMIT 20').all(query, query) };
    } finally { db.close(); }
  };
}
