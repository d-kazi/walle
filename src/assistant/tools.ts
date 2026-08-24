import crypto from 'node:crypto';
import type { EventLog } from '../log/eventLog.js';
import type { Repos } from '../db/repos.js';
import type { MemoryStore } from '../memory/store.js';
import type { LedgerReader } from '../ledger/read.js';
import type { CalendarService } from '../google/types.js';
import type { Confirmations } from './confirmations.js';
import type { ToolHandler } from '../llm/toolLoop.js';
import type { Child, MemoryScope, User } from '../types/domain.js';
import { CHILDREN } from '../types/domain.js';
import { recordChildTime } from '../childtime/capture.js';
import { type Clock, riyadhDate, riyadhIso, systemClock } from '../util/time.js';

export interface ToolContext {
  user: User;
  /** scope forced by a deterministic explicit phrase; overrides the model */
  forcedScope: MemoryScope | null;
}

/**
 * The assistant's whole tool surface. Each handler enforces tier rules in
 * code: Tier 1 tools write only to our own log/memory; the Tier 2 path
 * (calendar) only ever creates a proposal for the confirmation gate.
 */
export function buildTools(deps: {
  log: EventLog;
  repos: Repos;
  memory: MemoryStore;
  ledger: LedgerReader;
  calendar: CalendarService;
  confirmations: Confirmations;
  clock?: Clock;
  ctx: ToolContext;
}): ToolHandler[] {
  const clock = deps.clock ?? systemClock;
  const { ctx } = deps;

  const remember: ToolHandler = {
    def: {
      name: 'remember',
      description:
        'Store a durable fact in family memory. Scope: shared (family logistics, visible in both briefs), private (only this user, never the other), child (a specific child\'s file, visible to both parents).',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['shared', 'private', 'child'] },
          child: { type: 'string', enum: [...CHILDREN], description: 'required when scope is child' },
          text: { type: 'string', description: 'the fact, one plain sentence' },
        },
        required: ['scope', 'text'],
        additionalProperties: false,
      },
    },
    async run(args) {
      const text = String(args.text ?? '').trim();
      if (!text) return { error: 'empty fact' };
      let scope: MemoryScope;
      if (ctx.forcedScope) {
        // deterministic explicit-phrase routing beats the model (PRD §7)
        scope = ctx.forcedScope;
      } else if (args.scope === 'private') {
        scope = { kind: 'private', user: ctx.user };
      } else if (args.scope === 'child' && CHILDREN.includes(args.child as Child)) {
        scope = { kind: 'child', child: args.child as Child };
      } else {
        scope = { kind: 'shared' };
      }
      const date = riyadhDate(clock.now());
      deps.memory.add(scope, text, date);
      deps.log.append({
        actor: ctx.user,
        chat: ctx.user,
        type: 'memory_op',
        payload: {
          op: 'add',
          scope: scope.kind,
          ...(scope.kind === 'child' ? { child: scope.child } : {}),
          ...(scope.kind === 'private' ? { user: scope.user } : {}),
          file: deps.memory.relFileFor(scope),
          bullet: text,
          forced: ctx.forcedScope !== null,
        },
      });
      return { stored: true, scope: scope.kind };
    },
  };

  const listOpenItems: ToolHandler = {
    def: {
      name: 'list_open_items',
      description: 'List open items (things being chased), with ids and due dates.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run() {
      return { items: deps.repos.openItems() };
    },
  };

  const createOpenItem: ToolHandler = {
    def: {
      name: 'create_open_item',
      description: 'Create an open item to track and chase. Use for deadlines and to-dos.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          due: { type: 'string', description: 'YYYY-MM-DD, omit if none' },
          child: { type: 'string', enum: [...CHILDREN] },
          owner: { type: 'string', enum: ['dan', 'alina', 'both'] },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    async run(args) {
      const id = `oi-${crypto.randomUUID().slice(0, 8)}`;
      deps.log.append({
        actor: ctx.user,
        chat: ctx.user,
        type: 'intent',
        payload: {
          kind: 'open_item',
          op: 'create',
          item: {
            id,
            title: String(args.title ?? 'Untitled'),
            owner: (args.owner as string) ?? 'both',
            child: CHILDREN.includes(args.child as Child) ? (args.child as string) : null,
            due: typeof args.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.due) ? args.due : null,
          },
        },
      });
      return { created: id };
    },
  };

  const completeOpenItem: ToolHandler = {
    def: {
      name: 'complete_open_item',
      description: 'Mark an open item done (stops any chasing).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async run(args) {
      const item = deps.repos.openItem(String(args.id ?? ''));
      if (!item) return { error: 'no such item' };
      deps.log.append({
        actor: ctx.user,
        chat: ctx.user,
        type: 'intent',
        payload: { kind: 'open_item', op: 'complete', item: { id: item.id } },
      });
      return { done: item.id };
    },
  };

  const readCalendar: ToolHandler = {
    def: {
      name: 'read_calendar',
      description: "Read both adults' Google calendars for the coming days.",
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'how many days ahead, default 7' },
        },
        additionalProperties: false,
      },
    },
    async run(args) {
      const days = typeof args.days === 'number' && args.days > 0 ? Math.min(args.days, 31) : 7;
      const from = clock.now();
      const to = new Date(from.getTime() + days * 24 * 3_600_000);
      const events = [
        ...(await deps.calendar.listEvents('dan', riyadhIso(from), riyadhIso(to))),
        ...(await deps.calendar.listEvents('alina', riyadhIso(from), riyadhIso(to))),
      ].sort((a, b) => a.start.localeCompare(b.start));
      return { events };
    },
  };

  const proposeCalendarEvent: ToolHandler = {
    def: {
      name: 'propose_calendar_event',
      description:
        'Propose a calendar event. Tier 2: this only asks the user to confirm with Yes/No/Change buttons; nothing is written until they say Yes. Never claim the event is booked.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: { type: 'string', description: 'ISO datetime with +03:00 offset' },
          end: { type: 'string', description: 'ISO datetime with +03:00 offset' },
          calendar: { type: 'string', enum: ['dan', 'alina'] },
          description: { type: 'string' },
        },
        required: ['title', 'start', 'end', 'calendar'],
        additionalProperties: false,
      },
    },
    async run(args) {
      const draft = {
        title: String(args.title ?? ''),
        start: String(args.start ?? ''),
        end: String(args.end ?? ''),
        calendar: args.calendar === 'alina' ? 'alina' : 'dan',
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
      };
      if (!draft.title || !draft.start || !draft.end) return { error: 'missing fields' };
      const id = await deps.confirmations.propose(
        'calendar_event',
        draft,
        ctx.user,
        `Add to ${draft.calendar === 'dan' ? "Dan's" : "Alina's"} calendar: ${draft.title}, ${draft.start.slice(0, 16).replace('T', ' ')}?`,
      );
      return { proposalId: id, awaitingConfirmation: true };
    },
  };

  const readLedger: ToolHandler = {
    def: {
      name: 'read_ledger_summary',
      description: 'Read the household spending summary (read-only, synced from the local ledger).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run() {
      const verdict = deps.ledger.read();
      if (!verdict.summary) return { available: false };
      return {
        available: true,
        fresh: verdict.fresh,
        lastSync: verdict.summary.lastSync,
        monthToDate: verdict.summary.monthToDate,
        notableDeltas: verdict.summary.notableDeltas,
      };
    },
  };

  const setChildTime: ToolHandler = {
    def: {
      name: 'set_child_time',
      description:
        'Record today\'s one-to-one time per child, three coarse levels only: proper, some, none.',
      parameters: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                child: { type: 'string', enum: [...CHILDREN] },
                level: { type: 'string', enum: ['proper', 'some', 'none'] },
              },
              required: ['child', 'level'],
              additionalProperties: false,
            },
          },
        },
        required: ['entries'],
        additionalProperties: false,
      },
    },
    async run(args) {
      const entries = (Array.isArray(args.entries) ? args.entries : []).filter(
        (e): e is { child: Child; level: 'proper' | 'some' | 'none' } =>
          CHILDREN.includes((e as { child: Child }).child) &&
          ['proper', 'some', 'none'].includes((e as { level: string }).level),
      );
      if (entries.length === 0) return { error: 'no valid entries' };
      recordChildTime(deps.log, ctx.user, riyadhDate(clock.now()), entries);
      return { recorded: entries.length };
    },
  };

  return [
    remember,
    listOpenItems,
    createOpenItem,
    completeOpenItem,
    readCalendar,
    proposeCalendarEvent,
    readLedger,
    setChildTime,
  ];
}
