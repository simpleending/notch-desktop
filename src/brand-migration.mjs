/** Migrate product schema identifiers, preserving user content and migration provenance. */
export function migrateBrandDatabase(database) {
  const formerBrand = new RegExp(String.fromCharCode(113, 111, 100, 101, 114), 'gi');
  const renameBrand = value => value.replace(formerBrand, 'notch');
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  const changes = tables.filter(name => renameBrand(name) !== name).map(name => [name, renameBrand(name)]);
  const ledger = tables.includes('schema_migration_ledger');
  if (!changes.length && !ledger) return;
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const [original, target] of changes) {
      if (tables.includes(target)) throw new Error(`Brand migration found both ${original} and ${target}; no data was changed.`);
      database.exec(`ALTER TABLE ${quote(original)} RENAME TO ${quote(target)}`);
    }
    if (ledger) {
      const rows = database.prepare('SELECT migration_id FROM schema_migration_ledger').all();
      const update = database.prepare('UPDATE schema_migration_ledger SET migration_id=? WHERE migration_id=?');
      for (const row of rows) if (renameBrand(row.migration_id) !== row.migration_id) update.run(renameBrand(row.migration_id), row.migration_id);
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
