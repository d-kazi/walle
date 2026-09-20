import { google } from 'googleapis';
import type { GoogleAuths } from './auth.js';
import type { CalendarEvent, CalendarService } from './types.js';
import { probeReason } from '../channel/types.js';
import type { ProbeOutcome } from '../channel/types.js';
import type { BusyInterval, CalendarEventDraft, User } from '../types/domain.js';

/**
 * Google Calendar. The family calendar is a shared calendar both adults and
 * the walle account can edit; it is read through Dan's principal, whose
 * calendar.events scope covers every calendar shared with him. Personal
 * calendars are read as free/busy only. Writes happen only through the
 * confirmation gate (Tier 2) and only to the family calendar.
 */
export class GoogleCalendarService implements CalendarService {
  constructor(
    private readonly auths: GoogleAuths,
    private readonly familyCalendarId: string,
  ) {}

  private calendar(user: User) {
    return google.calendar({ version: 'v3', auth: this.auths.clientFor(user) });
  }

  async listFamilyEvents(fromIso: string, toIso: string): Promise<CalendarEvent[]> {
    const res = await this.calendar('dan').events.list({
      calendarId: this.familyCalendarId,
      timeMin: fromIso,
      timeMax: toIso,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    });
    return (res.data.items ?? []).map((e) => ({
      id: e.id ?? '',
      title: e.summary ?? '(untitled)',
      start: e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00+03:00` : ''),
      end: e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00+03:00` : ''),
      allDay: !e.start?.dateTime,
    }));
  }

  async busy(user: User, fromIso: string, toIso: string): Promise<BusyInterval[]> {
    // events.list on primary, reduced to intervals before it leaves this method:
    // no summary, no description, nothing a brief could repeat
    const res = await this.calendar(user).events.list({
      calendarId: 'primary',
      timeMin: fromIso,
      timeMax: toIso,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    });
    return (res.data.items ?? [])
      .filter((e) => e.start?.dateTime && e.end?.dateTime && e.transparency !== 'transparent')
      .map((e) => ({ start: e.start!.dateTime!, end: e.end!.dateTime! }));
  }

  async createEvent(draft: CalendarEventDraft): Promise<{ id: string }> {
    const res = await this.calendar('dan').events.insert({
      calendarId: this.familyCalendarId,
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

  async probe(user: User): Promise<ProbeOutcome> {
    try {
      await this.calendar(user).events.list({ calendarId: 'primary', maxResults: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `${user}: ${probeReason(err)}` };
    }
  }
}
