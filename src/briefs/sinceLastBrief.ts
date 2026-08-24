import type { Repos } from '../db/repos.js';
import type { User } from '../types/domain.js';
import { otherUser } from '../types/domain.js';

export interface SharedAddition {
  by: User;
  kind: 'memory' | 'open_item' | 'confirmed';
  text: string;
}

/**
 * What the other adult added since this user's last brief — shared-scoped
 * only (PRD §7). Watermark is the recipient's most recent brief of any type;
 * private memory ops are excluded here AND structurally absent from the
 * recipient's context, so this list is summary fodder only.
 */
export function sharedAdditionsSince(repos: Repos, user: User): SharedAddition[] {
  const other = otherUser(user);
  const watermark =
    [repos.lastBriefTs(user, 'morning'), repos.lastBriefTs(user, 'evening')]
      .filter((t): t is string => t !== null)
      .sort()
      .pop() ?? '1970-01-01T00:00:00+03:00';

  const events = repos.eventsSince(watermark, ['memory_op', 'intent', 'confirm_res']);
  const out: SharedAddition[] = [];
  for (const ev of events) {
    if (ev.actor !== other) continue;
    if (ev.type === 'memory_op') {
      const p = ev.payload as { op?: string; scope?: string; bullet?: string; child?: string };
      if (p.op === 'add' && (p.scope === 'shared' || p.scope === 'child') && p.bullet) {
        out.push({
          by: other,
          kind: 'memory',
          text: p.scope === 'child' && p.child ? `${p.bullet} (for ${p.child})` : p.bullet,
        });
      }
    } else if (ev.type === 'intent') {
      const p = ev.payload as { kind?: string; op?: string; item?: { title?: string; due?: string | null } };
      if (p.kind === 'open_item' && p.op === 'create' && p.item?.title) {
        out.push({
          by: other,
          kind: 'open_item',
          text: `${p.item.title}${p.item.due ? `, due ${p.item.due}` : ''}`,
        });
      }
    } else if (ev.type === 'confirm_res') {
      const p = ev.payload as { answer?: string; proposalId?: string };
      if (p.answer === 'yes' && p.proposalId) {
        const proposal = repos.proposal(p.proposalId);
        const title = (proposal?.payload as { title?: string } | undefined)?.title;
        if (title) out.push({ by: other, kind: 'confirmed', text: `confirmed: ${title}` });
      }
    }
  }
  return out;
}
