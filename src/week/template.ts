import fs from 'node:fs';
import path from 'node:path';
import type { Child, User } from '../types/domain.js';
import { CHILDREN } from '../types/domain.js';

/**
 * The standing week: what each child's ordinary Sunday to Saturday looks
 * like. It changes about once a half-term, so it is captured in one
 * interview and then only corrected.
 *
 * This is the layer that makes a brief worth reading. Without it every day
 * looks identical and Wall-E can only repeat the calendar back. With it a
 * brief can say what is *different* about today, and can notice that nobody
 * has said who collects Dylan on a Tuesday.
 *
 * Stored as JSON beside the markdown memory files, so the nightly Drive
 * backup carries it. Every change also appends a memory_op event, so the
 * log still records who changed what and when.
 */

/** 0 = Sunday. The Riyadh school week runs Sunday to Thursday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6] as const;
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Who handles a run. 'either' means it genuinely varies and needs no asking. */
export type Responsible = User | 'either' | 'bus' | 'nobody';

export interface Activity {
  name: string;
  /** HH:mm, optional: "swimming after school" needs no time */
  from?: string;
  /** things to take; the brief's most useful single field */
  kit?: string[];
}

export interface DaySlot {
  /** false for a weekend or a child too young for school */
  school: boolean;
  /** HH:mm */
  start?: string;
  end?: string;
  activities: Activity[];
  dropOff?: Responsible;
  pickUp?: Responsible;
  notes?: string;
}

/** A slot nobody has described yet. Distinct from a described day with nothing in it. */
export type StoredSlot = DaySlot | null;

export interface WeekData {
  /** child → weekday index → slot */
  slots: Record<Child, StoredSlot[]>;
  /** ISO date the template was last confirmed as current */
  confirmedOn: string | null;
}

export interface Gap {
  child: Child;
  weekday: Weekday;
  /** what is missing, in words a parent would recognise */
  missing: string;
}

function emptyWeek(): WeekData {
  const slots = {} as Record<Child, StoredSlot[]>;
  for (const child of CHILDREN) slots[child] = WEEKDAYS.map(() => null);
  return { slots, confirmedOn: null };
}

export class WeekTemplate {
  private readonly file: string;

  constructor(dataDir: string) {
    const dir = path.join(dataDir, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'week.json');
  }

  read(): WeekData {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as WeekData;
      const week = emptyWeek();
      for (const child of CHILDREN) {
        const stored = parsed.slots?.[child];
        if (Array.isArray(stored)) {
          for (const day of WEEKDAYS) week.slots[child][day] = stored[day] ?? null;
        }
      }
      week.confirmedOn = parsed.confirmedOn ?? null;
      return week;
    } catch {
      return emptyWeek();
    }
  }

  private write(week: WeekData): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(week, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  setDay(child: Child, weekday: Weekday, slot: DaySlot): void {
    const week = this.read();
    week.slots[child][weekday] = slot;
    this.write(week);
  }

  /** Mark the whole template as still accurate, which is what a half-term check does. */
  confirm(isoDate: string): void {
    const week = this.read();
    week.confirmedOn = isoDate;
    this.write(week);
  }

  slot(child: Child, weekday: Weekday): StoredSlot {
    return this.read().slots[child][weekday] ?? null;
  }

  /** Has anybody described any day at all? Drives the "let's set this up" nudge. */
  isEmpty(): boolean {
    const week = this.read();
    return CHILDREN.every((child) => week.slots[child].every((s) => s === null));
  }

  /**
   * What the template cannot answer. Two kinds only, both things a parent
   * would actually be asked in a doorway: a day nobody has described, and a
   * school day with no named pick-up.
   */
  gaps(): Gap[] {
    const week = this.read();
    const out: Gap[] = [];
    for (const child of CHILDREN) {
      for (const day of WEEKDAYS) {
        const slot = week.slots[child][day] ?? null;
        if (slot === null) {
          out.push({ child, weekday: day, missing: 'nothing known about this day' });
        } else if (slot.school && !slot.pickUp) {
          out.push({ child, weekday: day, missing: 'who collects' });
        }
      }
    }
    return out;
  }

  /**
   * The template as the model sees it, in the system prompt. Weekends with
   * nothing in them are dropped: they are the common case and repeating
   * "Saturday: nothing" three times teaches the model nothing.
   */
  render(): string {
    const week = this.read();
    if (this.isEmpty()) return '(not set up yet)';
    const lines: string[] = [];
    for (const child of CHILDREN) {
      const days: string[] = [];
      for (const day of WEEKDAYS) {
        const slot = week.slots[child][day] ?? null;
        if (slot === null) {
          days.push(`  ${WEEKDAY_NAMES[day]}: not known`);
          continue;
        }
        const parts: string[] = [];
        if (slot.school) {
          parts.push(slot.start && slot.end ? `school ${slot.start}–${slot.end}` : 'school');
        }
        for (const a of slot.activities) {
          const kit = a.kit && a.kit.length > 0 ? ` (take ${a.kit.join(', ')})` : '';
          parts.push(`${a.name}${a.from ? ` ${a.from}` : ''}${kit}`);
        }
        if (slot.dropOff) parts.push(`drop-off ${slot.dropOff}`);
        if (slot.pickUp) parts.push(`pick-up ${slot.pickUp}`);
        if (slot.notes) parts.push(slot.notes);
        days.push(`  ${WEEKDAY_NAMES[day]}: ${parts.length > 0 ? parts.join('; ') : 'nothing on'}`);
      }
      lines.push(`${cap(child)}:\n${days.join('\n')}`);
    }
    if (week.confirmedOn) lines.push(`(last confirmed ${week.confirmedOn})`);
    return lines.join('\n');
  }

  /** One child's ordinary day, for the brief to compare today against. */
  describeDay(child: Child, weekday: Weekday): string | null {
    const slot = this.slot(child, weekday);
    if (slot === null) return null;
    const parts: string[] = [];
    if (slot.school) parts.push(slot.start && slot.end ? `school ${slot.start}–${slot.end}` : 'school');
    for (const a of slot.activities) {
      const kit = a.kit && a.kit.length > 0 ? ` (take ${a.kit.join(', ')})` : '';
      parts.push(`${a.name}${a.from ? ` ${a.from}` : ''}${kit}`);
    }
    if (slot.pickUp) parts.push(`pick-up ${slot.pickUp}`);
    if (slot.notes) parts.push(slot.notes);
    return parts.length > 0 ? parts.join('; ') : 'nothing on';
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
