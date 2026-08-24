import { z } from 'zod';
import type { EventLog } from '../log/eventLog.js';
import type { LlmClient } from '../llm/client.js';
import { structuredCall } from '../llm/structured.js';
import type { Child, ChildTimeLevel, User } from '../types/domain.js';

/**
 * Parse an evening child-time answer ("proper with Dylan, some with the
 * little ones") into rows. Three coarse words only — no scoring, no streaks
 * (hard rule 8). Partial answers are stored as-is.
 */

const schema = z.object({
  isAnswer: z.boolean(),
  dylan: z.enum(['proper', 'some', 'none']).nullable(),
  caspian: z.enum(['proper', 'some', 'none']).nullable(),
  maxie: z.enum(['proper', 'some', 'none']).nullable(),
});

const SYSTEM = `A parent was asked: "Roughly, today: Dylan / Caspian / Maxie — proper, some, or none?"
It means how much one-to-one time each child got today. Decide whether the message is an answer to that question, and if so map it.
"proper" = real focused time, "some" = a bit, "none" = none.
Nicknames: D/Dyl = dylan, Cas = caspian, Max/M = maxie. "the little ones" or "the younger two" = caspian and maxie. "all"/"everyone" = all three.
If the message is about something else entirely, isAnswer is false and all children null. Leave a child null when the message does not mention them.`;

export interface ChildTimeParse {
  isAnswer: boolean;
  entries: Array<{ child: Child; level: ChildTimeLevel }>;
}

export async function parseChildTimeAnswer(
  client: LlmClient,
  log: EventLog,
  text: string,
): Promise<ChildTimeParse> {
  const result = await structuredCall(client, log, {
    task: 'child_time_parse',
    system: SYSTEM,
    user: text,
    schema,
    schemaDescription: `{"isAnswer": boolean, "dylan": "proper"|"some"|"none"|null, "caspian": "proper"|"some"|"none"|null, "maxie": "proper"|"some"|"none"|null}`,
  });
  const entries: Array<{ child: Child; level: ChildTimeLevel }> = [];
  for (const child of ['dylan', 'caspian', 'maxie'] as const) {
    const level = result[child];
    if (level) entries.push({ child, level });
  }
  return { isAnswer: result.isAnswer && entries.length > 0, entries };
}

export function recordChildTime(
  log: EventLog,
  reporter: User,
  date: string,
  entries: Array<{ child: Child; level: ChildTimeLevel }>,
): void {
  log.append({
    actor: reporter,
    chat: reporter,
    type: 'child_time',
    payload: { date, reporter, entries },
  });
}
