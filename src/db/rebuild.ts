import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { readAllEvents } from '../log/logReader.js';
import { applyMigrations } from './db.js';
import { Projector } from './projector.js';

/**
 * Rebuild the derived SQLite db from the JSONL log. Deletes the db files and
 * replays every event through the same Projector used live.
 */
export async function rebuildDb(dataDir: string): Promise<number> {
  const dbDir = path.join(dataDir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const p = path.join(dbDir, `walle.db${suffix}`);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  const db = new Database(path.join(dbDir, 'walle.db'));
  db.pragma('journal_mode = WAL');
  applyMigrations(db);
  const projector = new Projector(db);
  let count = 0;
  for await (const ev of readAllEvents(path.join(dataDir, 'log'))) {
    projector.apply(ev);
    count++;
  }
  db.close();
  return count;
}
