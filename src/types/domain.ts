export type User = 'dan' | 'alina';

export type Child = 'dylan' | 'caspian' | 'maxie';

export const USERS: readonly User[] = ['dan', 'alina'] as const;
export const CHILDREN: readonly Child[] = ['dylan', 'caspian', 'maxie'] as const;

export function otherUser(user: User): User {
  return user === 'dan' ? 'alina' : 'dan';
}

/** Memory scope resolved at capture time (PRD §7). */
export type MemoryScope =
  | { kind: 'shared' }
  | { kind: 'private'; user: User }
  | { kind: 'child'; child: Child };

export type ChildTimeLevel = 'proper' | 'some' | 'none';

export interface OpenItem {
  id: string;
  title: string;
  owner: User | 'both';
  child: Child | null;
  due: string | null; // ISO date
  sourceEvent: string; // ts of originating event
  status: 'open' | 'done' | 'dropped';
  lastNudge: string | null; // ISO ts of last chase nudge
}

export type ProposalKind = 'calendar_event' | 'open_item';

export interface CalendarEventDraft {
  title: string;
  start: string; // ISO datetime
  end: string; // ISO datetime
  calendar: User; // whose Google calendar
  description?: string;
  location?: string;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  /** CalendarEventDraft or partial OpenItem, JSON */
  payload: Record<string, unknown>;
  proposedTo: User | 'both';
  status: 'pending' | 'confirmed' | 'declined' | 'expired' | 'superseded';
  /** user who answered, when status is confirmed/declined */
  answeredBy: User | null;
  sourceEvent: string;
  createdTs: string;
  /** set once the expiry has been mentioned in a morning brief */
  expiryNotified: boolean;
}

export interface LedgerSummary {
  lastSync: string; // ISO ts
  monthToDate: Record<string, number>; // category -> amount SAR
  notableDeltas: string[];
}

export type EmailClass = 'action_required' | 'date_only' | 'fyi' | 'ignore';

export interface EmailExtraction {
  child: Child | 'all' | 'unknown';
  event: string;
  date: string | null; // ISO date
  time: string | null; // HH:mm
  deadline: string | null; // ISO date
  neededItems: string[];
}
