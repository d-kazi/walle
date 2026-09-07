import { google } from 'googleapis';
import type { GoogleAuths } from './auth.js';
import type { ForwardInbox, SchoolEmail } from './types.js';

/**
 * The one dedicated mailbox, read via the `walle` principal. Delivered mail
 * is read in full; mail the Gmail filter binned is listed from TRASH with
 * metadata only, so a stranger's body is never fetched before a user
 * approves the sender.
 */
export class GmailForwardInbox implements ForwardInbox {
  constructor(private readonly auths: GoogleAuths) {}

  private gmail() {
    return google.gmail({ version: 'v1', auth: this.auths.clientFor('walle') });
  }

  async listNewEmails(sinceIso: string): Promise<SchoolEmail[]> {
    const gmail = this.gmail();
    const afterEpoch = Math.floor(new Date(sinceIso).getTime() / 1000);
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `after:${afterEpoch}`,
      labelIds: ['INBOX'],
      maxResults: 25,
    });
    const out: SchoolEmail[] = [];
    for (const ref of list.data.messages ?? []) {
      if (!ref.id) continue;
      const email = await this.fetchOne(ref.id);
      if (email) out.push(email);
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  async listRefused(sinceIso: string): Promise<Array<Omit<SchoolEmail, 'body'>>> {
    const gmail = this.gmail();
    const afterEpoch = Math.floor(new Date(sinceIso).getTime() / 1000);
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `after:${afterEpoch}`,
      labelIds: ['TRASH'],
      maxResults: 25,
    });
    const out: Array<Omit<SchoolEmail, 'body'>> = [];
    for (const ref of list.data.messages ?? []) {
      if (!ref.id) continue;
      // metadata format only: the body of a stranger's mail is never fetched
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: ref.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject'],
      });
      const headers = msg.data.payload?.headers ?? [];
      const header = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
      out.push({
        msgId: ref.id,
        from: header('from'),
        subject: header('subject'),
        date: new Date(Number(msg.data.internalDate ?? Date.now())).toISOString(),
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  async fetchOne(msgId: string): Promise<SchoolEmail | null> {
    const msg = await this.gmail().users.messages.get({
      userId: 'me',
      id: msgId,
      format: 'full',
    });
    if (!msg.data.id) return null;
    const headers = msg.data.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
    return {
      msgId: msg.data.id,
      from: header('from'),
      subject: header('subject'),
      date: new Date(Number(msg.data.internalDate ?? Date.now())).toISOString(),
      body: extractPlainText(msg.data.payload).slice(0, 20000),
    };
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
