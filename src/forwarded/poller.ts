import type { EventLog } from '../log/eventLog.js';
import type { Repos } from '../db/repos.js';
import type { ForwardInbox, SchoolEmail } from '../google/types.js';
import type { Confirmations } from '../assistant/confirmations.js';
import type { User } from '../types/domain.js';
import { type Clock, riyadhIso, systemClock } from '../util/time.js';

const LOOKBACK_DAYS = 3;
/** Gmail purges Trash at 30 days; look back that far so an outage loses nothing */
const REFUSED_LOOKBACK_DAYS = 30;

export type ForwardHandler = (user: User, email: SchoolEmail) => Promise<void>;

/**
 * The one dedicated mailbox (PRD amendment). School mail lands here, by
 * direct address or auto-forward; Dan and Alina forward anything else they
 * want read in full; a Gmail filter sends every other sender straight to
 * Trash.
 *
 * Two lanes:
 *  - INBOX: mail from an accepted sender. A school keyword in From, Subject
 *    or body routes it to the school pipeline (proposals to both parents);
 *    otherwise it is read in full and answered in the forwarder's chat.
 *  - TRASH: mail Gmail refused. Listed metadata-only, so a stranger's body is
 *    never fetched. Sender and subject go to both parents as a Tier 2
 *    proposal; only an explicit Yes causes the body to be read. Ignore it
 *    and Gmail purges it on its own after 30 days — Wall-E holds no delete
 *    scope and never destroys anything.
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
      /** lowercased; a hit marks school mail */
      schoolKeywords: string[];
      /** school mail: classify, extract, propose to both */
      school: (email: SchoolEmail) => Promise<void>;
      /** everything else from an accepted sender: answer in their chat */
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

  private since(days = LOOKBACK_DAYS): string {
    return riyadhIso(new Date(this.clock.now().getTime() - days * 86_400_000));
  }

  /** School mail is recognised by keyword, wherever it came from. */
  isSchoolMail(email: Pick<SchoolEmail, 'from' | 'subject'> & { body?: string }): boolean {
    return isSchoolMail(email, this.deps.schoolKeywords);
  }

  /**
   * Route one accepted email: school pipeline or the forwarder's chat. Used
   * by the poll and by the approval callback for mail that was binned.
   */
  async dispatch(user: User, email: SchoolEmail): Promise<void> {
    const d = this.deps;
    if (this.isSchoolMail(email)) {
      try {
        await d.school(email);
      } catch (err) {
        d.log.append({
          actor: 'system',
          chat: null,
          type: 'error',
          payload: { kind: 'school_email_failed', msgId: email.msgId, message: String(err) },
        });
      }
      return;
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

  /**
   * Resolve a From header to a user: the two configured addresses, plus any
   * sender approved since. School-domain mail addressed here directly has no
   * user; the keyword route accepts it before this is consulted.
   */
  resolveSender(fromHeader: string): User | null {
    const address = extractAddress(fromHeader);
    if (!address) return null;
    const direct = this.allowed.get(address);
    if (direct) return direct;
    // an approved sender is answered in the chat of whoever approved it —
    // Alina's work alias must not start replying into Dan's chat
    const decided = this.deps.repos.emailSender(address);
    return decided?.status === 'allowed' ? decided.approvedBy : null;
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
      if (!user && !this.isSchoolMail(email)) {
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
      // school mail addressed here directly has no forwarding user; the
      // school pipeline answers both parents, so the placeholder is unused
      await this.dispatch(user ?? 'dan', email);
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
      refused = await d.inbox.listRefused(this.since(REFUSED_LOOKBACK_DAYS));
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
      if (d.repos.emailSender(address) !== null) continue; // already decided
      if (asked.has(address)) continue; // one question per sender per run
      asked.add(address);
      // both parents are asked: an unexpected sender may be either one's
      // alias, and whoever answers owns the follow-up
      const school = this.isSchoolMail(email);
      await d.confirmations.propose(
        'forwarded_email',
        { msgId: email.msgId, address, subject: email.subject, title: `Mail from ${address}` },
        'both',
        school
          ? `Something that looks like school mail landed in the Wall-E bin, from ${address}, subject "${truncate(email.subject, 60)}". The Gmail filter should be letting that sender through. I have not opened it. Read and act on it?`
          : `Something reached the Wall-E address from ${address}, subject "${truncate(email.subject, 60)}". I have not opened it. Read and act on it?`,
      );
    }
  }
}

/** Case-insensitive keyword hit in From, Subject or the head of the body. */
export function isSchoolMail(
  email: Pick<SchoolEmail, 'from' | 'subject'> & { body?: string },
  keywords: string[],
): boolean {
  if (keywords.length === 0) return false;
  const hay = `${email.from}\n${email.subject}\n${(email.body ?? '').slice(0, 2000)}`.toLowerCase();
  return keywords.some((k) => hay.includes(k));
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
