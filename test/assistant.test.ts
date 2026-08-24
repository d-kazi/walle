import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseWebhookPayload } from '../src/channel/whatsapp/parser.js';
import { FakeClock, cleanup, tmpDataDir } from './helpers.js';
import { FakeLlm } from './fakes.js';
import { buttonReplyPayload, textPayload } from './fixtures/webhook.js';
import { WA_ALINA, WA_DAN, makeFullStack } from './stack.js';

describe('assistant conversation', () => {
  let dir: string;
  let clock: FakeClock;
  beforeEach(() => {
    dir = tmpDataDir();
    clock = new FakeClock(new Date('2026-08-24T05:00:00Z')); // 08:00 Riyadh
  });
  afterEach(() => cleanup(dir));

  it('gift-secrecy: Dan\'s secret is stored private and never enters Alina\'s context or messages', async () => {
    const stack = makeFullStack(dir, clock);
    // model tries to store it "shared" — the explicit-phrase override must win
    stack.llm.on(
      'assistant',
      FakeLlm.toolCall('remember', {
        scope: 'shared',
        text: "Collect Alina's birthday present Thursday",
      }),
      "Done. I'll keep that to myself.",
    );

    await stack.ingress.process(
      parseWebhookPayload(
        textPayload(
          WA_DAN,
          'wamid.gift',
          "Remind me to collect Alina's birthday present Thursday, don't mention it to her",
        ),
      ),
    );

    // stored private to Dan despite the model's wrong scope
    expect(stack.memory.activeFacts({ kind: 'private', user: 'dan' }).join()).toContain('present');
    expect(stack.memory.activeFacts({ kind: 'shared' })).toHaveLength(0);
    expect(stack.memory.activeFacts({ kind: 'private', user: 'alina' })).toHaveLength(0);

    // Alina's context assembly never contains it
    stack.llm.on('assistant', 'Hello!');
    await stack.ingress.process(parseWebhookPayload(textPayload(WA_ALINA, 'wamid.a1', 'hi walle')));
    const alinaCall = stack.llm.calls.filter((c) => c.task === 'assistant').at(-1)!;
    const serialised = JSON.stringify(alinaCall.messages);
    expect(serialised).not.toContain('birthday present');

    // and nothing sent to Alina's number ever mentioned it
    for (const sent of stack.sender.sent.filter((s) => s.to === WA_ALINA)) {
      expect(sent.text).not.toContain('present');
    }
  });

  it('routes an unmarked fact via the remember tool with model-chosen scope', async () => {
    const stack = makeFullStack(dir, clock);
    stack.llm.on(
      'assistant',
      FakeLlm.toolCall('remember', { scope: 'shared', text: 'Dentist moved to Tuesday' }),
      'Noted, dentist is Tuesday now.',
    );
    await stack.ingress.process(
      parseWebhookPayload(textPayload(WA_ALINA, 'wamid.d1', 'dentist moved to Tuesday')),
    );
    expect(stack.memory.activeFacts({ kind: 'shared' }).join()).toContain('Dentist');
    const reply = stack.sender.sent.find((s) => s.to === WA_ALINA);
    expect(reply?.text).toContain('Tuesday');
  });

  it('Tier 2: calendar events go proposal → buttons → Yes → write, never direct', async () => {
    const stack = makeFullStack(dir, clock);
    stack.llm.on(
      'assistant',
      FakeLlm.toolCall('propose_calendar_event', {
        title: 'Swimming gala',
        start: '2026-08-27T15:00:00+03:00',
        end: '2026-08-27T17:00:00+03:00',
        calendar: 'alina',
      }),
      "I've proposed it; confirm with the buttons.",
    );
    await stack.ingress.process(
      parseWebhookPayload(textPayload(WA_ALINA, 'wamid.c1', 'gala thursday 3pm, add it')),
    );

    // nothing written yet
    expect(stack.calendar.created).toHaveLength(0);
    const proposalMsg = stack.sender.sent.find((s) => s.mode === 'buttons');
    expect(proposalMsg?.to).toBe(WA_ALINA);
    const yesId = proposalMsg?.buttons?.find((b) => b.title === 'Yes')?.id;
    expect(yesId).toMatch(/^p:[a-z0-9-]+:yes$/);

    // tap Yes
    await stack.ingress.process(
      parseWebhookPayload(buttonReplyPayload(WA_ALINA, 'wamid.c2', yesId!, 'Yes')),
    );
    expect(stack.calendar.created).toHaveLength(1);
    expect(stack.calendar.created[0]?.title).toBe('Swimming gala');
    const done = stack.sender.sent.at(-1);
    expect(done?.text).toContain('calendar');
  });

  it('plain-text "yes" confirms the most recent pending proposal', async () => {
    const stack = makeFullStack(dir, clock);
    await stack.confirmations.propose(
      'open_item',
      { title: 'Sign the trip form', due: '2026-08-28' },
      'dan',
      'Track the trip form?',
    );
    await stack.ingress.process(parseWebhookPayload(textPayload(WA_DAN, 'wamid.y1', 'yes')));
    expect(stack.repos.openItems().some((i) => i.title === 'Sign the trip form')).toBe(true);
  });

  it('Change flow: button → free text → revised proposal via the assistant', async () => {
    const stack = makeFullStack(dir, clock);
    const id = await stack.confirmations.propose(
      'calendar_event',
      { title: 'Gala', start: '2026-08-27T15:00:00+03:00', end: '2026-08-27T16:00:00+03:00', calendar: 'dan' },
      'dan',
      'Add the gala?',
    );
    await stack.ingress.process(
      parseWebhookPayload(buttonReplyPayload(WA_DAN, 'wamid.ch1', `p:${id}:change`, 'Change')),
    );
    expect(stack.sender.sent.at(-1)?.text).toContain('instead');

    stack.llm.on(
      'assistant',
      FakeLlm.toolCall('propose_calendar_event', {
        title: 'Gala',
        start: '2026-08-27T16:00:00+03:00',
        end: '2026-08-27T17:00:00+03:00',
        calendar: 'dan',
      }),
      'Proposed the later time.',
    );
    await stack.ingress.process(
      parseWebhookPayload(textPayload(WA_DAN, 'wamid.ch2', 'make it 4pm not 3pm')),
    );
    // old proposal superseded, a fresh pending one exists
    expect(stack.repos.proposal(id)?.status).toBe('superseded');
    expect(stack.repos.pendingProposalsFor('dan')).toHaveLength(1);
  });

  it('second parent tapping an answered proposal is told who sorted it', async () => {
    const stack = makeFullStack(dir, clock);
    const id = await stack.confirmations.propose(
      'open_item',
      { title: 'Book dentist' },
      'both',
      'Track booking the dentist?',
    );
    await stack.ingress.process(
      parseWebhookPayload(buttonReplyPayload(WA_ALINA, 'wamid.b1', `p:${id}:yes`, 'Yes')),
    );
    await stack.ingress.process(
      parseWebhookPayload(buttonReplyPayload(WA_DAN, 'wamid.b2', `p:${id}:yes`, 'Yes')),
    );
    expect(stack.sender.sent.at(-1)?.to).toBe(WA_DAN);
    expect(stack.sender.sent.at(-1)?.text).toContain('Alina');
  });
});
