import express, { type Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Repos } from '../db/repos.js';
import type { LedgerReader } from '../ledger/read.js';
import { USERS } from '../types/domain.js';

export interface TemplateStatusFetcher {
  /** approval status of the daily_brief template, cached hourly by the caller */
  fetch(): Promise<string>;
}

/**
 * GET /health: everything Dan needs to see at a glance — log writable, db
 * open, per-user window state, template approval, last backup, ledger
 * freshness, recent errors.
 */
export function createHealthRouter(opts: {
  dataDir: string;
  db: Database.Database;
  repos: Repos;
  ledger: LedgerReader;
  templateStatus: TemplateStatusFetcher;
  startedAt: Date;
}): Router {
  const router = express.Router();
  let cachedTemplate: { value: string; at: number } | null = null;

  router.get('/health', async (_req, res) => {
    let logWritable = false;
    try {
      fs.accessSync(path.join(opts.dataDir, 'log'), fs.constants.W_OK);
      logWritable = true;
    } catch {
      logWritable = false;
    }

    let dbOk = false;
    let eventCount = 0;
    try {
      eventCount = (opts.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    if (!cachedTemplate || Date.now() - cachedTemplate.at > 3_600_000) {
      try {
        cachedTemplate = { value: await opts.templateStatus.fetch(), at: Date.now() };
      } catch {
        cachedTemplate = { value: 'unknown', at: Date.now() };
      }
    }

    const windows: Record<string, string | null> = {};
    for (const user of USERS) windows[user] = opts.repos.lastInboundTs(user);

    const ledger = opts.ledger.read();

    const lastBackup = latestBackupTs(opts.repos);
    const recentErrors = opts.repos
      .eventsSince(new Date(Date.now() - 24 * 3_600_000).toISOString(), ['error'])
      .slice(-5)
      .map((e) => ({ ts: e.ts, kind: (e.payload as { kind?: string }).kind ?? 'unknown' }));

    res.json({
      ok: logWritable && dbOk,
      uptimeSeconds: Math.round((Date.now() - opts.startedAt.getTime()) / 1000),
      logWritable,
      dbOk,
      eventCount,
      windows,
      template: { name: 'daily_brief', status: cachedTemplate.value },
      ledger: { present: ledger.summary !== null, fresh: ledger.fresh, staleHours: ledger.staleHours },
      lastBackup,
      recentErrors,
    });
  });
  return router;
}

function latestBackupTs(repos: Repos): string | null {
  const backups = repos.eventsSince('1970-01-01T00:00:00+03:00', ['backup']);
  return backups.length > 0 ? backups[backups.length - 1]!.ts : null;
}
