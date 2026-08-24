import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { WalleEvent } from '../types/events.js';

/**
 * Read events across all rotated files plus the live file, in order.
 * Used by rebuild-db, the curator, and reports. Read-only.
 */
export async function* readAllEvents(logDir: string): AsyncGenerator<WalleEvent> {
  if (!fs.existsSync(logDir)) return;
  const archived = fs
    .readdirSync(logDir)
    .filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort();
  const files = [...archived, 'events.jsonl'].filter((f) => fs.existsSync(path.join(logDir, f)));

  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(logDir, file), 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as WalleEvent;
      } catch {
        // a torn or corrupt line is skipped; the log itself is never edited
      }
    }
  }
}

/** Events with ts on the given Riyadh date (YYYY-MM-DD). */
export async function readEventsForDate(logDir: string, date: string): Promise<WalleEvent[]> {
  const out: WalleEvent[] = [];
  for await (const ev of readAllEvents(logDir)) {
    if (ev.ts.slice(0, 10) === date) out.push(ev);
  }
  return out;
}
