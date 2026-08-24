import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clock } from '../src/util/time.js';

/** Fresh scratch data dir per test. */
export function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walle-test-'));
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Controllable clock for window/rotation/chase tests. */
export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(date: Date): void {
    this.current = date;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
