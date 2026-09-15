import type { ChannelSender } from '../channel/types.js';
import type { CalendarService, ForwardInbox } from '../google/types.js';
import type { EventLog } from '../log/eventLog.js';

export type ProbeNeed = 'whatsapp' | 'calendar' | 'mail';

export interface ProbeResult {
  ok: boolean;
  failed: ProbeNeed[];
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
    return { ok: failed.length === 0, failed };
  }
}
