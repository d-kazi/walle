import express, { type Router } from 'express';
import type { EventLog } from '../../log/eventLog.js';
import { parseWebhookPayload } from './parser.js';
import { verifySignature } from './signature.js';
import type { InboundMessage } from '../types.js';

/**
 * Meta webhook endpoints. Hard rule 5: the raw payload is appended to the
 * log before signature verification or any other processing — including for
 * payloads that turn out to be unsigned (logged flagged, then rejected).
 */
export function createWebhookRouter(opts: {
  log: EventLog;
  verifyToken: string;
  appSecret: string;
  onMessages: (messages: InboundMessage[]) => void;
}): Router {
  const router = express.Router();

  router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === opts.verifyToken && typeof challenge === 'string') {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  router.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(raw.toString('utf8'));
    } catch {
      parsedBody = { unparseable: raw.toString('base64').slice(0, 4096) };
    }

    // Log first. No exceptions.
    opts.log.append({
      actor: 'system',
      chat: null,
      type: 'trigger',
      payload: { kind: 'webhook_in', raw: parsedBody },
    });

    const signed = verifySignature(opts.appSecret, raw, req.header('x-hub-signature-256'));
    if (!signed) {
      opts.log.append({
        actor: 'system',
        chat: null,
        type: 'error',
        payload: { kind: 'unsigned_webhook' },
      });
      res.sendStatus(401);
      return;
    }

    // Ack quickly; processing continues after the response. A crash before
    // this point means no 200, so Meta retries and nothing is lost.
    res.sendStatus(200);

    const messages = parseWebhookPayload(parsedBody);
    if (messages.length > 0) {
      setImmediate(() => opts.onMessages(messages));
    }
  });

  return router;
}
