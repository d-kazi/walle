/**
 * The JSONL event log is the source of truth. One event per line, never edited.
 * Payloads are channel-neutral: no WhatsApp shapes beyond ids (PRD §11).
 */

export type Actor = 'dan' | 'alina' | 'walle' | 'system' | 'school' | 'finance';

export type ChatId = 'dan' | 'alina' | null;

export type EventType =
  | 'msg_in'
  | 'msg_out'
  | 'email_in'
  | 'intent'
  | 'verdict'
  | 'child_time'
  | 'memory_op'
  | 'calendar_op'
  | 'confirm_req'
  | 'confirm_res'
  | 'trigger'
  | 'probe'
  | 'error'
  | 'backup'
  | 'llm_call';

export interface WalleEvent {
  /** ISO 8601 with offset, Asia/Riyadh */
  ts: string;
  actor: Actor;
  chat: ChatId;
  type: EventType;
  payload: Record<string, unknown>;
  wa_msg_id?: string;
  /** path under DATA_DIR/media */
  media_ref?: string;
}
