import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/db.js';
import { Projector } from '../src/db/projector.js';
import { Repos } from '../src/db/repos.js';
import { rebuildDb } from '../src/db/rebuild.js';
import { EventLog } from '../src/log/eventLog.js';
import type { WalleEvent } from '../src/types/events.js';
import { FakeClock, cleanup, tmpDataDir } from './helpers.js';
import path from 'node:path';

function memDb(): Database.Database {
  const db = new Database(':memory:');
  applyMigrations(db);
  return db;
}

const T0 = '2026-08-24T06:30:00+03:00';

describe('Projector', () => {
  let db: Database.Database;
  let projector: Projector;
  let repos: Repos;

  beforeEach(() => {
    db = memDb();
    projector = new Projector(db);
    repos = new Repos(db);
  });

  it('tracks window state from inbound messages', () => {
    projector.apply({
      ts: T0,
      actor: 'dan',
      chat: 'dan',
      type: 'msg_in',
      payload: { kind: 'text', text: 'hi' },
      wa_msg_id: 'wamid.1',
    });
    expect(repos.lastInboundTs('dan')).toBe(T0);
    expect(repos.lastInboundTs('alina')).toBeNull();
    expect(repos.hasProcessedMessage('wamid.1')).toBe(true);
    expect(repos.hasProcessedMessage('wamid.2')).toBe(false);
  });

  it('is idempotent on duplicate wa_msg_id (Meta retries)', () => {
    const ev: WalleEvent = {
      ts: T0,
      actor: 'dan',
      chat: 'dan',
      type: 'msg_in',
      payload: { kind: 'text', text: 'hi' },
      wa_msg_id: 'wamid.1',
    };
    projector.apply(ev);
    projector.apply(ev); // retry lands again
    const count = db.prepare('SELECT COUNT(*) AS c FROM processed_messages').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('manages open items via intent events', () => {
    projector.apply({
      ts: T0,
      actor: 'walle',
      chat: null,
      type: 'intent',
      payload: {
        kind: 'open_item',
        op: 'create',
        item: { id: 'oi1', title: 'PE kit', owner: 'both', child: 'dylan', due: '2026-08-27' },
      },
    });
    expect(repos.openItems()).toHaveLength(1);
    projector.apply({
      ts: T0,
      actor: 'dan',
      chat: 'dan',
      type: 'intent',
      payload: { kind: 'open_item', op: 'complete', item: { id: 'oi1' } },
    });
    expect(repos.openItems()).toHaveLength(0);
    expect(repos.openItem('oi1')?.status).toBe('done');
  });

  it('stores child_time per reporter so both parents coexist', () => {
    projector.apply({
      ts: T0,
      actor: 'dan',
      chat: 'dan',
      type: 'child_time',
      payload: {
        date: '2026-08-24',
        reporter: 'dan',
        entries: [
          { child: 'dylan', level: 'proper' },
          { child: 'maxie', level: 'none' },
        ],
      },
    });
    projector.apply({
      ts: T0,
      actor: 'alina',
      chat: 'alina',
      type: 'child_time',
      payload: { date: '2026-08-24', reporter: 'alina', entries: [{ child: 'dylan', level: 'some' }] },
    });
    const rows = repos.childTimeForDate('2026-08-24');
    expect(rows).toHaveLength(3);
  });

  it('walks a proposal through confirm_req → confirm_res', () => {
    projector.apply({
      ts: T0,
      actor: 'walle',
      chat: null,
      type: 'confirm_req',
      payload: {
        proposal: {
          id: 'p1',
          kind: 'calendar_event',
          payload: { title: 'Swimming gala' },
          proposedTo: 'both',
        },
      },
    });
    expect(repos.pendingProposalsFor('alina')).toHaveLength(1);
    projector.apply({
      ts: T0,
      actor: 'alina',
      chat: 'alina',
      type: 'confirm_res',
      payload: { proposalId: 'p1', answer: 'yes', by: 'alina' },
    });
    const p = repos.proposal('p1');
    expect(p?.status).toBe('confirmed');
    expect(p?.answeredBy).toBe('alina');
    // second tap from Dan does nothing: already answered
    projector.apply({
      ts: T0,
      actor: 'dan',
      chat: 'dan',
      type: 'confirm_res',
      payload: { proposalId: 'p1', answer: 'no', by: 'dan' },
    });
    expect(repos.proposal('p1')?.status).toBe('confirmed');
  });

  it('records brief and midday state from trigger events', () => {
    projector.apply({
      ts: T0,
      actor: 'walle',
      chat: 'dan',
      type: 'trigger',
      payload: { kind: 'brief_sent', user: 'dan', briefType: 'morning' },
    });
    expect(repos.lastBriefTs('dan', 'morning')).toBe(T0);
    projector.apply({
      ts: T0,
      actor: 'walle',
      chat: 'dan',
      type: 'trigger',
      payload: { kind: 'midday_sent', user: 'dan' },
    });
    expect(repos.middaySentToday('dan', '2026-08-24')).toBe(true);
    expect(repos.middaySentToday('alina', '2026-08-24')).toBe(false);
  });
});

describe('rebuild-db equivalence', () => {
  let dir: string;
  beforeEach(() => (dir = tmpDataDir()));
  afterEach(() => cleanup(dir));

  it('replaying the log produces the same derived state as live projection', async () => {
    const clock = new FakeClock(new Date('2026-08-24T03:30:00Z'));
    const log = new EventLog(dir, clock);
    const liveDb = memDb();
    const live = new Projector(liveDb);
    log.onAppend((ev) => live.apply(ev));

    log.append({ actor: 'dan', chat: 'dan', type: 'msg_in', payload: { kind: 'text', text: 'a' }, wa_msg_id: 'w1' });
    clock.advance(60_000);
    log.append({
      actor: 'walle',
      chat: null,
      type: 'intent',
      payload: { kind: 'open_item', op: 'create', item: { id: 'oi1', title: 'Forms', owner: 'dan' } },
    });
    clock.advance(60_000);
    log.append({
      actor: 'walle',
      chat: null,
      type: 'confirm_req',
      payload: { proposal: { id: 'p1', kind: 'open_item', payload: {}, proposedTo: 'dan' } },
    });

    await rebuildDb(dir);
    const rebuilt = new Database(path.join(dir, 'db', 'walle.db'));

    for (const table of ['events', 'open_items', 'proposals', 'window_state', 'processed_messages']) {
      const a = liveDb.prepare(`SELECT * FROM ${table}`).all();
      const b = rebuilt.prepare(`SELECT * FROM ${table}`).all();
      expect(b).toEqual(a);
    }
    rebuilt.close();
  });
});
