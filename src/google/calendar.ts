import { google } from 'googleapis';
import type { GoogleAuths } from './auth.js';
import type { CalendarEvent, CalendarService } from './types.js';
import type { CalendarEventDraft, User } from '../types/domain.js';

/**
 * Google Calendar over the two adult principals. Reads are Tier 1; writes
 * are only ever reached through the confirmation gate (Tier 2).
 */
export class GoogleCalendarService implements CalendarService {
  constructor(private readonly auths: GoogleAuths) {}

  private calendar(user: User) {
    return google.calendar({ version: 'v3', auth: this.auths.clientFor(user) });
  }

  async listEvents(user: User, fromIso: string, toIso: string): Promise<CalendarEvent[]> {
    const res = await this.calendar(user).events.list({
      calendarId: 'primary',
      timeMin: fromIso,
      timeMax: toIso,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });
    return (res.data.items ?? []).map((e) => ({
      id: e.id ?? '',
      title: e.summary ?? '(untitled)',
      start: e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00+03:00` : ''),
      end: e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00+03:00` : ''),
      calendar: user,
      allDay: !e.start?.dateTime,
    }));
  }

  async createEvent(draft: CalendarEventDraft): Promise<{ id: string }> {
    const res = await this.calendar(draft.calendar).events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: draft.title,
        start: { dateTime: draft.start, timeZone: 'Asia/Riyadh' },
        end: { dateTime: draft.end, timeZone: 'Asia/Riyadh' },
        ...(draft.description ? { description: draft.description } : {}),
        ...(draft.location ? { location: draft.location } : {}),
      },
    });
    return { id: res.data.id ?? '' };
  }

  async probe(user: User): Promise<boolean> {
    try {
      await this.calendar(user).calendarList.get({ calendarId: 'primary' });
      return true;
    } catch {
      return false;
    }
  }
}
