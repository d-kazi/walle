import type Database from 'better-sqlite3';
import type { WalleEvent } from '../types/events.js';

/**
 * The single event→tables code path, used live (as an EventLog listener) and
 * by `npm run rebuild-db` (replaying every rotated log file). Every write is
 * idempotent (INSERT OR IGNORE / OR REPLACE keyed on stable ids) so replays
 * and Meta webhook retries converge on the same state.
 *
 * Payload conventions consumed here:
 *  - msg_in            {kind, text?, unknownWaId?, flags?}          → events, window_state, processed_messages, unknown_senders
 *  - intent            {kind:'open_item', op, item}                 → open_items
 *  - child_time        {date, reporter, entries:[{child, level}]}   → child_time
 *  - email_in          {msgId, from, subject, date}                 → email_index
 *  - verdict           {kind:'email_classified'|'email_action', msgId, value} → email_index
 *  - confirm_req       {proposal}                                   → proposals
 *  - confirm_res       {proposalId, answer, by}                     → proposals
 *  - calendar_op       {id, proposalId, op, calendar, status, draft}→ calendar_ops
 *  - llm_call          {task, model, ...telemetry}                  → llm_calls
 *  - trigger           {kind:'brief_sent'|'midday_sent'|'unknown_sender_alert'|'nudge'|'proposal_expired'|...}
 */
export class Projector {
  constructor(private readonly db: Database.Database) {}

  apply(ev: WalleEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (ts, actor, chat, type, payload, wa_msg_id, media_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.ts,
        ev.actor,
        ev.chat,
        ev.type,
        JSON.stringify(ev.payload),
        ev.wa_msg_id ?? null,
        ev.media_ref ?? null,
      );

    switch (ev.type) {
      case 'msg_in':
        this.applyMsgIn(ev);
        break;
      case 'intent':
        this.applyIntent(ev);
        break;
      case 'child_time':
        this.applyChildTime(ev);
        break;
      case 'email_in':
        this.applyEmailIn(ev);
        break;
      case 'verdict':
        this.applyVerdict(ev);
        break;
      case 'confirm_req':
        this.applyConfirmReq(ev);
        break;
      case 'confirm_res':
        this.applyConfirmRes(ev);
        break;
      case 'calendar_op':
        this.applyCalendarOp(ev);
        break;
      case 'llm_call':
        this.applyLlmCall(ev);
        break;
      case 'trigger':
        this.applyTrigger(ev);
        break;
      default:
        break;
    }
  }

  private applyMsgIn(ev: WalleEvent): void {
    const p = ev.payload as { unknownWaId?: string; flags?: string[] };
    if (ev.wa_msg_id) {
      this.db
        .prepare('INSERT OR IGNORE INTO processed_messages (wa_msg_id, ts) VALUES (?, ?)')
        .run(ev.wa_msg_id, ev.ts);
    }
    if (ev.chat === 'dan' || ev.chat === 'alina') {
      this.db
        .prepare(
          `INSERT INTO window_state (user, last_inbound_ts) VALUES (?, ?)
           ON CONFLICT(user) DO UPDATE SET last_inbound_ts = excluded.last_inbound_ts
           WHERE excluded.last_inbound_ts > window_state.last_inbound_ts`,
        )
        .run(ev.chat, ev.ts);
    } else if (p.unknownWaId) {
      this.db
        .prepare('INSERT OR IGNORE INTO unknown_senders (wa_id, last_alert_ts) VALUES (?, NULL)')
        .run(p.unknownWaId);
    }
  }

