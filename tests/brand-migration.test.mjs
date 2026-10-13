import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateBrandDatabase } from '../src/brand-migration.mjs';
test('brand migration preserves rows, user text and original migration hashes, and is repeatable', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE qoder_cache(value TEXT); CREATE TABLE schema_migration_ledger(migration_id TEXT PRIMARY KEY,content_hash TEXT);');
    database.prepare('INSERT INTO qoder_cache VALUES(?)').run('user text about qoder');
    database.prepare('INSERT INTO schema_migration_ledger VALUES(?,?)').run('qoder-baseline', 'original-hash');
    migrateBrandDatabase(database); migrateBrandDatabase(database);
    assert.equal(database.prepare('SELECT value FROM notch_cache').get().value, 'user text about qoder');
    assert.deepEqual({ ...database.prepare('SELECT * FROM schema_migration_ledger').get() }, { migration_id: 'notch-baseline', content_hash: 'original-hash' });
  } finally { database.close(); }
});
test('a conflicting migration rolls back without changing either table', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE qoder_cache(value TEXT); CREATE TABLE notch_cache(value TEXT);');
    assert.throws(() => migrateBrandDatabase(database), /both/);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('qoder_cache','notch_cache')").get().n, 2);
  } finally { database.close(); }
});
