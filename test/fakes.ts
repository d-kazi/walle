import type {
  ChannelSender,
  MediaFetcher,
  OutboundButton,
  SendResult,
} from '../src/channel/types.js';
import type { Transcriber } from '../src/ingress/inbound.js';

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
