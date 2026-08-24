import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import type { DriveService } from '../google/types.js';
import type { EventLog } from '../log/eventLog.js';
import { type Clock, riyadhDate, systemClock } from '../util/time.js';

const execFileP = promisify(execFile);
const KEEP = 14;

/**
 * 02:00 nightly: checkpoint the db, tar DATA_DIR, upload to the Drive
 * _walle-backup folder (the only Drive write), prune to the newest 14.
 */
export class Backup {
  constructor(
    private readonly log: EventLog,
    private readonly db: Database.Database,
    private readonly drive: DriveService,
    private readonly dataDir: string,
    private readonly clock: Clock = systemClock,
  ) {}

  async run(): Promise<void> {
    const date = riyadhDate(this.clock.now());
    const name = `walle-${date}.tar.gz`;
    const tmp = path.join(os.tmpdir(), name);
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      await execFileP('tar', ['-czf', tmp, '-C', path.dirname(this.dataDir), path.basename(this.dataDir)]);
      await this.drive.uploadBackup(name, tmp);
      const backups = (await this.drive.listBackups()).sort((a, b) =>
        b.modified.localeCompare(a.modified),
      );
      for (const old of backups.slice(KEEP)) {
        await this.drive.deleteBackup(old.id);
      }
      this.log.append({
        actor: 'system',
        chat: null,
        type: 'backup',
        payload: { name, ok: true },
      });
    } catch (err) {
      this.log.append({
        actor: 'system',
        chat: null,
        type: 'error',
        payload: { kind: 'backup_failed', message: String(err) },
      });
      throw err;
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
    }
  }
}
