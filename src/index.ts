import express from 'express';
import { loadConfig } from './config.js';
import { EventLog } from './log/eventLog.js';
import { openDb } from './db/db.js';
import { Projector } from './db/projector.js';
import { Repos } from './db/repos.js';
import { AllowList } from './identity/allowList.js';
import { createGraphClient } from './channel/whatsapp/client.js';
import { WhatsAppSender } from './channel/whatsapp/sender.js';
import { WhatsAppMediaFetcher } from './channel/whatsapp/media.js';
import { createWebhookRouter } from './channel/whatsapp/webhook.js';
import { Outbound } from './send/outbound.js';
import { Ingress } from './ingress/inbound.js';
import { GroqTranscriber } from './transcribe/groq.js';
import { OpenAiCompatClient } from './llm/client.js';
import { MemoryStore } from './memory/store.js';
import { Curator } from './memory/curator.js';
import { LedgerReader } from './ledger/read.js';
import { createLedgerRouter } from './ledger/route.js';
import { createGoogleAuths } from './google/auth.js';
import { GoogleCalendarService } from './google/calendar.js';
import { GmailForwardInbox } from './google/gmail.js';
import { GoogleDriveService } from './google/drive.js';
import { Confirmations } from './assistant/confirmations.js';
import { Conversation } from './assistant/conversation.js';
import { Briefs } from './briefs/briefs.js';
import { WeeklyRollup } from './briefs/weekly.js';
import { SchoolPipeline } from './school/pipeline.js';
import { ForwardedPipeline } from './forwarded/poller.js';
import { Prober } from './scheduler/probe.js';
import { registerJobs } from './scheduler/cron.js';
import { createHealthRouter } from './ops/health.js';
import { Backup } from './ops/backup.js';
import { USERS } from './types/domain.js';
import { riyadhDate, systemClock } from './util/time.js';
import path from 'node:path';

const config = loadConfig();
const { env } = config;

// storage: log first, db derived
const log = new EventLog(config.dataDir);
const db = openDb(config.dataDir);
const projector = new Projector(db);
log.onAppend((ev) => projector.apply(ev));
const repos = new Repos(db);

// channel (the only Meta-aware corner)
const graph = createGraphClient(env.META_WA_TOKEN);
const sender = new WhatsAppSender(graph, env.META_WA_PHONE_ID);
const media = new WhatsAppMediaFetcher(graph, config.dataDir);
const allowList = new AllowList(env.WA_ID_DAN, env.WA_ID_ALINA);
const outbound = new Outbound(sender, allowList, repos, log);

// model + memory + ledger
const llm = new OpenAiCompatClient(
  env.LLM_BASE_URL,
  env.LLM_API_KEY,
  env.WALLE_MODEL,
  env.WALLE_MODEL_ESCALATED ?? env.WALLE_MODEL,
  config.secretValues,
  log,
);
const memory = new MemoryStore(config.dataDir);
const ledger = new LedgerReader(config.dataDir);

// google, three principals
const auths = createGoogleAuths({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  refreshTokens: {
    dan: env.GOOGLE_REFRESH_DAN,
    alina: env.GOOGLE_REFRESH_ALINA,
    walle: env.GOOGLE_REFRESH_WALLE,
  },
});
const calendar = new GoogleCalendarService(auths);
const forwardInbox = new GmailForwardInbox(auths);
const drive = new GoogleDriveService(auths, env.FAMILY_DRIVE_FOLDER_ID);