  private applyIntent(ev: WalleEvent): void {
    const p = ev.payload as {
      kind?: string;
      op?: string;
      item?: {
        id: string;
        title: string;
        owner: string;
        child?: string | null;
        due?: string | null;
      };
    };
    if (p.kind !== 'open_item' || !p.item) return;
    if (p.op === 'create') {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO open_items (id, title, owner, child, due, source_event, status, last_nudge)
           VALUES (?, ?, ?, ?, ?, ?, 'open', NULL)`,
        )
        .run(p.item.id, p.item.title, p.item.owner, p.item.child ?? null, p.item.due ?? null, ev.ts);
    } else if (p.op === 'complete' || p.op === 'drop') {
      this.db
        .prepare('UPDATE open_items SET status = ? WHERE id = ?')
        .run(p.op === 'complete' ? 'done' : 'dropped', p.item.id);
    }
  }

  private applyChildTime(ev: WalleEvent): void {
    const p = ev.payload as {
      date: string;
      reporter: string;
      entries: Array<{ child: string; level: string }>;
    };
    for (const entry of p.entries ?? []) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO child_time (date, child, level, reporter) VALUES (?, ?, ?, ?)`,
        )
        .run(p.date, entry.child, entry.level, p.reporter);
    }
  }

  private applyEmailIn(ev: WalleEvent): void {
    const p = ev.payload as { msgId: string; from: string; subject: string; date: string };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO email_index (msg_id, from_addr, subject, date) VALUES (?, ?, ?, ?)`,
      )
      .run(p.msgId, p.from, p.subject, p.date);
  }

  private applyVerdict(ev: WalleEvent): void {
    const p = ev.payload as { kind?: string; msgId?: string; value?: string; address?: string };
    void p;
    if (p.kind !== 'email_sender' && !p.msgId) return;
    if (p.kind === 'email_sender') {
      // an unexpected sender the user allowed or declined (forwarding inbox)
      this.db
        .prepare(
          `INSERT INTO email_senders (address, status, approved_by, ts) VALUES (?, ?, ?, ?)
           ON CONFLICT(address) DO UPDATE SET
             status = excluded.status, approved_by = excluded.approved_by, ts = excluded.ts`,
        )
        .run(String(p.address ?? '').toLowerCase(), p.value, ev.actor, ev.ts);
      return;
    }
    if (p.kind === 'email_classified') {
      this.db
        .prepare('UPDATE email_index SET classified_as = ? WHERE msg_id = ?')
        .run(p.value, p.msgId);
    } else if (p.kind === 'email_action') {
      this.db
        .prepare('UPDATE email_index SET action_taken = ? WHERE msg_id = ?')
        .run(p.value, p.msgId);
    }
  }

  private applyConfirmReq(ev: WalleEvent): void {
    const p = ev.payload as {
      proposal?: {
        id: string;
        kind: string;
        payload: Record<string, unknown>;
        proposedTo: string;
      };
    };
    if (!p.proposal) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO proposals (id, kind, payload, proposed_to, status, answered_by, source_event, created_ts, expiry_notified)
         VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, 0)`,
      )
      .run(
        p.proposal.id,
        p.proposal.kind,
        JSON.stringify(p.proposal.payload),
        p.proposal.proposedTo,
        ev.ts,
        ev.ts,
      );
  }

  private applyConfirmRes(ev: WalleEvent): void {
    const p = ev.payload as { proposalId?: string; answer?: string; by?: string };
    if (!p.proposalId) return;
    if (p.answer === 'yes') {
      this.db
        .prepare(
          `UPDATE proposals SET status = 'confirmed', answered_by = ? WHERE id = ? AND status = 'pending'`,
        )
        .run(p.by, p.proposalId);
    } else if (p.answer === 'no') {
      this.db
        .prepare(
          `UPDATE proposals SET status = 'declined', answered_by = ? WHERE id = ? AND status = 'pending'`,
        )
        .run(p.by, p.proposalId);
    } else if (p.answer === 'change') {
      this.db
        .prepare(
          `UPDATE proposals SET status = 'superseded', answered_by = ? WHERE id = ? AND status = 'pending'`,
        )
        .run(p.by, p.proposalId);
    }
  }

  private applyCalendarOp(ev: WalleEvent): void {
    const p = ev.payload as {
      id: string;
      proposalId?: string;
      op: string;
      calendar: string;
      status: string;
      draft?: Record<string, unknown>;
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO calendar_ops (id, proposal_id, op, calendar, status, payload, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.proposalId ?? null,
        p.op,
        p.calendar,
        p.status,
        JSON.stringify(p.draft ?? {}),
        ev.ts,
      );
  }

  private applyLlmCall(ev: WalleEvent): void {
    const p = ev.payload as {
      task: string;
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      latencyMs?: number;
      schemaRetries?: number;
      ok?: boolean;
    };
    this.db
      .prepare(
        `INSERT INTO llm_calls (ts, task, model, input_tokens, output_tokens, cost_usd, latency_ms, schema_retries, ok)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.ts,
        p.task,
        p.model,
        p.inputTokens ?? null,
        p.outputTokens ?? null,
        p.costUsd ?? null,
        p.latencyMs ?? null,
        p.schemaRetries ?? 0,
        p.ok === false ? 0 : 1,
      );
  }

  private applyTrigger(ev: WalleEvent): void {
    const p = ev.payload as Record<string, unknown>;
    switch (p.kind) {
      case 'brief_sent':
        this.db
          .prepare(
            `INSERT OR REPLACE INTO brief_state (user, brief_type, last_sent_ts) VALUES (?, ?, ?)`,
          )
          .run(p.user, p.briefType, ev.ts);
        break;
      case 'midday_sent':
        this.db
          .prepare('INSERT OR IGNORE INTO midday_state (user, date) VALUES (?, ?)')
          .run(p.user, ev.ts.slice(0, 10));
        break;
      case 'unknown_sender_alert':
        this.db
          .prepare(
            `INSERT INTO unknown_senders (wa_id, last_alert_ts) VALUES (?, ?)
             ON CONFLICT(wa_id) DO UPDATE SET last_alert_ts = excluded.last_alert_ts`,
          )
          .run(p.waId, ev.ts);
        break;
      case 'nudge':
        this.db.prepare('UPDATE open_items SET last_nudge = ? WHERE id = ?').run(ev.ts, p.itemId);
        break;
      case 'proposal_expired':
        this.db
          .prepare(`UPDATE proposals SET status = 'expired' WHERE id = ? AND status = 'pending'`)
          .run(p.proposalId);
        break;
      case 'proposal_expiry_notified':
        this.db
          .prepare('UPDATE proposals SET expiry_notified = 1 WHERE id = ?')
          .run(p.proposalId);
        break;
      default:
        break;
    }
  }
}
