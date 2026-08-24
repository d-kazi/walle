import type Database from 'better-sqlite3';
import type { Child, ChildTimeLevel, OpenItem, Proposal, User } from '../types/domain.js';

/**
 * Read-side query helpers. Derived state is written only by the Projector;
 * every other module changes state by appending events. These helpers are the
 * read path for briefs, the assistant, and jobs.
 */
export class Repos {
  constructor(private readonly db: Database.Database) {}

  // -- idempotency ---------------------------------------------------------

  hasProcessedMessage(waMsgId: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM processed_messages WHERE wa_msg_id = ?').get(waMsgId) !==
      undefined
    );
  }

  // -- window --------------------------------------------------------------

  lastInboundTs(user: User): string | null {
    const row = this.db
      .prepare('SELECT last_inbound_ts FROM window_state WHERE user = ?')
      .get(user) as { last_inbound_ts: string } | undefined;
    return row?.last_inbound_ts ?? null;
  }

  // -- open items ----------------------------------------------------------

  openItems(): OpenItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM open_items WHERE status = 'open' ORDER BY due IS NULL, due`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToOpenItem);
  }

  openItem(id: string): OpenItem | null {
    const row = this.db.prepare('SELECT * FROM open_items WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToOpenItem(row) : null;
  }

  // -- proposals -----------------------------------------------------------

  pendingProposals(): Proposal[] {
    const rows = this.db
      .prepare(`SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_ts`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToProposal);
  }

  pendingProposalsFor(user: User): Proposal[] {
    return this.pendingProposals().filter(
      (p) => p.proposedTo === user || p.proposedTo === 'both',
    );
  }

  mostRecentPendingProposalFor(user: User): Proposal | null {
    const list = this.pendingProposalsFor(user);
    return list.length > 0 ? list[list.length - 1]! : null;
  }

  proposal(id: string): Proposal | null {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToProposal(row) : null;
  }

  expiredUnnotifiedProposals(): Proposal[] {
    const rows = this.db
      .prepare(`SELECT * FROM proposals WHERE status = 'expired' AND expiry_notified = 0`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToProposal);
  }

  // -- child time ----------------------------------------------------------

  childTimeForDate(date: string): Array<{ child: Child; level: ChildTimeLevel; reporter: User }> {
    return this.db
      .prepare('SELECT child, level, reporter FROM child_time WHERE date = ?')
      .all(date) as Array<{ child: Child; level: ChildTimeLevel; reporter: User }>;
  }

  childTimeCounts(
    fromDate: string,
    toDate: string,
  ): Array<{ child: Child; level: ChildTimeLevel; days: number }> {
    return this.db
      .prepare(
        `SELECT child, level, COUNT(DISTINCT date) AS days
         FROM child_time WHERE date >= ? AND date <= ?
         GROUP BY child, level`,
      )
      .all(fromDate, toDate) as Array<{ child: Child; level: ChildTimeLevel; days: number }>;
  }

  // -- email ---------------------------------------------------------------

  hasEmail(msgId: string): boolean {
    return this.db.prepare('SELECT 1 FROM email_index WHERE msg_id = ?').get(msgId) !== undefined;
  }

  // -- briefs --------------------------------------------------------------

  lastBriefTs(user: User, briefType: string): string | null {
    const row = this.db
      .prepare('SELECT last_sent_ts FROM brief_state WHERE user = ? AND brief_type = ?')
      .get(user, briefType) as { last_sent_ts: string } | undefined;
    return row?.last_sent_ts ?? null;
  }

  middaySentToday(user: User, date: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM midday_state WHERE user = ? AND date = ?').get(user, date) !==
      undefined
    );
  }

  // -- unknown senders -----------------------------------------------------

  unknownSenderLastAlert(waId: string): { known: boolean; lastAlertTs: string | null } {
    const row = this.db
      .prepare('SELECT last_alert_ts FROM unknown_senders WHERE wa_id = ?')
      .get(waId) as { last_alert_ts: string | null } | undefined;
    return row ? { known: true, lastAlertTs: row.last_alert_ts } : { known: false, lastAlertTs: null };
  }

  // -- events (read mirror) ------------------------------------------------

  eventsSince(ts: string, types?: string[]): Array<{
    ts: string;
    actor: string;
    chat: string | null;
    type: string;
    payload: Record<string, unknown>;
  }> {
    const rows = (
      types && types.length > 0
        ? this.db
            .prepare(
              `SELECT ts, actor, chat, type, payload FROM events
               WHERE ts > ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY ts`,
            )
            .all(ts, ...types)
        : this.db
            .prepare('SELECT ts, actor, chat, type, payload FROM events WHERE ts > ? ORDER BY ts')
            .all(ts)
    ) as Array<{ ts: string; actor: string; chat: string | null; type: string; payload: string }>;
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  }

  recentChatTurns(
    user: User,
    limit: number,
  ): Array<{ ts: string; direction: 'in' | 'out'; text: string }> {
    const rows = this.db
      .prepare(
        `SELECT ts, type, payload FROM events
         WHERE chat = ? AND type IN ('msg_in', 'msg_out')
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(user, limit) as Array<{ ts: string; type: string; payload: string }>;
    return rows
      .reverse()
      .map((r) => {
        const p = JSON.parse(r.payload) as { text?: string; transcript?: string };
        return {
          ts: r.ts,
          direction: r.type === 'msg_in' ? ('in' as const) : ('out' as const),
          text: p.text ?? p.transcript ?? '',
        };
      })
      .filter((t) => t.text.length > 0);
  }

  // -- llm telemetry -------------------------------------------------------

  llmStats(fromTs: string): Array<{
    task: string;
    model: string;
    calls: number;
    failures: number;
    schemaRetries: number;
    costUsd: number;
    p50LatencyMs: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT task, model, COUNT(*) AS calls,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
                SUM(schema_retries) AS schemaRetries,
                COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM llm_calls WHERE ts >= ? GROUP BY task, model`,
      )
      .all(fromTs) as Array<{
      task: string;
      model: string;
      calls: number;
      failures: number;
      schemaRetries: number;
      costUsd: number;
    }>;
    return rows.map((r) => {
      const latencies = (
        this.db
          .prepare(
            `SELECT latency_ms FROM llm_calls
             WHERE ts >= ? AND task = ? AND model = ? AND latency_ms IS NOT NULL
             ORDER BY latency_ms`,
          )
          .all(fromTs, r.task, r.model) as Array<{ latency_ms: number }>
      ).map((x) => x.latency_ms);
      const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)]! : 0;
      return { ...r, p50LatencyMs: p50 };
    });
  }
}

function rowToOpenItem(row: Record<string, unknown>): OpenItem {
  return {
    id: row.id as string,
    title: row.title as string,
    owner: row.owner as OpenItem['owner'],
    child: (row.child as Child | null) ?? null,
    due: (row.due as string | null) ?? null,
    sourceEvent: row.source_event as string,
    status: row.status as OpenItem['status'],
    lastNudge: (row.last_nudge as string | null) ?? null,
  };
}

function rowToProposal(row: Record<string, unknown>): Proposal {
  return {
    id: row.id as string,
    kind: row.kind as Proposal['kind'],
    payload: JSON.parse(row.payload as string) as Record<string, unknown>,
    proposedTo: row.proposed_to as Proposal['proposedTo'],
    status: row.status as Proposal['status'],
    answeredBy: (row.answered_by as User | null) ?? null,
    sourceEvent: row.source_event as string,
    createdTs: row.created_ts as string,
    expiryNotified: row.expiry_notified === 1,
  };
}
