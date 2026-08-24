import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Open (or create) the derived SQLite db and apply pending migrations.
 * Migrations are numbered .sql files applied against PRAGMA user_version.
 * Breaking schema changes are handled by rebuild-from-log, never by data
 * migration code.
 */
export function openDb(dataDir: string): Database.Database {
  const dbDir = path.join(dataDir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new Database(path.join(dbDir, 'walle.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  return db;
}

export function applyMigrations(db: Database.Database): void {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const file of files) {
    const version = parseInt(file.slice(0, 3), 10);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}
