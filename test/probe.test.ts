import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Prober } from '../src/scheduler/probe.js';
import { Briefs } from '../src/briefs/briefs.js';
import { parseWebhookPayload } from '../src/channel/whatsapp/parser.js';
import { textPayload } from './fixtures/webhook.js';
import { FakeClock, cleanup, tmpDataDir } from './helpers.js';
import { WA_ALINA, WA_DAN, makeFullStack } from './stack.js';

describe('outages', () => {
  let dir: string;
  let clock: FakeClock;
  beforeEach(() => {
    dir = tmpDataDir();
    clock = new FakeClock(new Date('2026-08-24T02:00:00Z')); // 05:00 Riyadh
  });
  afterEach(() => cleanup(dir));

  it('a failing dependency never messages anyone on its own; it is one line in the morning brief', async () => {
    const stack = makeFullStack(dir, clock);
    stack.llm.on('assistant', 'Morning.');
    for (const [wa, id] of [[WA_DAN, 'w1'], [WA_ALINA, 'w2']] as const) {
      await stack.ingress.process(parseWebhookPayload(textPayload(wa, `wamid.${id}`, 'morning')));
    }
    stack.sender.sent = [];

    const prober = new Prober(stack.log, stack.sender, stack.calendar, stack.forwardInbox);
    stack.forwardInbox.probeOk = false;
    for (let i = 0; i < 4; i++) {
      clock.advance(15 * 60_000);
      expect((await prober.probe('Mail poll', ['mail'])).failed).toEqual(['mail']);
    }
    // nothing sent, everything logged
    expect(stack.sender.sent).toHaveLength(0);
    expect((await stack.events()).filter((e) => e.type === 'probe')).toHaveLength(4);

    // the outage is known, with the time it started
    const outages = stack.repos.outages('2026-08-24T00:00:00+03:00');
    expect(outages).toHaveLength(1);
    expect(outages[0]?.need).toBe('mail');
    expect(outages[0]?.since.slice(0, 16)).toBe('2026-08-24T05:15');

    // morning brief: Dan gets the line, Alina does not
    let inputs: Record<string, string> = {};
    stack.llm.on('brief_morning', (opts) => {
      const content = String(opts.messages.at(-1)?.content ?? '');
      const forUser = /brief for (Dan|Alina)/.exec(content)?.[1]?.toLowerCase() ?? 'unknown';
      inputs[forUser] = content;
      return 'Morning.';
    });
    const briefs = new Briefs({
      log: stack.log,
      repos: stack.repos,
      llm: stack.llm,
      outbound: stack.outbound,
      ledger: stack.ledger,
      calendar: stack.calendar,
      clock,
    });
    clock.set(new Date('2026-08-24T03:30:00Z')); // 06:30 Riyadh
    await briefs.sendMorning('dan');
    await briefs.sendMorning('alina');
    expect(inputs.dan).toContain('the Wall-E inbox unreachable since 2026-08-24 05:15');
    expect(inputs.alina).not.toContain('systems');

    // once it recovers, the next brief carries nothing
    stack.forwardInbox.probeOk = true;
    await prober.probe('Mail poll', ['mail']);
    expect(stack.repos.outages('2026-08-24T00:00:00+03:00')).toHaveLength(0);
  });
});
