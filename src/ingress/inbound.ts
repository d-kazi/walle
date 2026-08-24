import type { Repos } from '../db/repos.js';
import type { AllowList } from '../identity/allowList.js';
import type { EventLog } from '../log/eventLog.js';
import type { InboundMessage, MediaFetcher } from '../channel/types.js';
import type { Outbound } from '../send/outbound.js';
import type { User } from '../types/domain.js';
import { type Clock, systemClock } from '../util/time.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface Transcriber {
  transcribe(absolutePath: string): Promise<string>;
}

/** An inbound message after enrichment, handed to the conversation layer. */
export interface EnrichedInbound {
  user: User;
  message: InboundMessage;
  /** transcript for audio, caption-or-text otherwise */
  effectiveText: string;
  mediaRef?: string;
}

export type InboundHandler = (inbound: EnrichedInbound) => Promise<void>;

/**
 * Neutral inbound pipeline: idempotency → allow-list → media/transcription →
 * msg_in event → dispatch. The webhook (or the dev simulator) has already
 * logged the raw arrival; this stage owns per-message processing.
 */
export class Ingress {
  constructor(
    private readonly log: EventLog,
    private readonly repos: Repos,
    private readonly allowList: AllowList,
    private readonly media: MediaFetcher,
    private readonly transcriber: Transcriber,
    private readonly outbound: Outbound,
    private readonly dataDir: string,
    private readonly handler: InboundHandler,
    private readonly clock: Clock = systemClock,
  ) {}

  async process(messages: InboundMessage[]): Promise<void> {
    for (const msg of messages) {
      try {
        await this.processOne(msg);
      } catch (err) {
        this.log.append({
          actor: 'system',
          chat: null,
          type: 'error',
          payload: { kind: 'ingress_failed', providerMsgId: msg.providerMsgId, message: String(err) },
        });
      }
    }
  }

  private async processOne(msg: InboundMessage): Promise<void> {
    // Idempotency on Meta retries: the raw arrival is already in the log;
    // a message id we've processed gets no second msg_in and no dispatch.
    if (msg.providerMsgId && this.repos.hasProcessedMessage(msg.providerMsgId)) return;

    const user = this.allowList.resolveUser(msg.senderId);
    if (!user) {
      await this.handleUnknownSender(msg);
      return;
    }

    let mediaRef: string | undefined;
    let transcript: string | undefined;
    if (msg.mediaId && (msg.kind === 'audio' || msg.kind === 'image' || msg.kind === 'document')) {
      try {
        mediaRef = await this.media.download(msg.mediaId, msg.mimeType);
      } catch (err) {
        this.log.append({
          actor: 'system',
          chat: user,
          type: 'error',
          payload: { kind: 'media_download_failed', message: String(err) },
        });
      }
      if (mediaRef && msg.kind === 'audio') {
        try {
          transcript = await this.transcriber.transcribe(`${this.dataDir}/${mediaRef}`);
        } catch (err) {
          this.log.append({
            actor: 'system',
            chat: user,
            type: 'error',
            payload: { kind: 'transcription_failed', message: String(err) },
          });
        }
      }
    }

    const effectiveText = transcript ?? msg.text ?? msg.caption ?? '';

    this.log.append({
      actor: user,
      chat: user,
      type: 'msg_in',
      payload: {
        kind: msg.kind,
        ...(effectiveText ? { text: effectiveText } : {}),
        ...(transcript ? { transcribed: true } : {}),
        ...(msg.buttonReplyId ? { buttonReplyId: msg.buttonReplyId } : {}),
        ...(msg.forwarded ? { forwarded: true } : {}),
        ...(msg.emoji ? { emoji: msg.emoji } : {}),
      },
      ...(msg.providerMsgId ? { wa_msg_id: msg.providerMsgId } : {}),
      ...(mediaRef ? { media_ref: mediaRef } : {}),
    });

    // reactions are log-only (PRD §3)
    if (msg.kind === 'reaction') return;

    await this.handler({
      user,
      message: msg,
      effectiveText,
      ...(mediaRef ? { mediaRef } : {}),
    });
  }

  private async handleUnknownSender(msg: InboundMessage): Promise<void> {
    // Log the event, send the sender nothing, alert Dan once per number per week.
    const { lastAlertTs } = this.repos.unknownSenderLastAlert(msg.senderId);
    this.log.append({
      actor: 'system',
      chat: null,
      type: 'msg_in',
      payload: { kind: msg.kind, unknownWaId: msg.senderId },
      ...(msg.providerMsgId ? { wa_msg_id: msg.providerMsgId } : {}),
    });
    const now = this.clock.now().getTime();
    const due = !lastAlertTs || now - new Date(lastAlertTs).getTime() >= WEEK_MS;
    if (!due) return;
    this.log.append({
      actor: 'system',
      chat: 'dan',
      type: 'trigger',
      payload: { kind: 'unknown_sender_alert', waId: msg.senderId },
    });
    await this.outbound.send('dan', {
      text: `A number I don't know messaged me (${maskWaId(msg.senderId)}). I've ignored it and will keep ignoring it. I'll only mention each unknown number once a week.`,
    });
  }
}

function maskWaId(waId: string): string {
  return waId.length > 4 ? `…${waId.slice(-4)}` : waId;
}
