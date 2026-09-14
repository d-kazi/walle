import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { User } from '../types/domain.js';

/**
 * Three OAuth principals. One is a dedicated account Wall-E may read in
 * full; the two personal accounts grant calendar and nothing else — no
 * Gmail, no Drive (hard rule 4: read-only scopes, narrowest that works).
 *
 *   walle  — the one dedicated mailbox. School mail is forwarded or
 *            addressed here and recognised by keyword; Dan and Alina
 *            forward anything else they want read. Also holds the shared
 *            family Drive folder, so drive.readonly covers an otherwise
 *            empty Drive rather than a personal one; drive.file limits
 *            writes to files this service created (the backups).
 *   dan    — calendar only. Reads for briefs, writes behind the Tier 2 gate.
 *   alina  — calendar only.
 *
 * No send scope anywhere. No delete scope anywhere.
 * Refresh tokens come from `npm run auth` and live in env; the model never
 * sees them (hard rule 3).
 */
export type Principal = User | 'walle';

export const PRINCIPALS: readonly Principal[] = ['dan', 'alina', 'walle'] as const;

export const SCOPES: Record<Principal, string[]> = {
  walle: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
  ],
  dan: ['https://www.googleapis.com/auth/calendar.events'],
  alina: ['https://www.googleapis.com/auth/calendar.events'],
};

export interface GoogleAuths {
  clientFor(principal: Principal): OAuth2Client;
}

export function createGoogleAuths(cfg: {
  clientId: string;
  clientSecret: string;
  refreshTokens: Record<Principal, string>;
}): GoogleAuths {
  const clients = new Map<Principal, OAuth2Client>();
  for (const principal of PRINCIPALS) {
    const client = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
    client.setCredentials({ refresh_token: cfg.refreshTokens[principal] });
    clients.set(principal, client);
  }
  return {
    clientFor(principal: Principal): OAuth2Client {
      const client = clients.get(principal);
      if (!client) throw new Error(`No Google client for ${principal}`);
      return client;
    },
  };
}
