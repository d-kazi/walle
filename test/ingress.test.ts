import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/db.js';
import { Projector } from '../src/db/projector.js';
import { Repos } from '../src/db/repos.js';
import { AllowList } from '../src/identity/allowList.js';
import { Ingress, type EnrichedInbound } from '../src/ingress/inbound.js';
import { EventLog } from '../src/log/eventLog.js';
import { readAllEvents } from '../src/log/logReader.js';
import { Outbound } from '../src/send/outbound.js';
import { createWebhookRouter } from '../src/channel/whatsapp/webhook.js';
import { parseWebhookPayload } from '../src/channel/whatsapp/parser.js';
import { verifySignature } from '../src/channel/whatsapp/signature.js';
import { sanitiseTemplateParam } from '../src/channel/whatsapp/sender.js';
import type { WalleEvent } from '../src/types/events.js';
import { FakeClock, cleanup, tmpDataDir } from './helpers.js';
import { FakeMedia, FakeSender, FakeTranscriber } from './fakes.js';
import { audioPayload, textPayload } from './fixtures/webhook.js';
import path from 'node:path';

const WA_DAN = '966500000001';
const WA_ALINA = '966500000002';
const WA_STRANGER = '447700900000';
const APP_SECRET = 'test-app-secret';

function makeStack(dir: string, clock: FakeClock) {
  const log = new EventLog(dir, clock);
  const db = new Database(':memory:');
  applyMigrations(db);
  const projector = new Projector(db);
  log.onAppend((ev) => projector.apply(ev));
  const repos = new Repos(db);
  const allowList = new AllowList(WA_DAN, WA_ALINA);
  const sender = new FakeSender();
  const outbound = new Outbound(sender, allowList, repos, log, clock);
  const handled: EnrichedInbound[] = [];
  const ingress = new Ingress(
    log,
    repos,
    allowList,
    new FakeMedia(),
    new FakeTranscriber('voice note transcript'),
    outbound,
    dir,
    async (inbound) => {
      handled.push(inbound);
    },
    clock,
  );
  return { log, db, repos, sender, outbound, ingress, handled };
}

async function allEvents(dir: string): Promise<WalleEvent[]> {
  const out: WalleEvent[] = [];
  for await (const ev of readAllEvents(path.join(dir, 'log'))) out.push(ev);
  return out;
}

describe('signature verification', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const good = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');

  it('accepts a valid signature and rejects tampering', () => {
    expect(verifySignature(APP_SECRET, body, good)).toBe(true);
    expect(verifySignature(APP_SECRET, Buffer.from('{"hello":"tampered"}'), good)).toBe(false);
    expect(verifySignature(APP_SECRET, body, undefined)).toBe(false);
    expect(verifySignature(APP_SECRET, body, 'sha256=deadbeef')).toBe(false);
  });
});

describe('webhook router', () => {
  let dir: string;
  beforeEach(() => (dir = tmpDataDir()));
  afterEach(() => cleanup(dir));

  function startServer(onMessages: (msgs: ReturnType<typeof parseWebhookPayload>) => void) {
    const clock = new FakeClock(new Date('2026-08-24T03:30:00Z'));
    const log = new EventLog(dir, clock);
    const app = express();
    app.use(
      createWebhookRouter({
        log,
        verifyToken: 'verify-me',
        appSecret: APP_SECRET,
        onMessages,
      }),
    );
    const server = http.createServer(app);
    return new Promise<{ server: http.Server; port: number }>((resolve) => {
      server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }));
    });
  }

  it('answers the GET verification handshake', async () => {
    const { server, port } = await startServer(() => {});
    const res = await fetch(
      `http://127.0.0.1:${port}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc123');
    const bad = await fetch(
      `http://127.0.0.1:${port}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`,
    );
    expect(bad.status).toBe(403);
    server.close();
  });

  it('logs the raw payload before rejecting an unsigned POST', async () => {
    const { server, port } = await startServer(() => {});
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(textPayload(WA_DAN, 'wamid.x', 'hello')),
    });
    expect(res.status).toBe(401);
    const events = await allEvents(dir);
    expect(events[0]?.type).toBe('trigger');
    expect((events[0]?.payload as { kind?: string }).kind).toBe('webhook_in');
    expect(events[1]?.type).toBe('error');
    server.close();
  });

  it('accepts a signed POST, logs first, then hands over parsed messages', async () => {
    let received: ReturnType<typeof parseWebhookPayload> = [];
    const { server, port } = await startServer((msgs) => (received = msgs));
    const body = JSON.stringify(textPayload(WA_DAN, 'wamid.1', 'hello walle'));
    const sig =
      'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(body)).digest('hex');
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
      body,
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('hello walle');
    expect(received[0]?.senderId).toBe(WA_DAN);
    server.close();
  });
});

