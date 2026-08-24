import type { z } from 'zod';
import type { ChatMessage, LlmClient } from './client.js';
import type { EventLog } from '../log/eventLog.js';

/**
 * Structured single calls: JSON mode plus code-side zod validation with one
 * retry carrying the validation error. All non-conversational LLM work
 * (classification, extraction, curation, brief composition, child-time
 * parsing) goes through here. The model judges; the code decides.
 */
export async function structuredCall<T>(
  client: LlmClient,
  log: EventLog,
  opts: {
    task: string;
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaDescription: string;
    escalate?: boolean;
  },
): Promise<T> {
  const system =
    `${opts.system}\n\n` +
    `Respond with a single JSON object only, no prose, no markdown fences, matching exactly this schema:\n` +
    `${opts.schemaDescription}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: opts.user },
  ];

  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.chat({
      task: opts.task,
      messages:
        attempt === 0
          ? messages
          : [
              ...messages,
              {
                role: 'user',
                content: `Your previous answer was invalid: ${lastError}. Reply again with only the corrected JSON object.`,
              },
            ],
      jsonMode: true,
      temperature: 0.1,
      ...(opts.escalate !== undefined ? { escalate: opts.escalate } : {}),
    });
    const parsed = tryParseJson(res.content ?? '');
    if (parsed.ok) {
      const validated = opts.schema.safeParse(parsed.value);
      if (validated.success) {
        if (attempt > 0) {
          log.append({
            actor: 'system',
            chat: null,
            type: 'llm_call',
            payload: { task: opts.task, model: 'n/a', schemaRetries: attempt, ok: true },
          });
        }
        return validated.data;
      }
      lastError = validated.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 500);
    } else {
      lastError = 'not valid JSON';
    }
  }
  log.append({
    actor: 'system',
    chat: null,
    type: 'error',
    payload: { kind: 'structured_call_failed', task: opts.task, lastError },
  });
  throw new Error(`Structured call ${opts.task} failed schema validation: ${lastError}`);
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    // some models wrap JSON in prose; grab the outermost object
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(cleaned.slice(start, end + 1)) };
      } catch {
        return { ok: false };
      }
    }
    return { ok: false };
  }
}
