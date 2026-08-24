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

/**
 * The dedicated forwarding mailbox. Dan and Alina forward mail here; a Gmail
 * filter sends anything from another sender straight to Trash. Read-only:
 * Wall-E cannot delete, so Gmail's own 30-day Trash purge does the disposal.
 */
export interface ForwardInbox {
  /** delivered mail newer than the given ISO date, oldest first, bodies included */
  listNewEmails(sinceIso: string): Promise<SchoolEmail[]>;
  /** refused mail sitting in Trash — sender and subject only, never a body */
  listRefused(sinceIso: string): Promise<Array<Omit<SchoolEmail, 'body'>>>;
  /** full read of one message, used only after a user approves its sender */
  fetchOne(msgId: string): Promise<SchoolEmail | null>;
}
