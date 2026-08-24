import type { Repos } from '../db/repos.js';
import type { EventLog } from '../log/eventLog.js';
import type { LlmClient } from '../llm/client.js';
import type { Outbound } from '../send/outbound.js';
import type { LedgerReader } from '../ledger/read.js';
import type { CalendarService, CalendarEvent } from '../google/types.js';
import type { User } from '../types/domain.js';
import { USERS, otherUser } from '../types/domain.js';
import { composeBrief } from './compose.js';
import { sharedAdditionsSince } from './sinceLastBrief.js';
import { nudgesOwed } from '../school/chase.js';
import { describeProposal } from '../assistant/confirmations.js';
import { type Clock, riyadhDate, riyadhIso, systemClock } from '../util/time.js';

const DAY_MS = 86_400_000;

/**
 * Morning (06:30), evening (21:00) and midday-conditional briefs. Each build
 * is per-user; shared-only content from the other adult, never their raw
 * words (structural: the input carries only shared-scoped events).
 */
export class Briefs {
  constructor(
    private readonly deps: {
      log: EventLog;
      repos: Repos;
      llm: LlmClient;
      outbound: Outbound;
      ledger: LedgerReader;
      calendar: CalendarService;
      clock?: Clock;
    },
  ) {}

  private get clock(): Clock {
    return this.deps.clock ?? systemClock;
  }

  private async calendarBetween(fromMs: number, toMs: number): Promise<CalendarEvent[]> {
    const { calendar } = this.deps;
    const from = riyadhIso(new Date(fromMs));
    const to = riyadhIso(new Date(toMs));
    const all: CalendarEvent[] = [];
    for (const user of USERS) {
      try {
        all.push(...(await calendar.listEvents(user, from, to)));
      } catch {
        // probe already reported; brief proceeds with what works
      }
    }
    return all.sort((a, b) => a.start.localeCompare(b.start));
  }

  async sendMorning(user: User): Promise<void> {
    const d = this.deps;
    const now = this.clock.now();
    const today = riyadhDate(now);
    const startOfDay = Date.parse(`${today}T00:00:00+03:00`);

    const events = await this.calendarBetween(startOfDay, startOfDay + DAY_MS);
    const items = d.repos.openItems();
    const nudges = nudgesOwed(items, today);
    for (const n of nudges) {
      d.log.append({
        actor: 'system',
        chat: user,
        type: 'trigger',
        payload: { kind: 'nudge', itemId: n.item.id, stage: n.stage },
      });
    }
    const additions = sharedAdditionsSince(d.repos, user);
    const pending = d.repos.pendingProposalsFor(user);
    const expired = d.repos.expiredUnnotifiedProposals();
    for (const p of expired) {
      d.log.append({
        actor: 'system',
        chat: null,
        type: 'trigger',
        payload: { kind: 'proposal_expiry_notified', proposalId: p.id },
      });
    }

    const yesterday = riyadhDate(new Date(now.getTime() - DAY_MS));
    const eveningSentYesterday = d.repos.lastBriefTs(user, 'evening')?.slice(0, 10) === yesterday;
    const answeredYesterday = d.repos
      .childTimeForDate(yesterday)
      .some((r) => r.reporter === user);
    const childTimeReminder = eveningSentYesterday && !answeredYesterday;

    const ledger = d.ledger.read();
    let ledgerLine: string | null = null;
    let ledgerStale = false;
    if (ledger.summary) {
      if (ledger.fresh) {
        const total = Object.values(ledger.summary.monthToDate).reduce((a, b) => a + b, 0);
        ledgerLine = `SAR ${Math.round(total)} month to date`;
      } else if (!d.repos.hasTrigger('ledger_stale_mentioned', ledger.summary.lastSync)) {
        ledgerStale = true;
        d.log.append({
          actor: 'system',
          chat: user,
          type: 'trigger',
          payload: { kind: 'ledger_stale_mentioned', lastSync: ledger.summary.lastSync },
        });
      }
    }

    const text = await composeBrief(d.llm, d.log, {
      briefType: 'morning',
      user,
      date: today,
      sections: {
        calendarToday: events.map((e) => `${e.start.slice(11, 16)} ${e.title} (${e.calendar})`),
        openItemsDueSoon: items
          .filter((i) => i.due)
          .map((i) => `${i.title}, due ${i.due}${i.child ? `, ${i.child}` : ''}`),
        chase: nudges.map((n) => `${n.item.title} (${n.stage})`),
        [`${cap(otherUser(user))}Added`]: additions.map((a) => a.text),
        awaitingYourConfirmation: pending.map(describeProposal),
        expiredUnanswered: expired.map(describeProposal),
        ...(childTimeReminder ? { unansweredChildTimeFromYesterday: 'true' } : {}),
        ...(ledgerLine ? { spending: ledgerLine } : {}),
        ...(ledgerStale ? { ledgerStale: 'the spending sync has not run for a few days' } : {}),
      },
    });

    await d.outbound.send(user, { text }, { scheduled: true });
    d.log.append({
      actor: 'walle',
      chat: user,
      type: 'trigger',
      payload: { kind: 'brief_sent', user, briefType: 'morning' },
    });
  }

