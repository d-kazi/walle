import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Briefs } from '../src/briefs/briefs.js';
import { sharedAdditionsSince } from '../src/briefs/sinceLastBrief.js';
import { nudgesOwed } from '../src/school/chase.js';
import { parseWebhookPayload } from '../src/channel/whatsapp/parser.js';
import { FakeClock, cleanup, tmpDataDir } from './helpers.js';
import { FakeLlm } from './fakes.js';
import { textPayload } from './fixtures/webhook.js';
import { WA_ALINA, WA_DAN, makeFullStack, type FullStack } from './stack.js';
import type { OpenItem } from '../src/types/domain.js';

function makeBriefs(stack: FullStack, clock: FakeClock): Briefs {
  return new Briefs({
    log: stack.log,
    repos: stack.repos,
    llm: stack.llm,
    outbound: stack.outbound,
    ledger: stack.ledger,
    calendar: stack.calendar,
    clock,
  });
}

function item(partial: Partial<OpenItem> & { id: string; title: string }): OpenItem {
  return {
    owner: 'both',
    child: null,
    due: null,
    sourceEvent: 't0',
    status: 'open',
    lastNudge: null,
    ...partial,
  };
}

describe('chase calculus', () => {
  it('nudges at T-3d, T-1d, morning-of and overdue, once per day', () => {
    const items = [
      item({ id: 'a', title: 'far away', due: '2026-09-30' }),
      item({ id: 'b', title: 'three days', due: '2026-08-27' }),
      item({ id: 'c', title: 'tomorrow', due: '2026-08-25' }),
      item({ id: 'd', title: 'today', due: '2026-08-24' }),
      item({ id: 'e', title: 'missed', due: '2026-08-20' }),
      item({ id: 'f', title: 'already nudged', due: '2026-08-24', lastNudge: '2026-08-24T06:30:00+03:00' }),
      item({ id: 'g', title: 'done', due: '2026-08-24', status: 'done' }),
    ];
    const nudges = nudgesOwed(items, '2026-08-24');
    expect(nudges.map((n) => [n.item.id, n.stage])).toEqual([
      ['b', 'T-3d'],
      ['c', 'T-1d'],
      ['d', 'morning-of'],
      ['e', 'overdue'],
    ]);
  });
});

