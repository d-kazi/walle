import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { WeekTemplate } from '../src/week/template.js';
import { parseWebhookPayload } from '../src/channel/whatsapp/parser.js';
import { FakeLlm } from './fakes.js';
import { textPayload } from './fixtures/webhook.js';
import { FakeClock, cleanup, tmpDataDir } from './helpers.js';
import { WA_DAN, makeFullStack } from './stack.js';

describe('standing week', () => {
  let dir: string;
  let clock: FakeClock;
  beforeEach(() => {
    dir = tmpDataDir();
    clock = new FakeClock(new Date('2026-08-24T05:00:00Z'));
  });
  afterEach(() => cleanup(dir));

  it('starts empty, and every unknown day is a gap', () => {
    const week = new WeekTemplate(dir);
    expect(week.isEmpty()).toBe(true);
    expect(week.render()).toBe('(not set up yet)');
    // three children, seven days
    expect(week.gaps()).toHaveLength(21);
    expect(week.gaps()[0]?.missing).toBe('nothing known about this day');
  });

  it('a described day stops being a gap; a school day with no pick-up stays one', () => {
    const week = new WeekTemplate(dir);
    week.setDay('dylan', 2, {
      school: true,
      start: '07:30',
      end: '15:00',
      activities: [{ name: 'swimming', kit: ['trunks', 'towel'] }],
      pickUp: 'alina',
    });
    // described and answered: gone from the gap list
    expect(week.gaps().some((g) => g.child === 'dylan' && g.weekday === 2)).toBe(false);

    week.setDay('dylan', 1, { school: true, activities: [] });
    const pickUpGap = week.gaps().find((g) => g.child === 'dylan' && g.weekday === 1);
    expect(pickUpGap?.missing).toBe('who collects');

    // a weekend with nothing on is described, not unknown
    week.setDay('dylan', 5, { school: false, activities: [] });
    expect(week.gaps().some((g) => g.child === 'dylan' && g.weekday === 5)).toBe(false);
  });

  it('renders the kit, which is the part a parent actually needs', () => {
    const week = new WeekTemplate(dir);
    week.setDay('dylan', 2, {
      school: true,
      start: '07:30',
      end: '15:00',
      activities: [{ name: 'swimming', from: '15:30', kit: ['trunks', 'towel'] }],
      pickUp: 'alina',
    });
    const text = week.render();
    expect(text).toContain('Dylan:');
    expect(text).toContain('Tuesday: school 07:30–15:00; swimming 15:30 (take trunks, towel); pick-up alina');
    expect(week.describeDay('dylan', 2)).toContain('trunks, towel');
    expect(week.describeDay('dylan', 3)).toBeNull();
  });

  it('survives a corrupt or missing file rather than taking the service down', () => {
    const week = new WeekTemplate(dir);
    week.setDay('maxie', 0, { school: false, activities: [] });
    fs.writeFileSync(`${dir}/memory/week.json`, '{ not json');
    expect(week.isEmpty()).toBe(true);
    expect(week.gaps()).toHaveLength(21);
  });

  it('the model fills it through a tool, and it reaches the next prompt', async () => {
    const stack = makeFullStack(dir, clock);
    stack.llm.on(
      'assistant',
      FakeLlm.toolCall('set_standing_week_day', {
        child: 'dylan',
        weekday: 'Tuesday',
        school: true,
        start: '07:30',
        end: '15:00',
        activities: [{ name: 'swimming', kit: ['trunks', 'towel'] }],
        pickUp: 'alina',
      }),
      'Noted. Dylan swims on Tuesdays, Alina collects.',
    );
    await stack.ingress.process(
      parseWebhookPayload(
        textPayload(WA_DAN, 'wamid.wk1', 'dylan swims tuesdays, alina picks him up'),
      ),
    );
    expect(stack.week.describeDay('dylan', 2)).toContain('swimming');

    // the next turn sees it in the system prompt without asking for it
    let system = '';
    stack.llm.on('assistant', (opts) => {
      system = String(opts.messages[0]?.content ?? '');
      return 'Trunks and towel.';
    });
    await stack.ingress.process(
      parseWebhookPayload(textPayload(WA_DAN, 'wamid.wk2', 'what does dylan need tuesday?')),
    );
    expect(system).toContain('## The standing week');
    expect(system).toContain('trunks, towel');
  });
});
