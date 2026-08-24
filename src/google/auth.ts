import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { User } from '../types/domain.js';

export type Principal = User | 'school';

/**
 * Three OAuth principals, each with the narrowest scope that works
 * (hard rule 4):
 *   school — gmail.readonly on the dedicated school inbox only
 *   dan    — gmail.metadata + gmail label read, calendar, drive (family folder)
 *   alina  — gmail.metadata + gmail label read, calendar
 * Refresh tokens come from `npm run auth` and live in env; the model never
 * sees them (hard rule 3).
 */
export const SCOPES: Record<Principal, string[]> = {
  school: ['https://www.googleapis.com/auth/gmail.readonly'],
  dan: [
    'https://www.googleapis.com/auth/gmail.metadata',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/drive',
  ],
  alina: [
    'https://www.googleapis.com/auth/gmail.metadata',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ],
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
  for (const principal of ['dan', 'alina', 'school'] as const) {
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