describe('briefs', () => {
  let dir: string;
  let clock: FakeClock;
  beforeEach(() => {
    dir = tmpDataDir();
    clock = new FakeClock(new Date('2026-08-24T03:30:00Z')); // 06:30 Riyadh
  });
  afterEach(() => cleanup(dir));

  it('say-it-once: a shared fact from Dan reaches Alina\'s next morning brief input', async () => {
    const stack = makeFullStack(dir, clock);
    stack.llm.on(
      'assistant',
      FakeLlm.toolCall('remember', { scope: 'shared', text: 'Plumber comes Thursday 2-4' }),
      'Noted.',
    );
    stack.llm.on('brief_morning', (opts) => {
      // the composer input must carry Dan's addition for Alina
      return `Morning. ${JSON.stringify(opts.messages.at(-1)?.content).includes('Plumber') ? 'Dan added: plumber Thursday 2-4.' : 'Nothing new.'}`;
    });

    await stack.ingress.process(
      parseWebhookPayload(textPayload(WA_DAN, 'wamid.p1', "tell Alina's brief the plumber comes Thursday 2-4")),
    );

    const briefs = makeBriefs(stack, clock);
    await briefs.sendMorning('alina');
    const sent = stack.sender.sent.find((s) => s.to === WA_ALINA);
    expect(sent?.text).toContain('plumber');

    // and the reverse direction: watermark now set, nothing re-served next time
    expect(sharedAdditionsSince(stack.repos, 'alina')).toHaveLength(0);
  });

  it('privacy: Dan\'s private capture never reaches Alina\'s brief input', async () => {
    const stack = makeFullStack(dir, clock);
    stack.llm.on(
      'assistant',
      FakeLlm.toolCall('remember', { scope: 'private', text: "Collect Alina's present" }),
      'Kept to myself.',
    );
    await stack.ingress.process(
      parseWebhookPayload(textPayload(WA_DAN, 'wamid.p2', "just for me: collect Alina's present Thursday")),
    );

    let alinaInput = '';
    stack.llm.on('brief_morning', (opts) => {
      alinaInput = String(opts.messages.at(-1)?.content ?? '');
      return 'Morning. Quiet one.';
    });
    await makeBriefs(stack, clock).sendMorning('alina');
    expect(alinaInput).not.toContain('present');
  });

  it('evening brief ends with the child-time question and the answer is captured', async () => {
    const stack = makeFullStack(dir, clock);
    stack.llm.on('brief_evening', 'Tomorrow looks light. Roughly, today: Dylan / Caspian / Maxie — proper, some, or none?');
    const briefs = makeBriefs(stack, clock);
    clock.set(new Date('2026-08-24T18:00:00Z')); // 21:00 Riyadh
    await briefs.sendEvening('dan');
    expect(stack.sender.sent.at(-1)?.text).toContain('proper, some, or none');

    stack.llm.on('child_time_parse', JSON.stringify({ isAnswer: true, dylan: 'proper', caspian: 'some', maxie: 'none' }));
    await stack.ingress.process(parseWebhookPayload(textPayload(WA_DAN, 'wamid.ct1', 'proper with D, some Cas, none Maxie')));
    const rows = stack.repos.childTimeForDate('2026-08-24');
    expect(rows).toHaveLength(3);
    expect(stack.sender.sent.at(-1)?.text).toBe('Noted.');
  });

  it('morning brief includes one gentle reminder when yesterday went unanswered, then drops it', async () => {
    const stack = makeFullStack(dir, clock);
    stack.llm.on('brief_evening', 'Evening. Roughly, today: Dylan / Caspian / Maxie — proper, some, or none?');
    clock.set(new Date('2026-08-24T18:00:00Z'));
    await makeBriefs(stack, clock).sendEvening('dan');

    let sawReminder = false;
    stack.llm.on('brief_morning', (opts) => {
      sawReminder = String(opts.messages.at(-1)?.content ?? '').includes('unansweredChildTime');
      return 'Morning.';
    });
    clock.set(new Date('2026-08-25T03:30:00Z')); // next morning
    await makeBriefs(stack, clock).sendMorning('dan');
    expect(sawReminder).toBe(true);
  });

  it('midday: a quiet day produces zero messages', async () => {
    const stack = makeFullStack(dir, clock);
    clock.set(new Date('2026-08-24T08:30:00Z')); // 11:30 Riyadh
    const briefs = makeBriefs(stack, clock);
    expect(await briefs.maybeSendMidday('dan')).toBe(false);
    expect(await briefs.maybeSendMidday('alina')).toBe(false);
    expect(stack.sender.sent).toHaveLength(0);
  });

  it('midday: fires once on a deadline due today, capped at one per user per day', async () => {
    const stack = makeFullStack(dir, clock);
    stack.log.append({
      actor: 'walle',
      chat: null,
      type: 'intent',
      payload: {
        kind: 'open_item',
        op: 'create',
        item: { id: 'oi-due', title: 'Trip form', owner: 'both', child: 'dylan', due: '2026-08-24' },
      },
    });
    stack.llm.on('brief_midday', 'The trip form is due today and still open.');
    clock.set(new Date('2026-08-24T08:30:00Z'));
    const briefs = makeBriefs(stack, clock);
    expect(await briefs.maybeSendMidday('dan')).toBe(true);
    expect(await briefs.maybeSendMidday('dan')).toBe(false); // cap
    expect(stack.sender.sent.filter((s) => s.to === WA_DAN)).toHaveLength(1);
  });

  it('ledger: fresh summary lands in the brief, stale is mentioned exactly once', async () => {
    const stack = makeFullStack(dir, clock);
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(dir, 'ledger'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ledger', 'summary.json'),
      JSON.stringify({
        lastSync: '2026-08-23T23:00:00+03:00',
        monthToDate: { groceries: 3200, school: 1500 },
        notableDeltas: [],
      }),
    );
    let input = '';
    stack.llm.on('brief_morning', (opts) => {
      input = String(opts.messages.at(-1)?.content ?? '');
      return 'Morning.';
    });
    await makeBriefs(stack, clock).sendMorning('dan');
    expect(input).toContain('4700');

    // four days later, stale: mentioned once, then never again
    clock.set(new Date('2026-08-28T03:30:00Z'));
    await makeBriefs(stack, clock).sendMorning('dan');
    expect(input).toContain('ledgerStale');
    await makeBriefs(stack, clock).sendMorning('alina');
    expect(input).not.toContain('ledgerStale');
  });

  it('composer falls back to a deterministic brief when the model is down', async () => {
    const stack = makeFullStack(dir, clock);
    stack.llm.on('brief_morning', () => {
      throw new Error('model down');
    });
    await makeBriefs(stack, clock).sendMorning('dan');
    const sent = stack.sender.sent.at(-1);
    expect(sent?.text.length).toBeGreaterThan(0);
    const events = await stack.events();
    expect(events.some((e) => e.type === 'error' && (e.payload as { kind?: string }).kind === 'brief_compose_failed')).toBe(true);
    // the brief still went out and was recorded
    expect(stack.repos.lastBriefTs('dan', 'morning')).not.toBeNull();
  });
});
