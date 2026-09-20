import { probeReason } from '../channel/types.js';
import type { ChannelSender, ProbeOutcome } from '../channel/types.js';
import type { CalendarService, ForwardInbox } from '../google/types.js';
import type { EventLog } from '../log/eventLog.js';

export type ProbeNeed = 'whatsapp' | 'calendar' | 'mail';

export interface ProbeResult {
  ok: boolean;
  failed: ProbeNeed[];
  /** why each failure happened, for /health and the log */
  reasons: Partial<Record<ProbeNeed, string>>;
}

/**
 * Every scheduled job starts with a probe of the services it needs. On
 * failure the job proceeds with what works and a probe event is logged.
 * Nobody is messaged: an outage shows up as one line in the next morning
 * brief and in /health, never as its own WhatsApp (PRD §5, amended after
 * the alerts proved more annoying than the outages).
 */
export class Prober {
  constructor(
    private readonly log: EventLog,
    private readonly sender: ChannelSender,
    private readonly calendar: CalendarService,
    private readonly mail: ForwardInbox,
  ) {}

  async probe(jobName: string, needs: ProbeNeed[]): Promise<ProbeResult> {
    const failed: ProbeNeed[] = [];
    const reasons: Partial<Record<ProbeNeed, string>> = {};
    for (const need of needs) {
      let outcome: ProbeOutcome;
      try {
        if (need === 'whatsapp') outcome = await this.sender.probe();
        else if (need === 'calendar') {
          const dan = await this.calendar.probe('dan');
          outcome = dan.ok ? await this.calendar.probe('alina') : dan;
        } else outcome = await this.mail.probe();
      } catch (err) {
        outcome = { ok: false, reason: probeReason(err) };
      }
      if (!outcome.ok) {
        failed.push(need);
        reasons[need] = outcome.reason;
      }
    }
    this.log.append({
      actor: 'system',
      chat: null,
      type: 'probe',
      payload: { job: jobName, needs, failed, ok: failed.length === 0, ...(failed.length > 0 ? { reasons } : {}) },
    });
    return { ok: failed.length === 0, failed, reasons };
  }
}
