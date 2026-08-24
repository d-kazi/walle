import type { CalendarEventDraft, User } from '../types/domain.js';

/**
 * Interfaces over the Google surface. Real implementations live beside this
 * file (googleapis, three OAuth principals); tests and dev:sim inject fakes.
 * Scopes per principal (data, not authority — hard rule 4):
 *   school: gmail.readonly only
 *   dan/alina: gmail.metadata + full read of the single 'walle' label;
 *              calendar events read/write (Tier 2 gated by confirmations)
 *   dan: Drive read of the family folder + write to _walle-backup only
 */

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO
  end: string; // ISO
  calendar: User;
  allDay: boolean;
}

export interface CalendarService {
  listEvents(user: User, fromIso: string, toIso: string): Promise<CalendarEvent[]>;
  createEvent(draft: CalendarEventDraft): Promise<{ id: string }>;
  probe(user: User): Promise<boolean>;
}

export interface SchoolEmail {
  msgId: string;
  from: string;
  subject: string;
  date: string; // ISO
  body: string; // plain text
}

export interface SchoolInbox {
  /** unread-or-recent emails newer than the given ISO date, oldest first */
  listNewEmails(sinceIso: string): Promise<SchoolEmail[]>;
  probe(): Promise<boolean>;
}

export interface PersonalEmailMeta {
  from: string;
  subject: string;
  unread: boolean;
}

export interface PersonalInbox {
  /** metadata-only triage counts for one user's inbox */
  unreadSummary(user: User): Promise<{ count: number; recent: PersonalEmailMeta[] }>;
  /** full read of the single 'walle' label */
  readWalleLabel(user: User): Promise<SchoolEmail[]>;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modified: string;
}

export interface DriveService {
  listFamilyFolder(): Promise<DriveFile[]>;
  fetchFileText(fileId: string): Promise<string>;
  uploadBackup(name: string, localPath: string): Promise<void>;
  listBackups(): Promise<DriveFile[]>;
  deleteBackup(fileId: string): Promise<void>;
}
