import type { InboundMessage } from '../types.js';

/**
 * Meta Cloud API webhook payload → neutral InboundMessage list.
 * This file (and its siblings) are the only place Meta's shapes appear.
 * User resolution (allow-list) happens upstream in ingress; here user is
 * always null and senderId carries the wa_id.
 */

interface MetaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string };
  image?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; caption?: string; filename?: string };
  reaction?: { message_id: string; emoji?: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { payload?: string; text?: string };
  context?: { forwarded?: boolean; frequently_forwarded?: boolean };
}

export function parseWebhookPayload(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (body as { entry?: Array<{ changes?: Array<{ value?: unknown }> }> })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value as { messages?: MetaMessage[] } | undefined;
      for (const msg of value?.messages ?? []) {
        const parsed = parseMessage(msg);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}

function parseMessage(msg: MetaMessage): InboundMessage | null {
  const base = {
    user: null,
    senderId: msg.from,
    forwarded: Boolean(msg.context?.forwarded || msg.context?.frequently_forwarded),
    providerMsgId: msg.id,
    timestamp: parseInt(msg.timestamp, 10) || 0,
  } as const;

  switch (msg.type) {
    case 'text':
      return { ...base, kind: 'text', text: msg.text?.body ?? '' };
    case 'audio':
      return {
        ...base,
        kind: 'audio',
        ...(msg.audio?.id !== undefined ? { mediaId: msg.audio.id } : {}),
        ...(msg.audio?.mime_type !== undefined ? { mimeType: msg.audio.mime_type } : {}),
      };
    case 'image':
      return {
        ...base,
        kind: 'image',
        ...(msg.image?.id !== undefined ? { mediaId: msg.image.id } : {}),
        ...(msg.image?.mime_type !== undefined ? { mimeType: msg.image.mime_type } : {}),
        ...(msg.image?.caption !== undefined ? { caption: msg.image.caption } : {}),
      };
    case 'document':
      return {
        ...base,
        kind: 'document',
        ...(msg.document?.id !== undefined ? { mediaId: msg.document.id } : {}),
        ...(msg.document?.mime_type !== undefined ? { mimeType: msg.document.mime_type } : {}),
        ...(msg.document?.caption !== undefined ? { caption: msg.document.caption } : {}),
      };
    case 'reaction':
      return {
        ...base,
        kind: 'reaction',
        ...(msg.reaction?.emoji !== undefined ? { emoji: msg.reaction.emoji } : {}),
      };
    case 'interactive': {
      const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      if (!reply) return null;
      return { ...base, kind: 'button_reply', buttonReplyId: reply.id, text: reply.title };
    }
    case 'button':
      // template quick-reply button
      return {
        ...base,
        kind: 'button_reply',
        buttonReplyId: msg.button?.payload ?? '',
        ...(msg.button?.text !== undefined ? { text: msg.button.text } : {}),
      };
    default:
      return null;
  }
}
