import Database from 'better-sqlite3';
import path from 'node:path';
import { applyMigrations } from '../src/db/db.js';
import { Projector } from '../src/db/projector.js';
import { Repos } from '../src/db/repos.js';
import { AllowList } from '../src/identity/allowList.js';
import { Ingress } from '../src/ingress/inbound.js';
import { EventLog } from '../src/log/eventLog.js';
import { readAllEvents } from '../src/log/logReader.js';
import { MemoryStore } from '../src/memory/store.js';
import { LedgerReader } from '../src/ledger/read.js';
import { Outbound } from '../src/send/outbound.js';
import { Confirmations } from '../src/assistant/confirmations.js';
import { Conversation } from '../src/assistant/conversation.js';
import { ForwardedPipeline } from '../src/forwarded/poller.js';
import type { WalleEvent } from '../src/types/events.js';
import { FakeClock } from './helpers.js';
import {
  FakeCalendar,
  FakeDrive,
  FakeForwardInbox,
  FakeLlm,
  FakeMedia,
  FakeSchoolInbox,
  FakeSender,
  FakeTranscriber,
} from './fakes.js';

export const WA_DAN = '966500000001';
export const WA_ALINA = '966500000002';
export const EMAIL_DAN = 'dan@example.com';
export const EMAIL_ALINA = 'alina@example.com';

/** Full offline service stack used across behaviour tests. */
export function makeFullStack(dir: string, clock: FakeClock) {
  const log = new EventLog(dir, clock);
  const db = new Database(':memory:');
  applyMigrations(db);
  const projector = new Projector(db);
  log.onAppend((ev) => projector.apply(ev));
  const repos = new Repos(db);
  const allowList = new AllowList(WA_DAN, WA_ALINA);
  const sender = new FakeSender();
  const outbound = new Outbound(sender, allowList, repos, log, clock);
  const memory = new MemoryStore(dir);
  const ledger = new LedgerReader(dir, clock);
  const calendar = new FakeCalendar();
  const school = new FakeSchoolInbox();
  const forwardInbox = new FakeForwardInbox();
  const drive = new FakeDrive();
  const llm = new FakeLlm();
  let conversationRef: Conversation;
  const confirmations = new Confirmations(
    log,
    repos,
    outbound,
    calendar,
    clock,
    async (_address, msgId) => {
      const email = await forwardInbox.fetchOne(msgId);
      if (email) await conversationRef.handleForwardedEmail('dan', email);
    },
  );
  const conversation = new Conversation({
    log,
    repos,
    memory,
    ledger,
    calendar,
    llm,
    outbound,
    confirmations,
    clock,
  });
  conversationRef = conversation;
  const forwarded = new ForwardedPipeline({
    log,
    repos,
    inbox: forwardInbox,
    confirmations,
    emailDan: EMAIL_DAN,
    emailAlina: EMAIL_ALINA,
    handler: (user, email) => conversation.handleForwardedEmail(user, email),
    clock,
  });
  const ingress = new Ingress(
    log,
    repos,
    allowList,
    new FakeMedia(),
    new FakeTranscriber(),
    outbound,
    dir,
    (inbound) => conversation.handle(inbound),
    clock,
  );
  return {
    log,
    db,
    repos,
    sender,
    outbound,
    memory,
    ledger,
    calendar,
    school,
    forwardInbox,
    forwarded,
    drive,
    llm,
    confirmations,
    conversation,
    ingress,
    async events(): Promise<WalleEvent[]> {
      const out: WalleEvent[] = [];
      for await (const ev of readAllEvents(path.join(dir, 'log'))) out.push(ev);
      return out;
    },
  };
}

export type FullStack = ReturnType<typeof makeFullStack>;
