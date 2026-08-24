import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Repos } from '../db/repos.js';
import type { MemoryStore } from '../memory/store.js';
import type { LedgerReader } from '../ledger/read.js';
import type { ChatMessage } from '../llm/client.js';
import type { User } from '../types/domain.js';
import { CHILDREN } from '../types/domain.js';
import { type Clock, riyadhIso, systemClock } from '../util/time.js';

const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

function loadPrompt(name: string): string {
  return fs.readFileSync(path.join(promptsDir, name), 'utf8');
}

/**
 * Per-user context assembly. Privacy is structural (hard rule 7): this
 * builder reads the shared file, the CURRENT user's private file, and the
 * child files. The other user's private file is never opened — the model
 * cannot leak what it was never given.
 */
export class ContextBuilder {
  private readonly core: string;
  private readonly personas: Record<User, string>;

  constructor(
    private readonly memory: MemoryStore,
    private readonly repos: Repos,
    private readonly ledger: LedgerReader,
    private readonly clock: Clock = systemClock,
  ) {
    this.core = loadPrompt('assistant.core.md');
    this.personas = {
      dan: loadPrompt('assistant.dan.md'),
      alina: loadPrompt('assistant.alina.md'),
    };
  }

  buildSystem(user: User): string {
    const sections: string[] = [this.core, this.personas[user]];

    sections.push(`## Now\nCurrent date and time in Riyadh: ${riyadhIso(this.clock.now())}`);

    const shared = this.memory.activeFacts({ kind: 'shared' });
    sections.push(`## Shared family memory\n${shared.join('\n') || '(nothing yet)'}`);

    const priv = this.memory.activeFacts({ kind: 'private', user });
    sections.push(`## ${cap(user)}'s private notes (never mention to anyone else)\n${priv.join('\n') || '(nothing yet)'}`);

    for (const child of CHILDREN) {
      sections.push(`## ${cap(child)}\n${this.memory.activeChildFile(child).trim()}`);
    }

    const items = this.repos.openItems();
    sections.push(
      `## Open items\n${
        items.length === 0
          ? '(none)'
          : items
              .map((i) => `- [${i.id}] ${i.title}${i.due ? ` (due ${i.due})` : ''}${i.child ? ` — ${cap(i.child)}` : ''}`)
              .join('\n')
      }`,
    );

    const pending = this.repos.pendingProposalsFor(user);
    if (pending.length > 0) {
      sections.push(
        `## Awaiting ${cap(user)}'s confirmation\n${pending
          .map((p) => `- [${p.id}] ${JSON.stringify(p.payload).slice(0, 200)}`)
          .join('\n')}`,
      );
    }

    const ledger = this.ledger.read();
    if (ledger.summary && ledger.fresh) {
      const total = Object.values(ledger.summary.monthToDate).reduce((a, b) => a + b, 0);
      sections.push(
        `## Spending (read-only, as of last sync)\nMonth to date: SAR ${Math.round(total)} across ${
          Object.keys(ledger.summary.monthToDate).length
        } categories.`,
      );
    }

    return sections.join('\n\n');
  }

  buildHistory(user: User, limit = 30): ChatMessage[] {
    return this.repos
      .recentChatTurns(user, limit)
      .map((t) => ({ role: t.direction === 'in' ? ('user' as const) : ('assistant' as const), content: t.text }));
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
