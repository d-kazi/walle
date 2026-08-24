import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLog } from '../src/log/eventLog.js';
import { readAllEvents } from '../src/log/logReader.js';
import { FakeClock, cleanup, tmpDataDir } from './helpers.js';

describe('EventLog', () => {
  let dir: string;
  beforeEach(() => (dir = tmpDataDir()));
  afterEach(() => cleanup(dir));

  it('appends one JSON line per event with a Riyadh timestamp', () => {
    const clock = new FakeClock(new Date('2026-08-24T03:30:00Z')); // 06:30 Riyadh
    const log = new EventLog(dir, clock);
    log.append({ actor: 'dan', chat: 'dan', type: 'msg_in', payload: { text: 'hi' } });

    const lines = fs
      .readFileSync(path.join(dir, 'log', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]!);
    expect(ev.ts).toBe('2026-08-24T06:30:00+03:00');
    expect(ev.payload.text).toBe('hi');
  });

  it('rotates the live file when the Riyadh month changes', async () => {
    const clock = new FakeClock(new Date('2026-08-31T20:00:00Z')); // 23:00 Riyadh, still August
    const log = new EventLog(dir, clock);
    log.append({ actor: 'system', chat: null, type: 'trigger', payload: { n: 1 } });

    clock.set(new Date('2026-08-31T21:30:00Z')); // 00:30 Riyadh on 1 Sept
    log.append({ actor: 'system', chat: null, type: 'trigger', payload: { n: 2 } });

    const logDir = path.join(dir, 'log');
    expect(fs.existsSync(path.join(logDir, 'events-2026-08.jsonl'))).toBe(true);
    const live = fs.readFileSync(path.join(logDir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]!).payload.n).toBe(2);

    const all: number[] = [];
    for await (const ev of readAllEvents(logDir)) all.push(ev.payload.n as number);
    expect(all).toEqual([1, 2]);
  });

  it('detects the open month from an existing live file after restart', () => {
    const clock = new FakeClock(new Date('2026-08-15T09:00:00Z'));
    const first = new EventLog(dir, clock);
    first.append({ actor: 'system', chat: null, type: 'trigger', payload: { n: 1 } });

    // service restarts in September; a new EventLog must rotate the August file
    const clock2 = new FakeClock(new Date('2026-09-02T09:00:00Z'));
    const second = new EventLog(dir, clock2);
    second.append({ actor: 'system', chat: null, type: 'trigger', payload: { n: 2 } });

    expect(fs.existsSync(path.join(dir, 'log', 'events-2026-08.jsonl'))).toBe(true);
  });

  it('notifies listeners after the line is durable, and survives listener errors', () => {
    const clock = new FakeClock(new Date('2026-08-24T03:30:00Z'));
    const log = new EventLog(dir, clock);
    const seen: string[] = [];
    log.onAppend(() => {
      throw new Error('projector exploded');
    });
    log.onAppend((ev) => seen.push(ev.type));
    const written = log.append({ actor: 'dan', chat: 'dan', type: 'msg_in', payload: {} });
    expect(written.ts).toContain('+03:00');
    expect(seen).toEqual(['msg_in']);
  });
});
