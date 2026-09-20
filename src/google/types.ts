import type { BusyInterval, CalendarEventDraft, User } from '../types/domain.js';

/**
 * Interfaces over the Google surface. Real implementations live beside this
 * file (googleapis, three OAuth principals); tests and dev:sim inject fakes.
 * Scopes per principal (data, not authority — hard rule 4):
 *   walle: gmail.readonly on the one dedicated mailbox; drive.readonly +
 *          drive.file on that account's otherwise empty Drive
 *   dan/alina: calendar events read/write (Tier 2 gated by confirmations)
 */

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO
  end: string; // ISO
  allDay: boolean;
}

/**
 * Two kinds of calendar, read very differently. The shared family calendar
 * is read in full and is the only one ever written to. The two personal
 * calendars are read as busy/free intervals only: their contents never
 * reach a brief or the model, they only answer "is this parent free then".
 */
export interface CalendarService {
  listFamilyEvents(fromIso: string, toIso: string): Promise<CalendarEvent[]>;
  busy(user: User, fromIso: string, toIso: string): Promise<BusyInterval[]>;
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
 * The one dedicated mailbox. School mail arrives here directly or by
 * auto-forward; Dan and Alina forward anything else; a Gmail filter sends
 * every other sender straight to Trash. Read-only: Wall-E cannot delete, so
 * Gmail's own 30-day Trash purge does the disposal.
 */
export interface ForwardInbox {
  /** delivered mail newer than the given ISO date, oldest first, bodies included */
  listNewEmails(sinceIso: string): Promise<SchoolEmail[]>;
  /** refused mail sitting in Trash — sender and subject only, never a body */
  listRefused(sinceIso: string): Promise<Array<Omit<SchoolEmail, 'body'>>>;
  /** full read of one message, used only after a user approves its sender */
  fetchOne(msgId: string): Promise<SchoolEmail | null>;
  probe(): Promise<boolean>;
}
