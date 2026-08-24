/**
 * Local dev mode: the full service with a console channel instead of Meta,
 * and fakes for Google. Type messages as `dan: pick up Dylan at 3` or
 * `alina: ...`; outbound prints to the console. Set LLM_API_KEY (and
 * optionally LLM_BASE_URL / WALLE_MODEL) to exercise real prompts; without
 * it, an echo stub stands in.
 *
 *   DATA_DIR=./devdata npm run dev:sim
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import { EventLog } from '../log/eventLog.js';
import { applyMigrations } from '../db/db.js';
import { Projector } from '../db/projector.js';
import { Repos } from '../db/repos.js';
import { AllowList } from '../identity/allowList.js';
import { Outbound } from '../send/outbound.js';
import { Ingress, type Transcriber } from '../ingress/inbound.js';
import { MemoryStore } from '../memory/store.js';
import { LedgerReader } from '../ledger/read.js';
import { Confirmations } from '../assistant/confirmations.js';
import { Conversation } from '../assistant/conversation.js';
import { Briefs } from '../briefs/briefs.js';
import { OpenAiCompatClient, type ChatOptions, type ChatResult, type LlmClient } from '../llm/client.js';
import type {
  ChannelSender,
  MediaFetcher,
  OutboundButton,
  SendResult,
} from '../channel/types.js';
import type { CalendarEvent, CalendarService } from '../google/types.js';
import type { CalendarEventDraft, User } from '../types/domain.js';

const WA_DAN = 'sim-dan';
const WA_ALINA = 'sim-alina';

const dataDir = path.resolve(process.env.DATA_DIR ?? './devdata');
fs.mkdirSync(dataDir, { recursive: true });

class ConsoleSender implements ChannelSender {
  private n = 0;
  private label(to: string): string {
    return to === WA_DAN ? 'dan' : to === WA_ALINA ? 'alina' : to;
  }
  async sendText(to: string, text: string): Promise<SendResult> {
    console.log(`\n→ [${this.label(to)}] ${text}\n`);
    return { providerMsgId: `sim.${++this.n}`, mode: 'freeform' };
  }
  async sendButtons(to: string, text: string, buttons: OutboundButton[]): Promise<SendResult> {
    console.log(`\n→ [${this.label(to)}] ${text}`);
    console.log(`   buttons: ${buttons.map((b) => `[${b.title}] (${b.id})`).join(' ')}\n`);
    return { providerMsgId: `sim.${++this.n}`, mode: 'freeform' };
  }
  async sendTemplate(to: string, _name: string, body: string): Promise<SendResult> {
    console.log(`\n→ [${this.label(to)}] (template) ${body}\n`);
    return { providerMsgId: `sim.${++this.n}`, mode: 'template' };
  }
  async probe(): Promise<boolean> {
    return true;
  }
}

class SimCalendar implements CalendarService {
  events: CalendarEvent[] = [];
  private n = 0;
  async listEvents(user: User, fromIso: string, toIso: string): Promise<CalendarEvent[]> {
    return this.events.filter((e) => e.calendar === user && e.start >= fromIso && e.start < toIso);
  }
  async createEvent(draft: CalendarEventDraft): Promise<{ id: string }> {
    const id = `sim-cal-${++this.n}`;
    this.events.push({ id, title: draft.title, start: draft.start, end: draft.end, calendar: draft.calendar, allDay: false });
    console.log(`\n== calendar write: ${draft.calendar} / ${draft.title} @ ${draft.start} ==\n`);
    return { id };
  }
  async probe(): Promise<boolean> {
    return true;
  }
}

class EchoLlm implements LlmClient {
  readonly defaultModel = 'echo';
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const last = opts.messages.at(-1)?.content ?? '';
    return {
      content: `(no LLM_API_KEY set; echo) You said: ${String(last).slice(0, 200)}`,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }
}

const log = new EventLog(dataDir);
const db = new Database(path.join(dataDir, 'sim.db'));
applyMigrations(db);
const projector = new Projector(db);
log.onAppend((ev) => projector.apply(ev));
const repos = new Repos(db);
const allowList = new AllowList(WA_DAN, WA_ALINA);
const sender = new ConsoleSender();
const outbound = new Outbound(sender, allowList, repos, log);
const memory = new MemoryStore(dataDir);
const ledger = new LedgerReader(dataDir);
const calendar = new SimCalendar();
const llm: LlmClient = process.env.LLM_API_KEY
  ? new OpenAiCompatClient(
      process.env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1',
      process.env.LLM_API_KEY,
      process.env.WALLE_MODEL ?? 'deepseek/deepseek-chat',
      process.env.WALLE_MODEL_ESCALATED ?? process.env.WALLE_MODEL ?? 'deepseek/deepseek-chat',
      [process.env.LLM_API_KEY],
      log,
    )
  : new EchoLlm();

const confirmations = new Confirmations(log, repos, outbound, calendar);
const conversation = new Conversation({ log, repos, memory, ledger, calendar, llm, outbound, confirmations });
const noMedia: MediaFetcher = { download: async () => 'media/none.bin' };
const noTranscribe: Transcriber = { transcribe: async () => '' };
const ingress = new Ingress(log, repos, allowList, noMedia, noTranscribe, outbound, dataDir, (i) =>
  conversation.handle(i),
);
const briefs = new Briefs({ log, repos, llm, outbound, ledger, calendar });

console.log('walle dev sim. Commands:');
console.log('  dan: <text>      inbound from Dan');
console.log('  alina: <text>    inbound from Alina');
console.log('  dan# p:ID:yes    button tap from Dan (same for alina#)');
console.log('  /morning dan     run the morning brief for a user');
console.log('  /evening alina   run the evening brief');
console.log('  /midday dan      run the midday check');
console.log('  /quit\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.prompt();
let counter = 0;

rl.on('line', async (line) => {
  const trimmed = line.trim();
  try {
    if (trimmed === '/quit') {
      process.exit(0);
    } else if (trimmed.startsWith('/morning ')) {
      await briefs.sendMorning(trimmed.slice(9) as User);
    } else if (trimmed.startsWith('/evening ')) {
      await briefs.sendEvening(trimmed.slice(9) as User);
    } else if (trimmed.startsWith('/midday ')) {
      const fired = await briefs.maybeSendMidday(trimmed.slice(8) as User);
      if (!fired) console.log('(no trigger; silence)');
    } else {
      const button = /^(dan|alina)#\s*(.+)$/.exec(trimmed);
      const text = /^(dan|alina):\s*(.+)$/.exec(trimmed);
      if (button) {
        await ingress.process([
          {
            user: null,
            senderId: button[1] === 'dan' ? WA_DAN : WA_ALINA,
            kind: 'button_reply',
            buttonReplyId: button[2]!,
            forwarded: false,
            providerMsgId: `sim-in.${++counter}`,
            timestamp: Math.floor(Date.now() / 1000),
          },
        ]);
      } else if (text) {
        await ingress.process([
          {
            user: null,
            senderId: text[1] === 'dan' ? WA_DAN : WA_ALINA,
            kind: 'text',
            text: text[2]!,
            forwarded: false,
            providerMsgId: `sim-in.${++counter}`,
            timestamp: Math.floor(Date.now() / 1000),
          },
        ]);
      } else if (trimmed) {
        console.log('(unrecognised; use "dan: text" or /morning dan)');
      }
    }
  } catch (err) {
    console.error('sim error:', err);
  }
  rl.prompt();
});
