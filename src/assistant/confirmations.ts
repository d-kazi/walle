import crypto from 'node:crypto';
import type { Repos } from '../db/repos.js';
import type { EventLog } from '../log/eventLog.js';
import type { Outbound } from '../send/outbound.js';
import type { CalendarService } from '../google/types.js';
import type { CalendarEventDraft, Proposal, ProposalKind, User } from '../types/domain.js';
import { USERS, otherUser } from '../types/domain.js';
import { type Clock, riyadhDate, systemClock } from '../util/time.js';

/**
 * The Tier 2 gate. Every world-touching action becomes a proposal that a
 * user must confirm in chat before execution (hard rule 2). Button reply ids
 * encode the correlation: p:{proposalId}:{yes|no|change}. Plain-text answers
 * bind to the user's single most recent pending proposal.
 */
export class Confirmations {
  /** user → proposal id awaiting a free-text change description */
  private readonly pendingChange = new Map<User, string>();

  constructor(
    private readonly log: EventLog,
    private readonly repos: Repos,
    private readonly outbound: Outbound,
    private readonly calendar: CalendarService,
    private readonly clock: Clock = systemClock,
  ) {}

  async propose(
    kind: ProposalKind,
    payload: Record<string, unknown>,
    proposedTo: User | 'both',
    summary: string,
  ): Promise<string> {
    const id = crypto.randomUUID().slice(0, 8);
    this.log.append({
      actor: 'walle',
      chat: null,
      type: 'confirm_req',
      payload: { proposal: { id, kind, payload, proposedTo } },
    });
    const recipients: User[] = proposedTo === 'both' ? [...USERS] : [proposedTo];
    for (const user of recipients) {
      await this.outbound.send(user, {
        text: summary,
        buttons: [
          { id: `p:${id}:yes`, title: 'Yes' },
          { id: `p:${id}:no`, title: 'No' },
          { id: `p:${id}:change`, title: 'Change' },
        ],
      });
    }
    return id;
  }

  /** Handle an interactive button reply. Returns true when it was consumed. */
  async handleButtonReply(user: User, buttonReplyId: string): Promise<boolean> {
    const match = /^p:([a-z0-9-]+):(yes|no|change)$/.exec(buttonReplyId);
    if (!match) return false;
    await this.answer(user, match[1]!, match[2] as 'yes' | 'no' | 'change');
    return true;
  }

  /**
   * Try to interpret a plain-text message as an answer to the user's most
   * recent pending proposal. Returns true when consumed.
   */
  async handlePlainAnswer(user: User, text: string): Promise<boolean> {
    const t = text.trim().toLowerCase();
    let answer: 'yes' | 'no' | 'change' | null = null;
    if (/^(yes|y|1|yep|yeah|ok|okay|go ahead|confirm)\b[.!]?$/.test(t)) answer = 'yes';
    else if (/^(no|n|2|nope|don'?t|skip)\b[.!]?$/.test(t)) answer = 'no';
    else if (/^(change|3|edit|amend)\b[.!]?$/.test(t)) answer = 'change';
    if (!answer) return false;

    const pending = this.repos.pendingProposalsFor(user);
    if (pending.length === 0) return false;
    if (pending.length > 1 && answer !== 'no') {
      await this.outbound.send(user, {
        text: `I have ${pending.length} things waiting on you. Which one do you mean? ${pending
          .map((p, i) => `${i + 1}) ${describeProposal(p)}`)
          .join(' ')}`,
      });
      return true;
    }
    await this.answer(user, pending[pending.length - 1]!.id, answer);
    return true;
  }

  /** Is this user mid-"Change" on a proposal? Conversation checks this. */
  takePendingChange(user: User): string | null {
    const id = this.pendingChange.get(user) ?? null;
    this.pendingChange.delete(user);
    return id;
  }

  private async answer(user: User, proposalId: string, answer: 'yes' | 'no' | 'change'): Promise<void> {
    const proposal = this.repos.proposal(proposalId);
    if (!proposal) {
      await this.outbound.send(user, { text: `That one seems to have gone; nothing pending under it.` });
      return;
    }
    if (proposal.status !== 'pending') {
      const who =
        proposal.answeredBy && proposal.answeredBy !== user
          ? `already sorted by ${capitalise(proposal.answeredBy)}`
          : 'already handled';
      await this.outbound.send(user, { text: `That one is ${who}.` });
      return;
    }

    this.log.append({
      actor: user,
      chat: user,
      type: 'confirm_res',
      payload: { proposalId, answer, by: user },
    });

    if (answer === 'no') {
      await this.outbound.send(user, { text: 'Dropped, then.' });
      return;
    }
    if (answer === 'change') {
      this.pendingChange.set(user, proposalId);
      await this.outbound.send(user, { text: 'What should it be instead?' });
      return;
    }
    await this.execute(user, proposal);
  }

  private async execute(user: User, proposal: Proposal): Promise<void> {
    if (proposal.kind === 'calendar_event') {
      const draft = proposal.payload as unknown as CalendarEventDraft;
      try {
        const { id } = await this.calendar.createEvent(draft);
        this.log.append({
          actor: 'walle',
          chat: user,
          type: 'calendar_op',
          payload: {
            id,
            proposalId: proposal.id,
            op: 'create',
            calendar: draft.calendar,
            status: 'confirmed',
            draft: proposal.payload,
          },
        });
        await this.outbound.send(user, { text: `Done. ${draft.title} is in the calendar.` });
      } catch (err) {
        this.log.append({
          actor: 'system',
          chat: user,
          type: 'error',
          payload: { kind: 'calendar_create_failed', proposalId: proposal.id, message: String(err) },
        });
        await this.outbound.send(user, {
          text: `I couldn't write that to the calendar just now. I'll keep it on the list and you can ask me to retry.`,
        });
        return;
      }
    } else {
      const item = proposal.payload as {
        title?: string;
        owner?: string;
        child?: string | null;
        due?: string | null;
      };
      this.log.append({
        actor: 'walle',
        chat: user,
        type: 'intent',
        payload: {
          kind: 'open_item',
          op: 'create',
          item: {
            id: `oi-${proposal.id}`,
            title: item.title ?? 'Untitled',
            owner: item.owner ?? 'both',
            child: item.child ?? null,
            due: item.due ?? null,
          },
        },
      });
      await this.outbound.send(user, { text: `Noted. I'll chase it${item.due ? ` before ${item.due}` : ''}.` });
    }
  }

  /** Expire pending proposals older than 72h; resurfaced once by the morning brief. */
  expireStale(): void {
    const cutoff = this.clock.now().getTime() - 72 * 3_600_000;
    for (const p of this.repos.pendingProposals()) {
      if (new Date(p.createdTs).getTime() < cutoff) {
        this.log.append({
          actor: 'system',
          chat: null,
          type: 'trigger',
          payload: { kind: 'proposal_expired', proposalId: p.id },
        });
      }
    }
  }
}

export function describeProposal(p: Proposal): string {
  const payload = p.payload as { title?: string };
  return payload.title ?? p.kind;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
