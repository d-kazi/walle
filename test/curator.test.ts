import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Curator } from '../src/memory/curator.js';
import { parseWebhookPayload } from '../src/channel/whatsapp/parser.js';
import { FakeClock, cleanup, tmpDataDir } from './helpers.js';
import { textPayload } from './fixtures/webhook.js';
import { WA_ALINA, WA_DAN, makeFullStack, type FullStack } from './stack.js';

function makeCurator(stack: FullStack, dir: string): Curator {
  return new Curator({
    log: stack.log,
    llm: stack.llm,
    memory: stack.memory,
    logDir: path.join(dir, 'log'),
  });
}

describe('curator', () => {
  let dir: string;
  let clock: FakeClock;
  beforeEach(() => {
    dir = tmpDataDir();
    clock = new FakeClock(new Date('2026-08-24T05:00:00Z'));
  });
  afterEach(() => cleanup(dir));

  it('supersedes a changed fact so the old value is never re-served', async () => {
    const stack = makeFullStack(dir, clock);
    stack.memory.add({ kind: 'shared' }, 'School pickup is 15:00', '2026-08-01');

    stack.llm.on('assistant', 'Noted, pickup is 14:30 from September.');
    await stack.ingress.process(
      parseWebhookPayload(textPayload(WA_DAN, 'wamid.c1', 'school moved pickup to 14:30 from September')),
    );

    stack.llm.on('curator', (opts) => {
      // the curator sees current memory and the day's chat
      const user = String(opts.messages.at(-1)?.content ?? '');
      expect(user).toContain('School pickup is 15:00');
      expect(user).toContain('moved pickup to 14:30');
      return JSON.stringify({
        changes: [
          { op: 'supersede', scope: 'shared', child: null, match: 'pickup is 15:00', text: 'School pickup is 14:30' },
        ],
      });
    });
    await makeCurator(stack, dir).runForDate('2026-08-24');

    const active = stack.memory.activeFacts({ kind: 'shared' });
    expect(active.join()).toContain('14:30');
    expect(active.join()).not.toContain('15:00');
    const events = await stack.events();
    const memOps = events.filter(
      (e) => e.type === 'memory_op' && (e.payload as { source?: string }).source === 'curator',
    );
    expect(memOps).toHaveLength(1);
    expect((memOps[0]?.payload as { op?: string }).op).toBe('supersede');
  });

  it('pins "private" to the chat being curated, never the other user', async () => {
    const stack = makeFullStack(dir, clock);
    stack.llm.on('assistant', 'Understood.');
    await stack.ingress.process(
      parseWebhookPayload(textPayload(WA_ALINA, 'wamid.c2', 'thinking about a surprise trip for Dan')),
    );
    // a confused model claims scope private with no user; code pins it to alina
    stack.llm.on(
      'curator',
      JSON.stringify({
        changes: [
          { op: 'add', scope: 'private', child: null, match: null, text: 'Planning a surprise trip for Dan' },
        ],
      }),
    );
    await makeCurator(stack, dir).runForDate('2026-08-24');
    expect(stack.memory.activeFacts({ kind: 'private', user: 'alina' }).join()).toContain('surprise');
    expect(stack.memory.activeFacts({ kind: 'private', user: 'dan' })).toHaveLength(0);
    expect(stack.memory.activeFacts({ kind: 'shared' })).toHaveLength(0);
  });

  it('does nothing on a day with no chat and never sends messages', async () => {
    const stack = makeFullStack(dir, clock);
    await makeCurator(stack, dir).runForDate('2026-08-24');
    expect(stack.sender.sent).toHaveLength(0);
    expect(stack.llm.calls.filter((c) => c.task === 'curator')).toHaveLength(0);
  });
});
