import type {
  ChannelSender,
  MediaFetcher,
  OutboundButton,
  SendResult,
} from '../src/channel/types.js';
import type { Transcriber } from '../src/ingress/inbound.js';
import type { ChatOptions, ChatResult, LlmClient } from '../src/llm/client.js';
import type {
  CalendarEvent,
  CalendarService,
  DriveFile,
  DriveService,
  SchoolEmail,
  SchoolInbox,
} from '../src/google/types.js';
import type { CalendarEventDraft, User } from '../src/types/domain.js';

export interface SentRecord {
  to: string;
  text: string;
  mode: 'text' | 'buttons' | 'template';
  buttons?: OutboundButton[];
}

export class FakeSender implements ChannelSender {
  sent: SentRecord[] = [];
  probeOk = true;
  private counter = 0;

  async sendText(to: string, text: string): Promise<SendResult> {
    this.sent.push({ to, text, mode: 'text' });
    return { providerMsgId: `fake.${++this.counter}`, mode: 'freeform' };
  }
  async sendButtons(to: string, text: string, buttons: OutboundButton[]): Promise<SendResult> {
    this.sent.push({ to, text, mode: 'buttons', buttons });
    return { providerMsgId: `fake.${++this.counter}`, mode: 'freeform' };
  }
  async sendTemplate(to: string, _templateName: string, bodyParam: string): Promise<SendResult> {
    this.sent.push({ to, text: bodyParam, mode: 'template' });
    return { providerMsgId: `fake.${++this.counter}`, mode: 'template' };
  }
  async probe(): Promise<boolean> {
    return this.probeOk;
  }
}

export class FakeMedia implements MediaFetcher {
  async download(mediaId: string): Promise<string> {
    return `media/${mediaId}.bin`;
  }
}

export class FakeTranscriber implements Transcriber {
  constructor(private readonly result = 'fake transcript') {}
  async transcribe(): Promise<string> {
    return this.result;
  }
}

type LlmResponder = (opts: ChatOptions) => ChatResult | string;

function toResult(r: ChatResult | string): ChatResult {
  if (typeof r === 'string') {
    return {
      content: r,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 },
    };
  }
  return r;
}

/**
 * Scripted LLM. Responses are keyed by task; a task can have a queue of
 * responses consumed in order (repeating the last one when exhausted).
 */
export class FakeLlm implements LlmClient {
  readonly defaultModel = 'fake-model';
  calls: ChatOptions[] = [];
  private readonly script = new Map<string, LlmResponder[]>();

  on(task: string, ...responders: Array<ChatResult | string | LlmResponder>): this {
    this.script.set(
      task,
      responders.map((r) => (typeof r === 'function' ? r : () => r)),
    );
    return this;
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    this.calls.push(opts);
    const queue = this.script.get(opts.task);
    if (!queue || queue.length === 0) {
      throw new Error(`FakeLlm: no script for task "${opts.task}"`);
    }
    const responder = queue.length > 1 ? queue.shift()! : queue[0]!;
    return toResult(responder(opts));
  }

  /** helper for a tool-call response */
  static toolCall(name: string, args: Record<string, unknown>): ChatResult {
    return {
      content: null,
      toolCalls: [{ id: `tc-${name}`, name, arguments: JSON.stringify(args) }],
      usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 },
    };
  }
}

export class FakeCalendar implements CalendarService {
  events: CalendarEvent[] = [];
  created: CalendarEventDraft[] = [];
  probeOk = true;
  failCreate = false;
  private counter = 0;

  async listEvents(user: User, fromIso: string, toIso: string): Promise<CalendarEvent[]> {
    return this.events.filter(
      (e) => e.calendar === user && e.start >= fromIso && e.start <= toIso,
    );
  }
  async createEvent(draft: CalendarEventDraft): Promise<{ id: string }> {
    if (this.failCreate) throw new Error('calendar unavailable');
    this.created.push(draft);
    const id = `cal-${++this.counter}`;
    this.events.push({
      id,
      title: draft.title,
      start: draft.start,
      end: draft.end,
      calendar: draft.calendar,
      allDay: false,
    });
    return { id };
  }
  async probe(): Promise<boolean> {
    return this.probeOk;
  }
}

export class FakeSchoolInbox implements SchoolInbox {
  emails: SchoolEmail[] = [];
  probeOk = true;
  async listNewEmails(sinceIso: string): Promise<SchoolEmail[]> {
    return this.emails.filter((e) => e.date > sinceIso);
  }
  async probe(): Promise<boolean> {
    return this.probeOk;
  }
}

export class FakeDrive implements DriveService {
  files: DriveFile[] = [];
  backups: Array<{ name: string; localPath: string }> = [];
  async listFamilyFolder(): Promise<DriveFile[]> {
    return this.files;
  }
  async fetchFileText(): Promise<string> {
    return 'file content';
  }
  async uploadBackup(name: string, localPath: string): Promise<void> {
    this.backups.push({ name, localPath });
  }
  async listBackups(): Promise<DriveFile[]> {
    return this.backups.map((b, i) => ({
      id: `b${i}`,
      name: b.name,
      mimeType: 'application/gzip',
      modified: new Date(2026, 0, i + 1).toISOString(),
    }));
  }
  async deleteBackup(): Promise<void> {}
}
