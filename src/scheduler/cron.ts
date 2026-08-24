import cron from 'node-cron';
import type { EventLog } from '../log/eventLog.js';

const TZ = 'Asia/Riyadh';

export interface Job {
  name: string;
  /** standard 5-field cron expression, evaluated in Asia/Riyadh */
  schedule: string;
  run: () => Promise<void>;
}

/**
 * node-cron registry. Every job's timezone is pinned to Asia/Riyadh (belt
 * and braces alongside TZ env), and a job that throws logs an error event
 * rather than dying silently.
 */
export function registerJobs(log: EventLog, jobs: Job[]): void {
  for (const job of jobs) {
    cron.schedule(
      job.schedule,
      async () => {
        try {
          await job.run();
        } catch (err) {
          log.append({
            actor: 'system',
            chat: null,
            type: 'error',
            payload: { kind: 'job_failed', job: job.name, message: String(err) },
          });
        }
      },
      { timezone: TZ },
    );
  }
}
