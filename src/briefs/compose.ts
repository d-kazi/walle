import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventLog } from '../log/eventLog.js';
import type { LlmClient } from '../llm/client.js';
import type { User } from '../types/domain.js';

const HARD_LIMIT = 1000;

const promptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'prompts',
  'brief-compose.md',
);

export interface BriefInput {
  briefType: 'morning' | 'evening' | 'midday' | 'weekly';
  user: User;
  date: string;
  sections: Record<string, unknown>;
}

/**
 * Turn a structured brief input into ≤900-char prose. Instructed limit 900,
 * hard trim at 1000 with an error event so an overrun is visible. If the
 * model is unreachable the deterministic fallback renders the facts plainly:
 * a dull brief beats no brief (never fail silently).
 */
export async function composeBrief(
  llm: LlmClient,
  log: EventLog,
  input: BriefInput,
): Promise<string> {
  const system = fs.readFileSync(promptPath, 'utf8');
  let text: string;
  try {
    const res = await llm.chat({
      task: `brief_${input.briefType}`,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            `Write the ${input.briefType} brief for ${input.user === 'dan' ? 'Dan' : 'Alina'}, ${input.date}.\n` +
            `Input:\n${JSON.stringify(input.sections, null, 2)}`,
        },
      ],
      temperature: 0.5,
      maxTokens: 512,
    });
    text = (res.content ?? '').trim();
    if (!text) throw new Error('empty brief');
  } catch (err) {
    log.append({
      actor: 'system',
      chat: input.user,
      type: 'error',
      payload: { kind: 'brief_compose_failed', briefType: input.briefType, message: String(err) },
    });
    text = fallbackRender(input);
  }
  if (text.length > HARD_LIMIT) {
    log.append({
      actor: 'system',
      chat: input.user,
      type: 'error',
      payload: { kind: 'brief_overrun', briefType: input.briefType, length: text.length },
    });
    text = text.slice(0, HARD_LIMIT - 1) + '…';
  }
  return text;
}

function fallbackRender(input: BriefInput): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input.sections)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${label(key)}:`);
      for (const v of value.slice(0, 6)) {
        lines.push(`- ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
    } else if (typeof value === 'string' && value) {
      lines.push(`${label(key)}: ${value}`);
    }
  }
  if (input.briefType === 'evening') {
    lines.push('Roughly, today: Dylan / Caspian / Maxie — proper, some, or none?');
  }
  return lines.join('\n').slice(0, HARD_LIMIT) || 'Nothing on the list. Quiet day.';
}

function label(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}
