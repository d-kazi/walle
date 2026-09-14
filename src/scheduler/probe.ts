import type { ChannelSender } from '../channel/types.js';
import type { CalendarService, ForwardInbox } from '../google/types.js';
import type { EventLog } from '../log/eventLog.js';
import type { Outbound } from '../send/outbound.js';

export type ProbeNeed = 'whatsapp' | 'calendar' | 'mail';

export interface ProbeResult {
  ok: boolean;
  failed: ProbeNeed[];
}

/** how long a failing dependency stays quiet after Dan has been told once */
const ALERT_INTERVAL_MS = 6 * 3_600_000;

const HINTS: Record<ProbeNeed, string> = {
  whatsapp: 'check META_WA_TOKEN',
  calendar: 'check the calendar refresh tokens and that the Calendar API is enabled',
  mail: 'check GOOGLE_REFRESH_WALLE and that the Gmail API is enabled in the Cloud project',
};

/**
 * Every scheduled job starts with a probe of the services it needs. On
 * failure: one plain line to Dan per outage, not per poll; the job proceeds
 * with what works, and a probe event is logged. Never fail silently (PRD §5).
 */
export class Prober {
  /** need → when Dan was last told it is down */
  private readonly lastAlert = new Map<ProbeNeed, number>();

  constructor(
    private readonly log: EventLog,
    private readonly outbound: Outbound,
    private readonly sender: ChannelSender,
    private readonly calendar: CalendarService,
    private readonly mail: ForwardInbox,
  ) {}

  async probe(jobName: string, needs: ProbeNeed[]): Promise<ProbeResult> {
    const failed: ProbeNeed[] = [];
    for (const need of needs) {
      let ok = false;
      try {
        if (need === 'whatsapp') ok = await this.sender.probe();
        else if (need === 'calendar')
          ok = (await this.calendar.probe('dan')) && (await this.calendar.probe('alina'));
        else if (need === 'mail') ok = await this.mail.probe();
      } catch {
        ok = false;
      }
      if (!ok) failed.push(need);
    }
    this.log.append({
      actor: 'system',
      chat: null,
      type: 'probe',
      payload: { job: jobName, needs, failed, ok: failed.length === 0 },
    });
    for (const need of needs) {
      if (!failed.includes(need)) this.lastAlert.delete(need); // recovered: next outage is told again
    }
    const now = Date.now();
    const toTell = failed.filter(
      (need) => need !== 'whatsapp' && now - (this.lastAlert.get(need) ?? 0) >= ALERT_INTERVAL_MS,
    );
    if (toTell.length > 0) {
      for (const need of toTell) this.lastAlert.set(need, now);
      try {
        await this.outbound.send('dan', {
          text: `Heads up: ${toTell.join(' and ')} unreachable, so ${jobName.toLowerCase()} is running without it. ${toTell
            .map((n) => HINTS[n])
            .join('; ')}. I will stay quiet about this for six hours unless it recovers.`,
        });
      } catch {
        // logged already via send layer's error path
      }
    }
    return { ok: failed.length === 0, failed };
  }
}
