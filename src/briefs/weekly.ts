import type { EventLog } from '../log/eventLog.js';
import type { Repos } from '../db/repos.js';
import type { LlmClient } from '../llm/client.js';
import type { Outbound } from '../send/outbound.js';
import type { MemoryStore } from '../memory/store.js';
import { composeBrief } from './compose.js';
import { modelSuggestions } from '../modelwatch/modelwatch.js';
import type { User } from '../types/domain.js';
import { CHILDREN, USERS } from '../types/domain.js';
import { type Clock, riyadhDate, riyadhIso, systemClock } from '../util/time.js';

const DAY_MS = 86_400_000;

/**
 * Sunday 20:00 rollup, both users. Intent vs outcome, open items ageing,
 * child-time pattern per boy as counts (never percentages framed as scores —
 * hard rule 8), quarter-plan check-in one line per boy. Tone: mirror, not
 * judge. Dan's copy additionally carries adherence decay (PRD §11) and the
 * model-watch suggestions.
 */
export class WeeklyRollup {
  constructor(
    private readonly deps: {
      log: EventLog;
      repos: Repos;
      llm: LlmClient;
      outbound: Outbound;
      memory: MemoryStore;
      clock?: Clock;
    },
  ) {}

  private get clock(): Clock {
    return this.deps.clock ?? systemClock;
  }

  async send(): Promise<void> {
    for (const user of USERS) {
      await this.sendFor(user);
    }
  }

  private async sendFor(user: User): Promise<void> {
    const d = this.deps;
    const now = this.clock.now();
    const today = riyadhDate(now);
    const weekAgoIso = riyadhIso(new Date(now.getTime() - 7 * DAY_MS));
    const weekAgoDate = riyadhDate(new Date(now.getTime() - 7 * DAY_MS));

    // intent vs outcome across the week
    const confirms = d.repos
      .eventsSince(weekAgoIso, ['confirm_res'])
      .map((e) => (e.payload as { answer?: string }).answer);
    const proposalsAnswered = {
      confirmed: confirms.filter((a) => a === 'yes').length,
      declined: confirms.filter((a) => a === 'no').length,
    };
    const itemsCreated = d.repos
      .eventsSince(weekAgoIso, ['intent'])
      .filter((e) => (e.payload as { op?: string }).op === 'create').length;
    const itemsCompleted = d.repos
      .eventsSince(weekAgoIso, ['intent'])
      .filter((e) => (e.payload as { op?: string }).op === 'complete').length;

    // open items ageing
    const ageing = d.repos
      .openItems()
      .filter((i) => new Date(i.sourceEvent).getTime() < now.getTime() - 7 * DAY_MS)
      .map((i) => i.title);

    // child-time counts per boy, plain counts only
    const counts = d.repos.childTimeCounts(weekAgoDate, today);
    const childPattern: Record<string, string> = {};
    for (const child of CHILDREN) {
      const forChild = counts.filter((c) => c.child === child);
      const fmt = (level: string) => forChild.find((c) => c.level === level)?.days ?? 0;
      childPattern[child] = `proper ${fmt('proper')}, some ${fmt('some')}, none ${fmt('none')}`;
    }

    // quarter plan check-in: first line of each boy's quarter plan
    const quarterPlans: Record<string, string> = {};
    for (const child of CHILDREN) {
      const content = d.memory.activeChildFile(child);
      const planSection = content.split('## Quarter plan')[1]?.split('##')[0] ?? '';
      const firstLine = planSection
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('- '));
      quarterPlans[child] = firstLine?.slice(2) ?? 'no quarter plan set yet';
    }

    const sections: Record<string, unknown> = {
      week: `${weekAgoDate} to ${today}`,
      intentVsOutcome: `${proposalsAnswered.confirmed} confirmed, ${proposalsAnswered.declined} declined; ${itemsCreated} items opened, ${itemsCompleted} closed`,
      openItemsOlderThanAWeek: ageing,
      childTimeCounts: childPattern,
      quarterPlanCheckIn: quarterPlans,
    };

    if (user === 'dan') {
      const adherence = this.adherence(now);
      if (adherence) sections.adherence = adherence;
      const suggestions = modelSuggestions(d.repos, weekAgoIso);
      if (suggestions.length > 0) sections.modelWatch = suggestions;
    }

    const text = await composeBrief(d.llm, d.log, {
      briefType: 'weekly',
      user,
      date: today,
      sections,
    });
    await d.outbound.send(user, { text }, { scheduled: true });
    d.log.append({
      actor: 'walle',
      chat: user,
      type: 'trigger',
      payload: { kind: 'brief_sent', user, briefType: 'weekly' },
    });
  }

  /**
   * Adherence decay (PRD §11): reply rate over the last 14 days below 70%
   * surfaces in Dan's rollup with the single suggestion "shorten the
   * prompts", nothing else. A day counts as replied when the user sent
   * anything on a day Wall-E initiated.
   */
  private adherence(now: Date): string | null {
    const d = this.deps;
    const fromIso = riyadhIso(new Date(now.getTime() - 14 * DAY_MS));
    const events = d.repos.eventsSince(fromIso, ['trigger', 'msg_in']);
    const lines: string[] = [];
    for (const user of USERS) {
      const briefDays = new Set(
        events
          .filter(
            (e) =>
              e.type === 'trigger' &&
              (e.payload as { kind?: string }).kind === 'brief_sent' &&
              (e.payload as { user?: string }).user === user,
          )
          .map((e) => e.ts.slice(0, 10)),
      );
      if (briefDays.size < 5) continue; // not enough signal yet
      const replyDays = new Set(
        events.filter((e) => e.type === 'msg_in' && e.chat === user).map((e) => e.ts.slice(0, 10)),
      );
      const replied = [...briefDays].filter((day) => replyDays.has(day)).length;
      const rate = replied / briefDays.size;
      if (rate < 0.7) {
        lines.push(
          `${user === 'dan' ? 'Your' : "Alina's"} reply rate is ${replied}/${briefDays.size} days over two weeks. Suggestion: shorten the prompts.`,
        );
      }
    }
    return lines.length > 0 ? lines.join(' ') : null;
  }
}