describe('ingress pipeline', () => {
  let dir: string;
  let clock: FakeClock;
  beforeEach(() => {
    dir = tmpDataDir();
    clock = new FakeClock(new Date('2026-08-24T03:30:00Z'));
  });
  afterEach(() => cleanup(dir));

  it('processes a text message once and skips the Meta retry', async () => {
    const stack = makeStack(dir, clock);
    const msgs = parseWebhookPayload(textPayload(WA_DAN, 'wamid.1', 'pick up Dylan at 3'));
    await stack.ingress.process(msgs);
    await stack.ingress.process(msgs); // Meta retry
    expect(stack.handled).toHaveLength(1);
    expect(stack.handled[0]?.user).toBe('dan');
    const events = await allEvents(dir);
    expect(events.filter((e) => e.type === 'msg_in')).toHaveLength(1);
    expect(stack.repos.lastInboundTs('dan')).not.toBeNull();
  });

  it('transcribes audio and stores both media ref and transcript', async () => {
    const stack = makeStack(dir, clock);
    await stack.ingress.process(parseWebhookPayload(audioPayload(WA_ALINA, 'wamid.2', 'MEDIA9')));
    expect(stack.handled[0]?.effectiveText).toBe('voice note transcript');
    const events = await allEvents(dir);
    const msgIn = events.find((e) => e.type === 'msg_in');
    expect(msgIn?.media_ref).toBe('media/MEDIA9.bin');
    expect((msgIn?.payload as { transcribed?: boolean }).transcribed).toBe(true);
  });

  it('ignores unknown senders, alerts Dan once per number per week', async () => {
    const stack = makeStack(dir, clock);
    // Dan messaged recently so the alert can go freeform
    await stack.ingress.process(parseWebhookPayload(textPayload(WA_DAN, 'wamid.0', 'hi')));
    const stranger = parseWebhookPayload(textPayload(WA_STRANGER, 'wamid.s1', 'spam'));
    await stack.ingress.process(stranger);

    // nothing ever sent to the stranger
    expect(stack.sender.sent.every((s) => s.to !== WA_STRANGER)).toBe(true);
    // Dan alerted once
    const alerts = stack.sender.sent.filter((s) => s.to === WA_DAN && s.text.includes('0000'));
    expect(alerts).toHaveLength(1);
    // second message same week: logged, no new alert
    await stack.ingress.process(parseWebhookPayload(textPayload(WA_STRANGER, 'wamid.s2', 'more')));
    expect(stack.sender.sent.filter((s) => s.to === WA_DAN && s.text.includes('0000'))).toHaveLength(1);
    // next week: alert again
    clock.advance(8 * 24 * 60 * 60 * 1000);
    await stack.ingress.process(parseWebhookPayload(textPayload(WA_STRANGER, 'wamid.s3', 'again')));
    expect(stack.sender.sent.filter((s) => s.to === WA_DAN && s.text.includes('0000'))).toHaveLength(2);
    // handler never saw any of it
    expect(stack.handled.filter((h) => (h.user as string) === null)).toHaveLength(0);
  });
});

describe('outbound send layer', () => {
  let dir: string;
  let clock: FakeClock;
  beforeEach(() => {
    dir = tmpDataDir();
    clock = new FakeClock(new Date('2026-08-24T03:30:00Z'));
  });
  afterEach(() => cleanup(dir));

  it('sends freeform inside the 24h window, template outside', async () => {
    const stack = makeStack(dir, clock);
    await stack.ingress.process(parseWebhookPayload(textPayload(WA_DAN, 'wamid.1', 'hi')));

    expect(await stack.outbound.send('dan', { text: 'hello' })).toBe('freeform');
    clock.advance(25 * 60 * 60 * 1000);
    expect(await stack.outbound.send('dan', { text: 'you still there' })).toBe('template');
    // Alina never messaged: no window at all
    expect(await stack.outbound.send('alina', { text: 'brief' })).toBe('template');
  });

  it('pre-empts to template for scheduled sends after 20h of silence', async () => {
    const stack = makeStack(dir, clock);
    await stack.ingress.process(parseWebhookPayload(textPayload(WA_DAN, 'wamid.1', 'hi')));
    clock.advance(21 * 60 * 60 * 1000);
    expect(await stack.outbound.send('dan', { text: 'brief', }, { scheduled: true })).toBe('template');
    expect(await stack.outbound.send('dan', { text: 'reply' })).toBe('freeform');
  });

  it('logs msg_out before the channel call and records the mode', async () => {
    const stack = makeStack(dir, clock);
    await stack.outbound.send('alina', { text: 'evening brief' });
    const events = await allEvents(dir);
    const out = events.find((e) => e.type === 'msg_out');
    expect(out?.chat).toBe('alina');
    expect((out?.payload as { mode?: string }).mode).toBe('template');
    expect(stack.sender.sent[0]?.mode).toBe('template');
  });

  it('refuses any recipient that is not dan or alina', async () => {
    const stack = makeStack(dir, clock);
    await expect(
      // deliberately bypass the type system, as a bug would
      stack.outbound.send('school' as never, { text: 'leak' }),
    ).rejects.toThrow(/not an allow-listed user/);
    expect(stack.sender.sent).toHaveLength(0);
  });

  it('turns buttons into reply instructions when forced through the template', async () => {
    const stack = makeStack(dir, clock);
    const mode = await stack.outbound.send('dan', {
      text: 'Add swimming gala to the calendar?',
      buttons: [
        { id: 'p:1:yes', title: 'Yes' },
        { id: 'p:1:no', title: 'No' },
      ],
    });
    expect(mode).toBe('template');
    expect(stack.sender.sent[0]?.text).toContain('Reply Yes / No');
  });
});

describe('template sanitiser', () => {
  it('flattens newlines and space runs per Meta rules', () => {
    expect(sanitiseTemplateParam('Line one\n\nLine two   with  spaces\nLine three')).toBe(
      'Line one · Line two with spaces · Line three',
    );
  });
});
