import fs from 'node:fs';
import path from 'node:path';
import type { WalleEvent } from '../types/events.js';
import { type Clock, riyadhIso, riyadhMonth, systemClock } from '../util/time.js';

/**
 * The one writer (hard rule 6). Append-only JSONL, one event per line,
 * synchronous write + fsync so an accepted webhook is durable before we
 * process it (hard rule 5: log first). Rotated monthly: the live file is
 * events.jsonl; on the first append of a new Riyadh month the live file is
 * renamed to events-YYYY-MM.jsonl and a fresh one is started.
 */
export class EventLog {
  private readonly dir: string;
  private readonly livePath: string;
  private openMonth: string | null = null;
  private readonly clock: Clock;
  private listeners: Array<(ev: WalleEvent) => void> = [];

  constructor(dataDir: string, clock: Clock = systemClock) {
    this.clock = clock;
    this.dir = path.join(dataDir, 'log');
    this.livePath = path.join(this.dir, 'events.jsonl');
    fs.mkdirSync(this.dir, { recursive: true });
    this.openMonth = this.readLiveMonth();
  }

  /** Month of the last line in the live file, or null when empty/absent. */
  private readLiveMonth(): string | null {
    if (!fs.existsSync(this.livePath)) return null;
    const content = fs.readFileSync(this.livePath, 'utf8').trimEnd();
    if (!content) return null;
    const lastLine = content.slice(content.lastIndexOf('\n') + 1);
    try {
      const parsed = JSON.parse(lastLine) as { ts?: string };
      return parsed.ts ? parsed.ts.slice(0, 7) : null;
    } catch {
      return null;
    }
  }

  /**
   * Append an event. `ts` is filled in from the clock when absent.
   * Returns the event as written.
   */
  append(event: Omit<WalleEvent, 'ts'> & { ts?: string }): WalleEvent {
    const now = this.clock.now();
    const full: WalleEvent = { ts: event.ts ?? riyadhIso(now), ...event } as WalleEvent;
    const month = riyadhMonth(now);

    if (this.openMonth !== null && this.openMonth !== month && fs.existsSync(this.livePath)) {
      const archived = path.join(this.dir, `events-${this.openMonth}.jsonl`);
      if (!fs.existsSync(archived)) {
        fs.renameSync(this.livePath, archived);
      }
    }
    this.openMonth = month;

    const line = JSON.stringify(full) + '\n';
    const fd = fs.openSync(this.livePath, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // listeners (the projector) must never break the log path
      }
    }
    return full;
  }

  /** Register a post-append listener (the SQLite projector). */
  onAppend(listener: (ev: WalleEvent) => void): void {
    this.listeners.push(listener);
  }

  get directory(): string {
    return this.dir;
  }
}
