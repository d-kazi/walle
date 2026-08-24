import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';
import { explicitScope } from '../src/memory/router.js';
import { cleanup, tmpDataDir } from './helpers.js';

describe('MemoryStore', () => {
  let dir: string;
  beforeEach(() => (dir = tmpDataDir()));
  afterEach(() => cleanup(dir));

  it('scaffolds all six files with child sections', () => {
    new MemoryStore(dir);
    for (const f of ['shared.md', 'dan.private.md', 'alina.private.md']) {
      expect(fs.existsSync(path.join(dir, 'memory', f))).toBe(true);
    }
    const dylan = fs.readFileSync(path.join(dir, 'memory', 'children', 'dylan.md'), 'utf8');
    expect(dylan).toContain('## Quarter plan');
    expect(dylan).toContain('## Standing facts');
    expect(dylan).toContain('## Open');
    expect(dylan).toContain('ADHD');
  });

  it('adds facts with valid_from metadata', () => {
    const store = new MemoryStore(dir);
    store.add({ kind: 'shared' }, 'School pickup is 15:00', '2026-08-24');
    expect(store.activeFacts({ kind: 'shared' })).toEqual([
      '- School pickup is 15:00 {valid_from: 2026-08-24}',
    ]);
  });

  it('adds child facts inside the right section', () => {
    const store = new MemoryStore(dir);
    store.add({ kind: 'child', child: 'caspian' }, 'Loves dinosaurs', '2026-08-24', '## Standing facts');
    const content = fs.readFileSync(path.join(dir, 'memory', 'children', 'caspian.md'), 'utf8');
    const standingIdx = content.indexOf('## Standing facts');
    const openIdx = content.indexOf('## Open');
    const factIdx = content.indexOf('Loves dinosaurs');
    expect(factIdx).toBeGreaterThan(standingIdx);
    expect(factIdx).toBeLessThan(openIdx);
  });

  it('supersedes a fact: old bullet marked, replacement added, never re-served', () => {
    const store = new MemoryStore(dir);
    store.add({ kind: 'shared' }, 'School pickup is 15:00', '2026-08-24');
    const ok = store.supersede({ kind: 'shared' }, 'pickup is 15:00', 'School pickup is 14:30', '2026-09-10');
    expect(ok).toBe(true);

    const raw = store.read({ kind: 'shared' });
    expect(raw).toContain('{superseded: 2026-09-10}');
    expect(raw).toContain('School pickup is 14:30 {valid_from: 2026-09-10}');

    const active = store.activeFacts({ kind: 'shared' });
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('14:30');
    expect(active.some((f) => f.includes('15:00'))).toBe(false);
  });

  it('keeps private files strictly separate', () => {
    const store = new MemoryStore(dir);
    store.add({ kind: 'private', user: 'dan' }, "Collect Alina's birthday present Thursday", '2026-08-24');
    expect(store.activeFacts({ kind: 'private', user: 'alina' })).toHaveLength(0);
    expect(store.activeFacts({ kind: 'shared' })).toHaveLength(0);
    expect(store.activeFacts({ kind: 'private', user: 'dan' })).toHaveLength(1);
  });
});

describe('explicit routing phrases (deterministic, no model involved)', () => {
  it('"just for me" routes private to the speaker', () => {
    const r = explicitScope('just for me: thinking about changing jobs', 'dan');
    expect(r?.scope).toEqual({ kind: 'private', user: 'dan' });
    expect(r?.explicit).toBe(true);
  });

  it('"don\'t mention it to her" routes private (gift secrecy)', () => {
    const r = explicitScope(
      "remind me to collect Alina's birthday present Thursday, don't mention it to her",
      'dan',
    );
    expect(r?.scope).toEqual({ kind: 'private', user: 'dan' });
  });

  it('"tell Alina\'s brief…" from Dan routes shared', () => {
    const r = explicitScope("tell Alina's brief the plumber comes Thursday", 'dan');
    expect(r?.scope).toEqual({ kind: 'shared' });
  });

  it('"tell Dan\'s brief…" from Alina routes shared', () => {
    const r = explicitScope("tell Dan's brief I took the car to the garage", 'alina');
    expect(r?.scope).toEqual({ kind: 'shared' });
  });

  it('"add to the shared list" routes shared', () => {
    const r = explicitScope('add to the shared list: passports need renewing', 'alina');
    expect(r?.scope).toEqual({ kind: 'shared' });
  });

  it('"remember for Dylan…" routes to the child file', () => {
    const r = explicitScope('remember for Dylan: new maths tutor on Mondays', 'dan');
    expect(r?.scope).toEqual({ kind: 'child', child: 'dylan' });
  });

  it('returns null for unmarked text so the classifier decides', () => {
    expect(explicitScope('dentist moved to Tuesday', 'dan')).toBeNull();
  });
});
