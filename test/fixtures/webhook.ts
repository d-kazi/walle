/** Meta Cloud API webhook payload fixtures. */

export function textPayload(from: string, msgId: string, body: string): object {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '9665xxxxxx', phone_number_id: 'PHONE_ID' },
              contacts: [{ profile: { name: 'Test' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: msgId,
                  timestamp: '1756000000',
                  type: 'text',
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function buttonReplyPayload(from: string, msgId: string, buttonId: string, title: string): object {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              messages: [
                {
                  from,
                  id: msgId,
                  timestamp: '1756000000',
                  type: 'interactive',
                  interactive: { type: 'button_reply', button_reply: { id: buttonId, title } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function audioPayload(from: string, msgId: string, mediaId: string): object {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              messages: [
                {
                  from,
                  id: msgId,
                  timestamp: '1756000000',
                  type: 'audio',
                  audio: { id: mediaId, mime_type: 'audio/ogg; codecs=opus', voice: true },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
