import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EventLog } from '../log/eventLog.js';
import type { LlmClient } from '../llm/client.js';
import type { MemoryStore } from './store.js';
import { structuredCall } from '../llm/structured.js';
import { readEventsForDate } from '../log/logReader.js';
import type { MemoryScope, User } from '../types/domain.js';
import { CHILDREN, USERS } from '../types/domain.js';

const promptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'prompts',
  'curator.md',
);

const changeSchema = z.object({
  changes: z.array(
    z.object({
      op: z.enum(['add', 'supersede']),
      scope: z.enum(['shared', 'private', 'child']),
      child: z.enum(['dylan', 'caspian', 'maxie']).nullable(),
      match: z.string().nullable(),
      text: z.string(),
    }),
  ),
});

/**
 * 23:30 curation pass (PRD §5). Runs once per user over that user's day of
 * chat, so "private" can only ever mean private-to-that-user — a code
 * guarantee, not a prompt request. The curator never composes user messages
 * and has no access to the send layer; it emits memory_op events only.
 */
export class Curator {
  constructor(
    private readonly deps: {
      log: EventLog;
      llm: LlmClient;
      memory: MemoryStore;
      logDir: string;
    },
  ) {}

  async runForDate(date: string): Promise<void> {
    for (const user of USERS) {
      try {
        await this.curateUserDay(user, date);
      } catch (err) {
        this.deps.log.append({
          actor: 'system',
          chat: null,
          type: 'error',
          payload: { kind: 'curation_failed', user, message: String(err) },
        });
      }
    }
  }

  private async curateUserDay(user: User, date: string): Promise<void> {
    const d = this.deps;
    const events = await readEventsForDate(d.logDir, date);
    const turns = events
      .filter((ev) => ev.chat === user && (ev.type === 'msg_in' || ev.type === 'msg_out'))
      .map((ev) => {
        const p = ev.payload as { text?: string };
        return `${ev.type === 'msg_in' ? user : 'walle'}: ${p.text ?? ''}`;
      })
      .filter((line) => !line.endsWith(': '));
    if (turns.length === 0) return;

    const alreadyStoredToday = events
      .filter((ev) => ev.type === 'memory_op')
      .map((ev) => (ev.payload as { bullet?: string }).bullet ?? '')
      .filter(Boolean);

    const currentMemory = [
      `shared.md:\n${d.memory.activeFacts({ kind: 'shared' }).join('\n')}`,
      `${user}.private.md:\n${d.memory.activeFacts({ kind: 'private', user }).join('\n')}`,
      ...CHILDREN.map((c) => `children/${c}.md:\n${d.memory.activeFacts({ kind: 'child', child: c }).join('\n')}`),
    ].join('\n\n');

    const result = await structuredCall(d.llm, d.log, {
      task: 'curator',
      system: fs.readFileSync(promptPath, 'utf8'),
      user:
        `Parent: ${user}. Date: ${date}.\n\n` +
        `Current memory (active facts):\n${currentMemory}\n\n` +
        `Stored today already (do not duplicate):\n${alreadyStoredToday.join('\n') || '(none)'}\n\n` +
        `The day's chat:\n${turns.join('\n').slice(0, 12000)}`,
      schema: changeSchema,
      schemaDescription:
        `{"changes": [{"op": "add"|"supersede", "scope": "shared"|"private"|"child", ` +
        `"child": "dylan"|"caspian"|"maxie"|null, "match": string|null, "text": string}]}`,
    });

    for (const change of result.changes) {
      // private is structurally pinned to the chat being curated
      const scope: MemoryScope =
        change.scope === 'private'
          ? { kind: 'private', user }
          : change.scope === 'child' && change.child
            ? { kind: 'child', child: change.child }
            : { kind: 'shared' };

      let applied = false;
      if (change.op === 'supersede' && change.match) {
        applied = d.memory.supersede(scope, change.match, change.text, date);
        if (!applied) {
          // nothing matched: fall back to a plain add so the fact is not lost
          d.memory.add(scope, change.text, date);
          applied = true;
        }
      } else {
        d.memory.add(scope, change.text, date);
        applied = true;
      }
      if (applied) {
        d.log.append({
          actor: 'walle',
          chat: null,
          type: 'memory_op',
          payload: {
            op: change.op,
            scope: scope.kind,
            ...(scope.kind === 'child' ? { child: scope.child } : {}),
            ...(scope.kind === 'private' ? { user } : {}),
            file: d.memory.relFileFor(scope),
            bullet: change.text,
            ...(change.match ? { replaces: change.match } : {}),
            source: 'curator',
            sourceChat: user,
          },
        });
      }
    }
  }
}
