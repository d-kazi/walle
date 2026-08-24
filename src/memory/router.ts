import { z } from 'zod';
import type { EventLog } from '../log/eventLog.js';
import type { LlmClient } from '../llm/client.js';
import { structuredCall } from '../llm/structured.js';
import type { Child, MemoryScope, User } from '../types/domain.js';
import { otherUser } from '../types/domain.js';

/**
 * Scope resolution for captured facts (PRD §7). Explicit phrases are matched
 * deterministically in code BEFORE any model call — the privacy-critical
 * paths never depend on model judgment. The LLM classifies only the residue.
 */

export interface RoutedScope {
  scope: MemoryScope;
  explicit: boolean;
  /** true when classification confidence was low → ask one short question */
  needsClarification: boolean;
}

const CHILD_NAMES: Record<string, Child> = {
  dylan: 'dylan',
  caspian: 'caspian',
  maxie: 'maxie',
  max: 'maxie',
};

/** Deterministic explicit-phrase routing. Returns null when no phrase matched. */
export function explicitScope(text: string, user: User): RoutedScope | null {
  const t = text.toLowerCase();

  // "just for me" / "private" / "don't mention to <other>" → private
  if (
    /\bjust for me\b/.test(t) ||
    /\bjust between us\b/.test(t) ||
    /\bkeep (this|it) private\b/.test(t) ||
    /\bprivate note\b/.test(t) ||
    /\bdon'?t (tell|mention|say)\b.*\b(her|him|alina|dan|mum|mom|dad)\b/.test(t) ||
    /\bnot a word to\b/.test(t)
  ) {
    return { scope: { kind: 'private', user }, explicit: true, needsClarification: false };
  }

  // "remember for Dylan" / "for Caspian's file"
  const childMatch = /\b(?:remember|note|add)\b[^.]*\bfor\s+(dylan|caspian|maxie|max)\b/.exec(t);
  if (childMatch) {
    return {
      scope: { kind: 'child', child: CHILD_NAMES[childMatch[1]!]! },
      explicit: true,
      needsClarification: false,
    };
  }

  // "tell Alina's brief…" / "tell Dan's brief…" → shared (surfaces in the other brief)
  if (new RegExp(`\\btell\\s+${otherUser(user)}(?:'s)?\\s+brief\\b`).test(t)) {
    return { scope: { kind: 'shared' }, explicit: true, needsClarification: false };
  }

  // "add to the shared list"
  if (/\b(add|put)\b.*\bshared list\b/.test(t) || /\bshared list\b.*\badd\b/.test(t)) {
    return { scope: { kind: 'shared' }, explicit: true, needsClarification: false };
  }

  return null;
}

const classificationSchema = z.object({
  scope: z.enum(['shared', 'private', 'child']),
  child: z.enum(['dylan', 'caspian', 'maxie']).nullable(),
  confidence: z.enum(['high', 'low']),
});

const CLASSIFY_SYSTEM = `You classify a fact captured by a family assistant into a memory scope.
The household: Dan and Alina (the parents), children Dylan, Caspian, Maxie.
Rules, in order:
1. "private" for anything about the OTHER partner (feelings, gifts, surprises, work confidences), anything the speaker frames as sensitive, or anything that would spoil a surprise if the other partner read it.
2. "child" for facts about one specific child that belong in that child's file (school notes, health, preferences, quarter plans).
3. "shared" is the default for family logistics: kids' schedules, school events, home, appointments, travel.
Set confidence "low" only when genuinely torn between shared and private.`;

export async function classifyScope(
  client: LlmClient,
  log: EventLog,
  text: string,
  user: User,
): Promise<RoutedScope> {
  const result = await structuredCall(client, log, {
    task: 'memory_route',
    system: CLASSIFY_SYSTEM,
    user: `Speaker: ${user}. The other partner is ${otherUser(user)}.\nFact: ${text}`,
    schema: classificationSchema,
    schemaDescription: `{"scope": "shared" | "private" | "child", "child": "dylan" | "caspian" | "maxie" | null, "confidence": "high" | "low"}`,
  });
  const scope: MemoryScope =
    result.scope === 'child' && result.child
      ? { kind: 'child', child: result.child }
      : result.scope === 'private'
        ? { kind: 'private', user }
        : { kind: 'shared' };
  return { scope, explicit: false, needsClarification: result.confidence === 'low' };
}

export async function routeScope(
  client: LlmClient,
  log: EventLog,
  text: string,
  user: User,
): Promise<RoutedScope> {
  return explicitScope(text, user) ?? (await classifyScope(client, log, text, user));
}
