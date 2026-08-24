import crypto from 'node:crypto';
import express, { type Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EventLog } from '../log/eventLog.js';

const summarySchema = z.object({
  lastSync: z.string(),
  monthToDate: z.record(z.number()),
  notableDeltas: z.array(z.string()).default([]),
});

/**
 * POST /ledger: the walle-finance pipeline on Dan's Mac pushes a read-only
 * summary JSON. Bearer token (constant-time compare), 256 KB cap, shape
 * validation, atomic write. Wall-E only ever reads the resulting file.
 */
export function createLedgerRouter(opts: {
  log: EventLog;
  dataDir: string;
  pushToken: string;
}): Router {
  const router = express.Router();
  router.post('/ledger', express.json({ limit: '256kb' }), (req, res) => {
    const auth = req.header('authorization') ?? '';
    const expected = `Bearer ${opts.pushToken}`;
    const authBuf = Buffer.from(auth, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const ok =
      authBuf.length === expectedBuf.length && crypto.timingSafeEqual(authBuf, expectedBuf);
    if (!ok) {
      res.sendStatus(401);
      return;
    }
    const parsed = summarySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid summary shape' });
      return;
    }
    const dir = path.join(opts.dataDir, 'ledger');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'summary.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(parsed.data, null, 2));
    fs.renameSync(tmp, file);
    opts.log.append({
      actor: 'finance',
      chat: null,
      type: 'trigger',
      payload: { kind: 'ledger_sync', lastSync: parsed.data.lastSync },
    });
    res.json({ ok: true });
  });
  return router;
}
