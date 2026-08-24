import type { ChannelSender, OutboundButton, SendResult } from '../types.js';
import type { GraphClient } from './client.js';

/**
 * Graph API send. Template bodies cannot carry newlines, tabs, or runs of
 * more than four spaces (Meta rule), so the single body variable is
 * flattened to ` · `-separated text.
 */
export function sanitiseTemplateParam(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => line.trim().replace(/\s{2,}/g, ' '))
    .filter((line) => line.length > 0)
    .join(' · ');
}

export class WhatsAppSender implements ChannelSender {
  constructor(
    private readonly graph: GraphClient,
    private readonly phoneId: string,
    private readonly templateName = 'daily_brief',
    private readonly templateLanguage = 'en',
  ) {}

  private extractMsgId(res: Record<string, unknown>): string {
    const messages = res.messages as Array<{ id?: string }> | undefined;
    return messages?.[0]?.id ?? '';
  }

  async sendText(to: string, text: string): Promise<SendResult> {
    const res = await this.graph.post(`/${this.phoneId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    });
    return { providerMsgId: this.extractMsgId(res), mode: 'freeform' };
  }

  async sendButtons(to: string, text: string, buttons: OutboundButton[]): Promise<SendResult> {
    const res = await this.graph.post(`/${this.phoneId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
    return { providerMsgId: this.extractMsgId(res), mode: 'freeform' };
  }

  async sendTemplate(to: string, templateName: string, bodyParam: string): Promise<SendResult> {
    const res = await this.graph.post(`/${this.phoneId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: this.templateLanguage },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: sanitiseTemplateParam(bodyParam) }],
          },
        ],
      },
    });
    return { providerMsgId: this.extractMsgId(res), mode: 'template' };
  }

  async probe(): Promise<boolean> {
    try {
      await this.graph.get(`/${this.phoneId}?fields=id`);
      return true;
    } catch {
      return false;
    }
  }
}