  async sendEvening(user: User): Promise<void> {
    const d = this.deps;
    const now = this.clock.now();
    const today = riyadhDate(now);
    const startOfTomorrow = Date.parse(`${today}T00:00:00+03:00`) + DAY_MS;

    const events = await this.calendarBetween(startOfTomorrow, startOfTomorrow + DAY_MS);
    const pending = d.repos.pendingProposalsFor(user);

    const text = await composeBrief(d.llm, d.log, {
      briefType: 'evening',
      user,
      date: today,
      sections: {
        tomorrow: events.map((e) => `${e.start.slice(11, 16)} ${e.title} (${e.calendar})`),
        unconfirmedProposals: pending.map(describeProposal),
        childTimeQuestion: 'ask it, verbatim, as the closing line',
      },
    });

    await d.outbound.send(user, { text }, { scheduled: true });
    d.log.append({
      actor: 'walle',
      chat: user,
      type: 'trigger',
      payload: { kind: 'brief_sent', user, briefType: 'evening' },
    });
  }

  /**
   * Midday conditional (poll 11:00–14:00 every 30 min). Fires only on a
   * trigger; hard cap one midday message per user per day; a quiet day is
   * total silence.
   */
  async maybeSendMidday(user: User): Promise<boolean> {
    const d = this.deps;
    const now = this.clock.now();
    const today = riyadhDate(now);
    if (d.repos.middaySentToday(user, today)) return false;

    const triggers: string[] = [];

    // 1. school item needing action before 16:00 today (pending proposal with today's deadline)
    for (const p of d.repos.pendingProposalsFor(user)) {
      const payload = p.payload as { deadline?: string; due?: string; start?: string };
      const when = payload.deadline ?? payload.due ?? payload.start;
      if (when && when.slice(0, 10) === today) {
        triggers.push(`Needs a decision today: ${describeProposal(p)}`);
      }
    }

    // 2. calendar conflict today or tomorrow
    const startOfDay = Date.parse(`${today}T00:00:00+03:00`);
    const events = await this.calendarBetween(startOfDay, startOfDay + 2 * DAY_MS);
    for (let i = 0; i < events.length - 1; i++) {
      const a = events[i]!;
      for (let j = i + 1; j < events.length; j++) {
        const b = events[j]!;
        if (b.start < a.end && a.calendar === b.calendar) {
          triggers.push(`Clash in ${cap(a.calendar)}'s calendar: ${a.title} overlaps ${b.title}`);
        }
      }
    }

    // 3. confirmed deadline expiring today still open
    for (const item of d.repos.openItems()) {
      if (item.due === today) {
        triggers.push(`Due today and still open: ${item.title}`);
      }
    }

    if (triggers.length === 0) return false;

    const text = await composeBrief(d.llm, d.log, {
      briefType: 'midday',
      user,
      date: today,
      sections: { urgent: [...new Set(triggers)].slice(0, 4) },
    });
    await d.outbound.send(user, { text }, { scheduled: true });
    d.log.append({
      actor: 'walle',
      chat: user,
      type: 'trigger',
      payload: { kind: 'midday_sent', user },
    });
    return true;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
