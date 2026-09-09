import type { ChannelSender } from '../channel/types.js';
import type { CalendarService, ForwardInbox } from '../google/types.js';
import type { EventLog } from '../log/eventLog.js';
import type { Outbound } from '../send/outbound.js';

export type ProbeNeed = 'whatsapp' | 'calendar' | 'mail';

export interface ProbeResult {
  ok: boolean;
  failed: ProbeNeed[];
}

/**
 * Every scheduled job starts with a probe of the services it needs. On
 * failure: one plain line to Dan, the job proceeds with what works, and a
 * probe event is logged. Never fail silently (PRD §5).
 */
export class Prober {
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
    if (failed.length > 0 && !failed.includes('whatsapp')) {
      try {
        await this.outbound.send('dan', {
          text: `${jobName} running blind: ${failed.join(', ')} unreachable.`,
        });
      } catch {
        // logged already via send layer's error path
      }
    }
    return { ok: failed.length === 0, failed };
  }
}
