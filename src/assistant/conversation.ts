import type { EnrichedInbound } from '../ingress/inbound.js';
import type { EventLog } from '../log/eventLog.js';
import type { Repos } from '../db/repos.js';
import type { MemoryStore } from '../memory/store.js';
import type { LedgerReader } from '../ledger/read.js';
import type { CalendarService, DriveService, PersonalInbox } from '../google/types.js';
import type { LlmClient } from '../llm/client.js';
import type { Outbound } from '../send/outbound.js';
import type { Confirmations } from './confirmations.js';
import { ContextBuilder } from './context.js';
import { buildTools } from './tools.js';
import { runToolLoop } from '../llm/toolLoop.js';
import { explicitScope } from '../memory/router.js';
import { fenceUntrusted } from '../llm/untrusted.js';
import { parseChildTimeAnswer, recordChildTime } from '../childtime/capture.js';
import { type Clock, riyadhDate, systemClock } from '../util/time.js';

/**
 * Per-user conversational turn: confirmations first, then possible
 * child-time answer, then the assistant tool loop. All replies leave through
 * the outbound choke point.
 */
export class Conversation {
  private readonly contextBuilder: ContextBuilder;

  constructor(
    private readonly deps: {
      log: EventLog;
      repos: Repos;
      memory: MemoryStore;
      ledger: LedgerReader;
      calendar: CalendarService;
      drive?: DriveService;
      personalInbox?: PersonalInbox;
      llm: LlmClient;
      outbound: Outbound;
      confirmations: Confirmations;
      clock?: Clock;
    },
  ) {
    this.contextBuilder = new ContextBuilder(
      deps.memory,
      deps.repos,
      deps.ledger,
      deps.clock ?? systemClock,
    );
  }

  private get clock(): Clock {
    return this.deps.clock ?? systemClock;
  }

  async handle(inbound: EnrichedInbound): Promise<void> {
    const { user } = inbound;
    const d = this.deps;

    // 1. Button replies (Tier 2 confirmations)
    if (inbound.message.kind === 'button_reply' && inbound.message.buttonReplyId) {
      const consumed = await d.confirmations.handleButtonReply(
        user,
        inbound.message.buttonReplyId,
      );
      if (consumed) return;
    }

    const text = inbound.effectiveText.trim();
    if (!text) return;

    // 2. A user mid-"Change" on a proposal: their next free text describes the change
    const changingProposal = d.confirmations.takePendingChange(user);

    // 3. Plain-text yes/no/change to the most recent pending proposal
    if (!changingProposal && (await d.confirmations.handlePlainAnswer(user, text))) return;

    // 4. Evening child-time answer, only while the question is open:
    //    evening brief sent today, and this user has no rows for today yet.
    if (!changingProposal && (await this.tryChildTime(user, text))) return;

    // 5. The assistant loop
    const forced = explicitScope(text, user);
    const system = this.contextBuilder.buildSystem(user);
    const history = this.contextBuilder.buildHistory(user, 30);

    let turnText = text;
    if (inbound.message.forwarded) {
      turnText = fenceUntrusted(text, 'forwarded-message');
    }
    if (changingProposal) {
      const proposal = d.repos.proposal(changingProposal);
      turnText =
        `The user asked to change this pending proposal: ${JSON.stringify(proposal?.payload ?? {})}\n` +
        `Their change: ${text}\n` +
        `Create the corrected proposal with your tools.`;
    }
    // history already ends with this inbound message (it was logged before
    // dispatch); replace the last user turn with the annotated version
    const messages = [...history];
    if (messages.length > 0 && messages[messages.length - 1]!.role === 'user') {
      messages[messages.length - 1] = { role: 'user', content: turnText };
    } else {
      messages.push({ role: 'user', content: turnText });
    }

    const tools = buildTools({
      log: d.log,
      repos: d.repos,
      memory: d.memory,
      ledger: d.ledger,
      calendar: d.calendar,
      confirmations: d.confirmations,
      ...(d.drive ? { drive: d.drive } : {}),
      ...(d.personalInbox ? { personalInbox: d.personalInbox } : {}),
      clock: this.clock,
      ctx: { user, forcedScope: forced?.scope ?? null },
    });

    let reply: string;
    try {
      reply = await runToolLoop(d.llm, 'assistant', system, messages, tools);
    } catch (err) {
      d.log.append({
        actor: 'system',
        chat: user,
        type: 'error',
        payload: { kind: 'assistant_failed', message: String(err) },
      });
      reply = "Sorry, I hit a snag processing that. It's logged; try me again in a minute.";
    }
    if (reply.trim()) {
      await d.outbound.send(user, { text: reply.trim() });
    }
  }

  private async tryChildTime(user: EnrichedInbound['user'], text: string): Promise<boolean> {
    const d = this.deps;
    const today = riyadhDate(this.clock.now());
    const eveningSent = d.repos.lastBriefTs(user, 'evening');
    if (!eveningSent || eveningSent.slice(0, 10) !== today) return false;
    const already = d.repos
      .childTimeForDate(today)
      .some((row) => row.reporter === user);
    if (already) return false;
    try {
      const parsed = await parseChildTimeAnswer(d.llm, d.log, text);
      if (!parsed.isAnswer) return false;
      recordChildTime(d.log, user, today, parsed.entries);
      await d.outbound.send(user, { text: 'Noted.' });
      return true;
    } catch {
      return false; // fall through to the assistant
    }
  }
}