// behaviour
let forwarded: ForwardedPipeline;
const confirmations = new Confirmations(
  log,
  repos,
  outbound,
  calendar,
  systemClock,
  // approving a stranger's mail: read it in full and route it like any
  // other accepted mail (school pipeline or the approver's chat)
  async (user, _address, msgId) => {
    const email = await forwardInbox.fetchOne(msgId);
    if (email) await forwarded.dispatch(user, email);
  },
);
const conversation = new Conversation({
  log,
  repos,
  memory,
  ledger,
  calendar,
  drive,
  llm,
  outbound,
  confirmations,
});
const ingress = new Ingress(
  log,
  repos,
  allowList,
  media,
  new GroqTranscriber(env.GROQ_API_KEY),
  outbound,
  config.dataDir,
  (inbound) => conversation.handle(inbound),
);
const briefs = new Briefs({ log, repos, llm, outbound, ledger, calendar });
const weekly = new WeeklyRollup({ log, repos, llm, outbound, memory });
const school = new SchoolPipeline({ log, repos, llm, confirmations });
forwarded = new ForwardedPipeline({
  log,
  repos,
  inbox: forwardInbox,
  confirmations,
  emailDan: env.EMAIL_DAN,
  emailAlina: env.EMAIL_ALINA,
  schoolKeywords: config.schoolKeywords,
  school: (email) => school.processEmail(email),
  handler: (user, email) => conversation.handleForwardedEmail(user, email),
});
const curator = new Curator({ log, llm, memory, logDir: path.join(config.dataDir, 'log') });
const prober = new Prober(log, outbound, sender, calendar, forwardInbox);
const backup = new Backup(log, db, drive, config.dataDir);

// http
const app = express();
app.use(
  createWebhookRouter({
    log,
    verifyToken: env.META_WA_VERIFY_TOKEN,
    appSecret: env.META_APP_SECRET,
    onMessages: (messages) => void ingress.process(messages),
  }),
);
app.use(createLedgerRouter({ log, dataDir: config.dataDir, pushToken: env.LEDGER_PUSH_TOKEN }));
app.use(
  createHealthRouter({
    dataDir: config.dataDir,
    db,
    repos,
    ledger,
    startedAt: new Date(),
    templateStatus: {
      async fetch() {
        if (!env.META_WABA_ID) return 'unconfigured (set META_WABA_ID)';
        const res = await graph.get(
          `/${env.META_WABA_ID}/message_templates?name=daily_brief&fields=name,status`,
        );
        const data = res.data as Array<{ name?: string; status?: string }> | undefined;
        return data?.find((t) => t.name === 'daily_brief')?.status ?? 'not found';
      },
    },
  }),
);

// schedules, all Asia/Riyadh, probe-first (PRD §5)
registerJobs(log, [
  {
    name: 'Morning brief',
    schedule: '30 6 * * *',
    run: async () => {
      await prober.probe('Morning brief', ['whatsapp', 'calendar']);
      confirmations.expireStale();
      for (const user of USERS) await briefs.sendMorning(user);
    },
  },
  {
    name: 'Evening brief',
    schedule: '0 21 * * *',
    run: async () => {
      await prober.probe('Evening brief', ['whatsapp', 'calendar']);
      for (const user of USERS) await briefs.sendEvening(user);
    },
  },
  {
    name: 'Midday check',
    schedule: '0,30 11-13 * * *',
    run: async () => {
      for (const user of USERS) await briefs.maybeSendMidday(user);
    },
  },
  {
    name: 'Midday check (final)',
    schedule: '0 14 * * *',
    run: async () => {
      for (const user of USERS) await briefs.maybeSendMidday(user);
    },
  },
  {
    name: 'Mail poll (day)',
    schedule: '*/15 6-19 * * *',
    run: async () => {
      const probe = await prober.probe('Mail poll', ['mail']);
      if (!probe.failed.includes('mail')) await forwarded.poll();
    },
  },
  {
    name: 'Mail poll (night)',
    schedule: '0 0-5,20-23 * * *',
    run: async () => {
      const probe = await prober.probe('Mail poll', ['mail']);
      if (!probe.failed.includes('mail')) await forwarded.poll();
    },
  },
  {
    name: 'Memory curation',
    schedule: '30 23 * * *',
    run: async () => {
      await curator.runForDate(riyadhDate(new Date()));
    },
  },
  {
    name: 'Weekly rollup',
    schedule: '0 20 * * 0',
    run: async () => {
      await prober.probe('Weekly rollup', ['whatsapp']);
      await weekly.send();
    },
  },
  {
    name: 'Backup',
    schedule: '0 2 * * *',
    run: async () => {
      await backup.run();
    },
  },
]);

app.listen(config.port, () => {
  log.append({
    actor: 'system',
    chat: null,
    type: 'trigger',
    payload: { kind: 'service_started', port: config.port },
  });
  console.log(`walle listening on :${config.port}`);
});
