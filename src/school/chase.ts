import type { OpenItem } from '../types/domain.js';

export type NudgeStage = 'T-3d' | 'T-1d' | 'morning-of' | 'overdue';

export interface Nudge {
  item: OpenItem;
  stage: NudgeStage;
}

/**
 * Pure deadline-chasing calculus: nudge at T-3d, T-1d, and the morning of
 * the due date; stop on done (PRD §6). At most one nudge per item per day,
 * enforced by comparing last_nudge's date to today.
 */
export function nudgesOwed(items: OpenItem[], today: string): Nudge[] {
  const out: Nudge[] = [];
  for (const item of items) {
    if (item.status !== 'open' || !item.due) continue;
    if (item.lastNudge && item.lastNudge.slice(0, 10) === today) continue;
    const days = daysBetween(today, item.due);
    let stage: NudgeStage | null = null;
    if (days < 0) stage = 'overdue';
    else if (days === 0) stage = 'morning-of';
    else if (days === 1) stage = 'T-1d';
    else if (days <= 3) stage = 'T-3d';
    if (stage) out.push({ item, stage });
  }
  return out;
}

function daysBetween(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}
