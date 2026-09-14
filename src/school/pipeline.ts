import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EventLog } from '../log/eventLog.js';
import type { Repos } from '../db/repos.js';
import type { LlmClient } from '../llm/client.js';
import type { SchoolEmail } from '../google/types.js';
import type { Confirmations } from '../assistant/confirmations.js';
import { structuredCall } from '../llm/structured.js';
import { fenceUntrusted } from '../llm/untrusted.js';
import type { EmailClass } from '../types/domain.js';

const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

const classifySchema = z.object({
  class: z.enum(['action_required', 'date_only', 'fyi', 'ignore']),
});

const extractSchema = z.object({
  child: z.enum(['dylan', 'caspian', 'maxie', 'all', 'unknown']),
  event: z.string(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  deadline: z.string().nullable(),
  neededItems: z.array(z.string()),
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * School mail loop (PRD §6): log email_in → classify → extract → propose to
 * both parents with Yes/No/Change → on Yes the confirmation gate executes
 * (calendar event and/or chased open item). Mail reaches it from the one
 * dedicated mailbox via ForwardedPipeline, which recognises school mail by
 * keyword. The mailbox's only Gmail scope is gmail.readonly; this pipeline
 * cannot send email by construction, and email content is fenced as
 * untrusted everywhere it meets the model.
 */
export class SchoolPipeline {
  constructor(
    private readonly deps: {
      log: EventLog;
      repos: Repos;
      llm: LlmClient;
      confirmations: Confirmations;
    },
  ) {}

  async processEmail(email: SchoolEmail): Promise<void> {
    const d = this.deps;
    d.log.append({
      actor: 'school',
      chat: null,
      type: 'email_in',
      payload: { msgId: email.msgId, from: email.from, subject: email.subject, date: email.date },
    });

    const fenced = fenceUntrusted(
      `From: ${email.from}\nDate: ${email.date}\nSubject: ${email.subject}\n\n${email.body.slice(0, 8000)}`,
      'school-email',
    );

    const classified = await structuredCall(d.llm, d.log, {
      task: 'school_classify',
      system: fs.readFileSync(path.join(promptsDir, 'school-classify.md'), 'utf8'),
      user: fenced,
      schema: classifySchema,
      schemaDescription: `{"class": "action_required" | "date_only" | "fyi" | "ignore"}`,
    });
    d.log.append({
      actor: 'walle',
      chat: null,
      type: 'verdict',
      payload: { kind: 'email_classified', msgId: email.msgId, value: classified.class },
    });

    if (classified.class === 'ignore' || classified.class === 'fyi') {
      d.log.append({
        actor: 'walle',
        chat: null,
        type: 'verdict',
        payload: { kind: 'email_action', msgId: email.msgId, value: 'none' },
      });
      return;
    }

    const extracted = await structuredCall(d.llm, d.log, {
      task: 'school_extract',
      system: fs.readFileSync(path.join(promptsDir, 'school-extract.md'), 'utf8'),
      user: fenced,
      schema: extractSchema,
      schemaDescription:
        `{"child": "dylan"|"caspian"|"maxie"|"all"|"unknown", "event": string, ` +
        `"date": "YYYY-MM-DD"|null, "time": "HH:mm"|null, "deadline": "YYYY-MM-DD"|null, "neededItems": string[]}`,
    });

    const childLabel =
      extracted.child === 'all' ? 'the boys' : extracted.child === 'unknown' ? null : cap(extracted.child);
    const actions: string[] = [];

    // a dated event proposes a calendar entry
    if (extracted.date && ISO_DATE.test(extracted.date)) {
      await this.proposeCalendar(email, extracted, childLabel);
      actions.push('calendar_proposed');
    }

    // an action with a deadline proposes a chased open item
    if (classified.class === 'action_required') {
      const due = extracted.deadline && ISO_DATE.test(extracted.deadline) ? extracted.deadline : extracted.date;
      const items = extracted.neededItems.length > 0 ? ` (${extracted.neededItems.join(', ')})` : '';
      await d.confirmations.propose(
        'open_item',
        {
          title: `${extracted.event}${items}`,
          owner: 'both',
          child: extracted.child === 'all' || extracted.child === 'unknown' ? null : extracted.child,
          due: due && ISO_DATE.test(due) ? due : null,
        },
        'both',
        `School: ${extracted.event}${childLabel ? ` for ${childLabel}` : ''}${
          due ? `, needed by ${due}` : ''
        }. Track and chase it?`,
      );
      actions.push('open_item_proposed');
    }

    d.log.append({
      actor: 'walle',
      chat: null,
      type: 'verdict',
      payload: { kind: 'email_action', msgId: email.msgId, value: actions.join(',') || 'none' },
    });
  }

  private async proposeCalendar(
    email: SchoolEmail,
    extracted: z.infer<typeof extractSchema>,
    childLabel: string | null,
  ): Promise<void> {
    const time = extracted.time && /^\d{2}:\d{2}$/.test(extracted.time) ? extracted.time : '09:00';
    const start = `${extracted.date}T${time}:00+03:00`;
    const end = `${extracted.date}T${addHour(time)}:00+03:00`;
    await this.deps.confirmations.propose(
      'calendar_event',
      {
        title: `${extracted.event}${childLabel ? ` (${childLabel})` : ''}`,
        start,
        end,
        calendar: 'alina',
        description: `From school email: ${email.subject}`,
      },
      'both',
      `School: ${extracted.event}${childLabel ? ` for ${childLabel}` : ''} on ${extracted.date}${
        extracted.time ? ` at ${extracted.time}` : ''
      }. Add to the calendar?`,
    );
  }
}

function addHour(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${String(((h ?? 9) + 1) % 24).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
