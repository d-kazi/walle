import type { Repos } from '../db/repos.js';
import type { AllowList } from '../identity/allowList.js';
import type { EventLog } from '../log/eventLog.js';
import type { ChannelSender, OutboundMessage, SendMode } from '../channel/types.js';
import type { User } from '../types/domain.js';
import { USERS } from '../types/domain.js';
import { type Clock, systemClock } from '../util/time.js';

const HOUR_MS = 60 * 60 * 1000;
/** Meta's customer service window */
const WINDOW_HOURS = 24;
/** scheduled sends switch to template pre-emptively past this silence (PRD §11) */
const PREEMPT_HOURS = 20;

export interface SendOptions {
  /** scheduled jobs pass true so window decay is pre-empted */
  scheduled?: boolean;
}

/**
 * The single choke point for every outbound message (hard rule 1). No other
 * module may call the channel sender. Asserts the recipient is one of the
 * two allow-listed users, decides freeform vs template from the recipient's
 * 24-hour window, and logs msg_out before the channel call.
 */
export class Outbound {
  constructor(
    private readonly sender: ChannelSender,
    private readonly allowList: AllowList,
    private readonly repos: Repos,
    private readonly log: EventLog,
    private readonly clock: Clock = systemClock,
    private readonly templateName = 'daily_brief',
  ) {}

  private decideMode(user: User, scheduled: boolean): SendMode {
    const last = this.repos.lastInboundTs(user);
    if (!last) return 'template';
    const ageHours = (this.clock.now().getTime() - new Date(last).getTime()) / HOUR_MS;
    if (ageHours >= WINDOW_HOURS) return 'template';
    if (scheduled && ageHours >= PREEMPT_HOURS) return 'template';
    return 'freeform';
  }

  async send(user: User, message: OutboundMessage, opts: SendOptions = {}): Promise<SendMode> {
    // Hard rule 1: the recipient must be one of the two users. The allow-list
    // is the only source of channel ids; an invalid user throws before any
    // channel code runs.
    if (!USERS.includes(user)) {
      this.log.append({
        actor: 'system',
        chat: null,
        type: 'error',
        payload: { kind: 'blocked_send', reason: 'recipient not allow-listed', user },
      });
      throw new Error(`Refusing to send: "${String(user)}" is not an allow-listed user`);
    }
    const to = this.allowList.waIdFor(user);
    const mode = this.decideMode(user, opts.scheduled ?? false);

    let text = message.text;
    if (mode === 'template' && message.buttons && message.buttons.length > 0) {
      // interactive buttons cannot ride a template; fall back to instructions
      const labels = message.buttons.map((b) => b.title).join(' / ');
      text = `${text}\nReply ${labels}.`;
    }

    this.log.append({
      actor: 'walle',
      chat: user,
      type: 'msg_out',
      payload: { kind: 'text', text, mode, scheduled: opts.scheduled ?? false },
    });

    try {
      if (mode === 'template') {
        await this.sender.sendTemplate(to, this.templateName, text);
      } else if (message.buttons && message.buttons.length > 0) {
        await this.sender.sendButtons(to, text, message.buttons);
      } else {
        await this.sender.sendText(to, text);
      }
    } catch (err) {
      this.log.append({
        actor: 'system',
        chat: user,
        type: 'error',
        payload: { kind: 'send_failed', message: String(err) },
      });
      throw err;
    }
    return mode;
  }
}
