import type { User } from '../types/domain.js';

/**
 * Channel-neutral message shapes (PRD §11: the WhatsApp adapter is the only
 * module that knows Meta exists; Telegram could replace it in a day).
 */

export type InboundKind =
  | 'text'
  | 'audio'
  | 'image'
  | 'document'
  | 'reaction'
  | 'button_reply';

export interface InboundMessage {
  /** resolved user, or null when the sender is not on the allow-list */
  user: User | null;
  /** raw channel sender id, kept for unknown-sender alerting */
  senderId: string;
  kind: InboundKind;
  text?: string;
  /** button reply id, e.g. p:{proposalId}:yes */
  buttonReplyId?: string;
  /** channel media id, to be downloaded by the adapter */
  mediaId?: string;
  mimeType?: string;
  caption?: string;
  emoji?: string;
  forwarded: boolean;
  providerMsgId: string;
  /** epoch seconds from the channel */
  timestamp: number;
}

export interface OutboundButton {
  id: string;
  title: string; // max 20 chars on WhatsApp
}

export interface OutboundMessage {
  text: string;
  buttons?: OutboundButton[];
}

export type SendMode = 'freeform' | 'template';

export interface SendResult {
  providerMsgId: string;
  mode: SendMode;
}

/**
 * The send side of a channel. `to` is the raw channel recipient id — the
 * outbound layer above this resolves users to ids and enforces the
 * allow-list; the channel just transports.
 */
export interface ChannelSender {
  sendText(to: string, text: string): Promise<SendResult>;
  sendButtons(to: string, text: string, buttons: OutboundButton[]): Promise<SendResult>;
  sendTemplate(to: string, templateName: string, bodyParam: string): Promise<SendResult>;
  /** cheap reachability check for job probes */
  probe(): Promise<boolean>;
}

export interface MediaFetcher {
  /** download channel media to a local file; returns path relative to DATA_DIR */
  download(mediaId: string, mimeType: string | undefined): Promise<string>;
}
