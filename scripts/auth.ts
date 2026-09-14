/**
 * One-off local OAuth helper (`npm run auth`). Run once per principal:
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run auth -- walle
 *   npm run auth -- dan
 *   npm run auth -- alina
 *
 * Opens a consent URL for that principal's scopes, catches the redirect on
 * localhost:8765, and prints the refresh token to paste into env
 * (GOOGLE_REFRESH_WALLE / _DAN / _ALINA). Tokens never enter the repo.
 */
import http from 'node:http';
import { google } from 'googleapis';
import { PRINCIPALS, SCOPES, type Principal } from '../src/google/auth.js';

const principal = (process.argv[2] ?? '') as Principal;
if (!PRINCIPALS.includes(principal)) {
  console.error(`Usage: npm run auth -- <${PRINCIPALS.join('|')}>`);
  process.exit(1);
}
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  process.exit(1);
}

const redirect = 'http://localhost:8765/callback';
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirect);
const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES[principal],
});

console.log(`\nSign in as the ${principal} Google account:\n\n${url}\n`);

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url ?? '', redirect).searchParams.get('code');
  if (!code) {
    res.end('No code in callback.');
    return;
  }
  const { tokens } = await oauth2.getToken(code);
  res.end('Done. You can close this tab.');
  server.close();
  console.log(`\nGOOGLE_REFRESH_${principal.toUpperCase()}=${tokens.refresh_token}\n`);
  console.log('Paste that into your Railway env. It is shown once; store it nowhere else.');
});
server.listen(8765, () => console.log('Waiting on http://localhost:8765/callback ...'));
