import fs from 'node:fs';
import path from 'node:path';
import type { LedgerSummary } from '../types/domain.js';
import { type Clock, systemClock } from '../util/time.js';

const STALE_HOURS = 72;

export interface LedgerVerdict {
  summary: LedgerSummary | null;
  fresh: boolean;
  staleHours: number | null;
}

/** Read-only view of the ledger summary pushed by walle-finance. */
export class LedgerReader {
  constructor(
    private readonly dataDir: string,
    private readonly clock: Clock = systemClock,
  ) {}

  private get file(): string {
    return path.join(this.dataDir, 'ledger', 'summary.json');
  }

  read(): LedgerVerdict {
    if (!fs.existsSync(this.file)) return { summary: null, fresh: false, staleHours: null };
    try {
      const summary = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LedgerSummary;
      const ageHours =
        (this.clock.now().getTime() - new Date(summary.lastSync).getTime()) / 3_600_000;
      return { summary, fresh: ageHours <= STALE_HOURS, staleHours: Math.round(ageHours) };
    } catch {
      return { summary: null, fresh: false, staleHours: null };
    }
  }
}
