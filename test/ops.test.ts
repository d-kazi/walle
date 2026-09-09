import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLedgerRouter } from '../src/ledger/route.js';
import { createHealthRouter } from '../src/ops/health.js';
import { WeeklyRollup } from '../src/briefs/weekly.js';
import { modelSuggestions } from '../src/modelwatch/modelwatch.js';
import { FakeClock, cleanup, tmpDataDir } from './helpers.js';
import { WA_ALINA, WA_DAN, makeFullStack, type FullStack } from './stack.js';

const TOKEN = 'ledger-push-token-123';

async function startApp(stack: FullStack, dir: string): Promise<{ server: http.Server; base: string }> {
  const app = express();
  app.use(createLedgerRouter({ log: stack.log, dataDir: dir, pushToken: TOKEN }));
  app.use(
    createHealthRouter({
      dataDir: dir,
      db: stack.db,
      repos: stack.repos,
      ledger: stack.ledger,
      startedAt: new Date(),
      templateStatus: { fetch: async () => 'APPROVED' },
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('POST /ledger and GET /health', () => {
  let dir: string;
  let clock: FakeClock;
  beforeEach(() => {
    dir = tmpDataDir();
    clock = new FakeClock(new Date('2026-08-24T05:00:00Z'));
  });
  afterEach(() => cleanup(dir));

  it('rejects a bad bearer, accepts a good one, writes atomically', async () => {
    const stack = makeFullStack(dir, clock);
    const { server, base } = await startApp(stack, dir);
    const summary = {
      lastSync: '2026-08-24T02:00:00+03:00',
      monthToDate: { groceries: 1234 },
      notableDeltas: ['groceries up on last month'],
    };

    const bad = await fetch(`${base}/ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify(summary),
    });
    expect(bad.status).toBe(401);

    const malformed = await fetch(`${base}/ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(malformed.status).toBe(400);

    const good = await fetch(`${base}/ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(summary),
    });
    expect(good.status).toBe(200);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'summary.json'), 'utf8'));
    expect(written.monthToDate.groceries).toBe(1234);
    expect(stack.ledger.read().fresh).toBe(true);
    server.close();
  });

  it('/health reports log, db, windows, template and ledger state', async () => {
    const stack = makeFullStack(dir, clock);
    const { server, base } = await startApp(stack, dir);
    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.logWritable).toBe(true);
    expect(body.dbOk).toBe(true);
    expect((body.template as { status: string }).status).toBe('APPROVED');
    expect(body.windows).toEqual({ dan: null, alina: null });
    expect(body.inbound).toEqual({ webhooksLast24h: 0, lastWebhookAt: null, lastUnknownSender: null });

    // a webhook from a number that is not Dan or Alina shows up as traffic, not as a window
    clock.set(new Date()); // /health measures its 24h window against wall-clock time
    stack.log.append({
      actor: 'system',
      chat: null,
      type: 'trigger',
      payload: { kind: 'webhook_in', raw: {} },
    });
    stack.log.append({
      actor: 'system',
      chat: null,
      type: 'msg_in',
      payload: { kind: 'text', unknownWaId: '966599999999' },
    });
    const again = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    const inbound = again.inbound as { webhooksLast24h: number; lastUnknownSender: string | null };
    expect(inbound.webhooksLast24h).toBe(1);
    expect(inbound.lastUnknownSender).toBe('966599999999');
    expect(again.windows).toEqual({ dan: null, alina: null });
    server.close();
  });
});

describe('weekly rollup', () => {
  let dir: string;
  let clock: FakeClock;
  beforeEach(() => {
    dir = tmpDataDir();
    clock = new FakeClock(new Date('2026-08-30T17:00:00Z')); // Sunday 20:00 Riyadh
  });
  afterEach(() => cleanup(dir));

  it('sends both users counts, quarter plans; model-watch and adherence only to Dan', async () => {
    const stack = makeFullStack(dir, clock);
    // a week of child_time and some telemetry
    stack.log.append({
      actor: 'dan',
      chat: 'dan',
      type: 'child_time',
      payload: {
        date: '2026-08-27',
        reporter: 'dan',
        entries: [
          { child: 'dylan', level: 'proper' },
          { child: 'caspian', level: 'some' },
        ],
      },
    });
    // failing task telemetry to trigger a model suggestion
    for (let i = 0; i < 10; i++) {
      stack.log.append({
        actor: 'system',
        chat: null,
        type: 'llm_call',
        payload: { task: 'school_extract', model: 'test-model', ok: i < 5, latencyMs: 100 },
      });
    }

    const inputs: Record<string, string> = {};
    stack.llm.on('brief_weekly', (opts) => {
      const content = String(opts.messages.at(-1)?.content ?? '');
      const who = content.includes('for Dan') ? 'dan' : 'alina';
      inputs[who] = content;
      return 'Weekly rollup.';
    });

    const weekly = new WeeklyRollup({
      log: stack.log,
      repos: stack.repos,
      llm: stack.llm,
      outbound: stack.outbound,
      memory: stack.memory,
      clock,
    });
    await weekly.send();

    expect(stack.sender.sent.map((s) => s.to)).toEqual([WA_DAN, WA_ALINA]);
    expect(inputs.dan).toContain('proper 1');
    expect(inputs.dan).toContain('modelWatch');
    expect(inputs.alina).not.toContain('modelWatch');
    // counts, never percentages-as-scores
    expect(inputs.dan).not.toMatch(/\d+%/);
  });

  it('modelSuggestions flags high failure rates and reports spend', () => {
    const stack = makeFullStack(dir, clock);
    for (let i = 0; i < 10; i++) {
      stack.log.append({
        actor: 'system',
        chat: null,
        type: 'llm_call',
        payload: {
          task: 'school_extract',
          model: 'weak-model',
          ok: i % 2 === 0,
          costUsd: 0.01,
          latencyMs: 500,
        },
      });
    }
    const suggestions = modelSuggestions(stack.repos, '2026-08-01T00:00:00+03:00');
    expect(suggestions.some((s) => s.includes('school_extract'))).toBe(true);
    expect(suggestions.some((s) => s.includes('$'))).toBe(true);
  });
});
