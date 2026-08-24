/**
 * Day-28 adoption test (PRD §10): distinct days per user with an unprompted
 * inbound message. "Unprompted" = an inbound not sent within 2 hours after a
 * Wall-E-initiated (scheduled) send to that user.
 *
 *   DATA_DIR=/data npm run adoption-report
 */
import path from 'node:path';
import { readAllEvents } from '../src/log/logReader.js';
import type { WalleEvent } from '../src/types/events.js';

const TWO_HOURS = 2 * 3_600_000;
const dataDir = process.env.DATA_DIR ?? '/data';

async function main(): Promise<void> {
  const events: WalleEvent[] = [];
  for await (const ev of readAllEvents(path.join(dataDir, 'log'))) events.push(ev);

  const users = ['dan', 'alina'] as const;
  console.log('Adoption report (distinct unprompted inbound days per user)\n');

  for (const user of users) {
    const scheduledSends = events
      .filter(
        (e) =>
          e.type === 'msg_out' &&
          e.chat === user &&
          (e.payload as { scheduled?: boolean }).scheduled === true,
      )
      .map((e) => new Date(e.ts).getTime());

    const unpromptedDays = new Set<string>();
    const promptedDays = new Set<string>();
    for (const ev of events) {
      if (ev.type !== 'msg_in' || ev.chat !== user) continue;
      const t = new Date(ev.ts).getTime();
      const prompted = scheduledSends.some((s) => t >= s && t - s <= TWO_HOURS);
      (prompted ? promptedDays : unpromptedDays).add(ev.ts.slice(0, 10));
    }

    const allDays = [...unpromptedDays].sort();
    console.log(`${user}: ${unpromptedDays.size} unprompted days (${promptedDays.size} prompted-only interactions aside)`);
    if (allDays.length > 0) {
      console.log(`  first ${allDays[0]}, latest ${allDays[allDays.length - 1]}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
