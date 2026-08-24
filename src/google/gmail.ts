import { google } from 'googleapis';
import type { GoogleAuths } from './auth.js';
import type { PersonalEmailMeta, PersonalInbox, SchoolEmail, SchoolInbox } from './types.js';
import type { User } from '../types/domain.js';

/** School inbox: full read of the dedicated Gmail, nothing else. */
export class GmailSchoolInbox implements SchoolInbox {
  constructor(private readonly auths: GoogleAuths) {}

  private gmail() {
    return google.gmail({ version: 'v1', auth: this.auths.clientFor('school') });
  }

  async listNewEmails(sinceIso: string): Promise<SchoolEmail[]> {
    const gmail = this.gmail();
    const afterEpoch = Math.floor(new Date(sinceIso).getTime() / 1000);
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `after:${afterEpoch}`,
      maxResults: 25,
    });
    const out: SchoolEmail[] = [];
    for (const ref of list.data.messages ?? []) {
      if (!ref.id) continue;
      const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
      const headers = msg.data.payload?.headers ?? [];
      const header = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
      out.push({
        msgId: ref.id,
        from: header('from'),
        subject: header('subject'),
        date: new Date(Number(msg.data.internalDate ?? Date.now())).toISOString(),
        body: extractPlainText(msg.data.payload).slice(0, 20000),
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  async probe(): Promise<boolean> {
    try {
      await this.gmail().users.getProfile({ userId: 'me' });
      return true;
    } catch {
      return false;
    }
  }
}

/** Personal inboxes: metadata triage + full read of the single 'walle' label. */
export class GmailPersonalInbox implements PersonalInbox {
  constructor(private readonly auths: GoogleAuths) {}

  private gmail(user: User) {
    return google.gmail({ version: 'v1', auth: this.auths.clientFor(user) });
  }

  async unreadSummary(user: User): Promise<{ count: number; recent: PersonalEmailMeta[] }> {
    const gmail = this.gmail(user);
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread in:inbox',
      maxResults: 10,
    });
    const recent: PersonalEmailMeta[] = [];
    for (const ref of (list.data.messages ?? []).slice(0, 10)) {
      if (!ref.id) continue;
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: ref.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject'],
      });
      const headers = msg.data.payload?.headers ?? [];
      const header = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
      recent.push({ from: header('from'), subject: header('subject'), unread: true });
    }
    return { count: list.data.resultSizeEstimate ?? recent.length, recent };
  }

  async readWalleLabel(user: User): Promise<SchoolEmail[]> {
    const gmail = this.gmail(user);
    const labels = await gmail.users.labels.list({ userId: 'me' });
    const walleLabel = labels.data.labels?.find((l) => l.name?.toLowerCase() === 'walle');
    if (!walleLabel?.id) return [];
    const list = await gmail.users.messages.list({
      userId: 'me',
      labelIds: [walleLabel.id],
      maxResults: 10,
    });
    const out: SchoolEmail[] = [];
    for (const ref of list.data.messages ?? []) {
      if (!ref.id) continue;
      const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
      const headers = msg.data.payload?.headers ?? [];
      const header = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
      out.push({
        msgId: ref.id,
        from: header('from'),
        subject: header('subject'),
        date: new Date(Number(msg.data.internalDate ?? Date.now())).toISOString(),
        body: extractPlainText(msg.data.payload).slice(0, 20000),
      });
    }
    return out;
  }
}

interface GmailPart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
}

function extractPlainText(payload: GmailPart | null | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text) return text;
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return '';
}
