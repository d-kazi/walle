/**
 * All timestamps in the log are ISO 8601 with the +03:00 offset.
 * Riyadh has no DST, so the offset is constant.
 */

export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function riyadhIso(date: Date): string {
  const shifted = new Date(date.getTime() + RIYADH_OFFSET_MS);
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+03:00');
}

/** YYYY-MM-DD in Riyadh local time */
export function riyadhDate(date: Date): string {
  return new Date(date.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM in Riyadh local time, used for log rotation */
export function riyadhMonth(date: Date): string {
  return riyadhDate(date).slice(0, 7);
}

/** hour of day 0-23 in Riyadh local time */
export function riyadhHour(date: Date): number {
  return new Date(date.getTime() + RIYADH_OFFSET_MS).getUTCHours();
}
