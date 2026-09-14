import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Prober } from '../src/scheduler/probe.js';
import { parseWebhookPayload } from '../src/channel/whatsapp/parser.js';
import { textPayload } from './fixtures/webhook.js';
import { FakeClock, cleanup, tmpDataDir } from './helpers.js';
import { WA_DAN, makeFullStack } from './stack.js';

describe('probe alerts', () => {
  let dir: string;
  let clock: FakeClock;
  beforeEach(() => {
    dir = tmpDataDir();
    clock = new FakeClock(new Date('2026-08-24T05:00:00Z'));
  });
  afterEach(() => cleanup(dir));

  it('tells Dan once per outage, with a hint, not once per poll', async () => {
    const stack = makeFullStack(dir, clock);
    // open Dan's window so the alert can go out freeform
    stack.llm.on('assistant', 'Morning.');
    await stack.ingress.process(parseWebhookPayload(textPayload(WA_DAN, 'wamid.w1', 'morning')));
    stack.sender.sent = [];

    const prober = new Prober(stack.log, stack.outbound, stack.sender, stack.calendar, stack.forwardInbox);
    stack.forwardInbox.probeOk = false;

    // four consecutive 15-minute polls with the mailbox down: one message
    for (let i = 0; i < 4; i++) {
      const r = await prober.probe('Mail poll', ['mail']);
      expect(r.failed).toEqual(['mail']);
    }
    expect(stack.sender.sent).toHaveLength(1);
    expect(stack.sender.sent[0]?.text).toContain('Gmail API');
    expect(stack.sender.sent[0]?.text).not.toContain('running blind');

    // it recovers, then fails again: told again
    stack.forwardInbox.probeOk = true;
    expect((await prober.probe('Mail poll', ['mail'])).ok).toBe(true);
    stack.forwardInbox.probeOk = false;
    await prober.probe('Mail poll', ['mail']);
    expect(stack.sender.sent).toHaveLength(2);

    // every probe is still logged, alert or not
    const probes = (await stack.events()).filter((e) => e.type === 'probe');
    expect(probes).toHaveLength(6);
  });
});
