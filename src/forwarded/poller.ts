import type { EventLog } from '../log/eventLog.js';
import type { Repos } from '../db/repos.js';
import type { ForwardInbox, SchoolEmail } from '../google/types.js';
import type { Confirmations } from '../assistant/confirmations.js';
import type { User } from '../types/domain.js';
import { type Clock, riyadhIso, systemClock } from '../util/time.js';

const LOOKBACK_DAYS = 3;

export type ForwardHandler = (user: User, email: SchoolEmail) => Promise<void>;

/**
 * The dedicated forwarding mailbox (PRD amendment). Dan and Alina forward
 * anything they want read in full; a Gmail filter sends everything else
 * straight to Trash.
 *
 * Two lanes:
 *  - INBOX: mail from an allowed address, read in full and answered in that
 *    person's chat.
 *  - TRASH: mail Gmail refused. Listed metadata-only, so a stranger's body is
 *    never fetched. Sender and subject go to Dan as a Tier 2 proposal; only
 *    an explicit Yes causes the body to be read. Ignore it and Gmail purges
 *    it on its own after 30 days — Wall-E holds no delete scope and never
 *    destroys anything.
 */
export class ForwardedPipeline {
  private readonly allowed: Map<string, User>;

  constructor(
    private readonly deps: {
      log: EventLog;
      repos: Repos;
      inbox: ForwardInbox;
      confirmations: Confirmations;
      emailDan: string;
      emailAlina: string;
      handler: ForwardHandler;
      clock?: Clock;
    },
  ) {
    this.allowed = new Map([
      [deps.emailDan.toLowerCase(), 'dan' as User],
      [deps.emailAlina.toLowerCase(), 'alina' as User],
    ]);
  }

  private get clock(): Clock {
    return this.deps.clock ?? systemClock;
  }

  private since(): string {
    return riyadhIso(new Date(this.clock.now().getTime() - LOOKBACK_DAYS * 86_400_000));
  }

  /** Resolve a From header to a user: the two configured addresses, plus any sender approved since. */
  resolveSender(fromHeader: string): User | null {
    const address = extractAddress(fromHeader);
    if (!address) return null;
    const direct = this.allowed.get(address);
    if (direct) return direct;
    // an approved unexpected sender is treated as Dan's, since Dan is the
    // one who approved it
    return this.deps.repos.emailSenderStatus(address) === 'allowed' ? 'dan' : null;
  }

  async poll(): Promise<void> {
    await this.pollDelivered();
    await this.pollRefused();
  }

  private async pollDelivered(): Promise<void> {
    const d = this.deps;
    let emails: SchoolEmail[];
    try {
      emails = await d.inbox.listNewEmails(this.since());
    } catch (err) {
      d.log.append({
        actor: 'system',
        chat: null,
        type: 'error',
        payload: { kind: 'forward_poll_failed', message: String(err) },
      });
      return;
    }
    for (const email of emails) {
      if (d.repos.hasEmail(email.msgId)) continue;
      const user = this.resolveSender(email.from);
      if (!user) {
        // reached the inbox despite the filter: log it, act on nothing
        d.log.append({
          actor: 'system',
          chat: null,
          type: 'email_in',
          payload: {
            msgId: email.msgId,
            from: email.from,
            subject: email.subject,
            date: email.date,
            kind: 'forwarded',
            refused: true,
          },
        });
        continue;
      }
      d.log.append({
        actor: user,
        chat: user,
        type: 'email_in',
        payload: {
          msgId: email.msgId,
          from: email.from,
          subject: email.subject,
          date: email.date,
          kind: 'forwarded',
        },
      });
      try {
        await d.handler(user, email);
      } catch (err) {
        d.log.append({
          actor: 'system',
          chat: user,
          type: 'error',
          payload: { kind: 'forward_handle_failed', msgId: email.msgId, message: String(err) },
        });
      }
    }
  }

  /**
   * Mail Gmail's filter binned. Metadata only. One Tier 2 proposal to Dan per
   * unexpected sender; a sender already decided on is not asked about again.
   */
  private async pollRefused(): Promise<void> {
    const d = this.deps;
    let refused: Array<Omit<SchoolEmail, 'body'>>;
    try {
      refused = await d.inbox.listRefused(this.since());
    } catch (err) {
      d.log.append({
        actor: 'system',
        chat: null,
        type: 'error',
        payload: { kind: 'forward_trash_poll_failed', message: String(err) },
      });
      return;
    }
    const asked = new Set<string>();
    for (const email of refused) {
      const address = extractAddress(email.from);
      if (!address) continue;
      if (this.allowed.has(address)) continue; // ours, just binned by hand
      if (d.repos.emailSenderStatus(address) !== null) continue; // already decided
      if (asked.has(address)) continue; // one question per sender per run
      asked.add(address);
      await d.confirmations.propose(
        'forwarded_email',
        { msgId: email.msgId, address, subject: email.subject, title: `Mail from ${address}` },
        'dan',
        `Something reached the Wall-E address from ${address}, subject "${truncate(email.subject, 60)}". I have not opened it. Read and act on it?`,
      );
    }
  }
}

/** "Dan Kaziyev <dan@example.com>" → "dan@example.com" */
export function extractAddress(fromHeader: string): string | null {
  const angled = /<([^>]+)>/.exec(fromHeader);
  const raw = (angled?.[1] ?? fromHeader).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
