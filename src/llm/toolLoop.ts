import type { ChatMessage, ChatResult, LlmClient, ToolDef } from './client.js';

export interface ToolHandler {
  def: ToolDef;
  run(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const MAX_ITERATIONS = 10;

/**
 * Manual tool-use loop. Tools are a short whitelist of local functions; each
 * enforces its own tier rules in code (Tier 2 tools only ever create
 * proposals — nothing here touches the world directly). Tool results return
 * data, never credentials.
 */
export async function runToolLoop(
  client: LlmClient,
  task: string,
  system: string,
  history: ChatMessage[],
  tools: ToolHandler[],
): Promise<string> {
  const defs = tools.map((t) => t.def);
  const byName = new Map(tools.map((t) => [t.def.name, t]));
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res: ChatResult = await client.chat({ task, messages, tools: defs });
    if (res.toolCalls.length === 0) {
      return res.content ?? '';
    }
    messages.push({
      role: 'assistant',
      content: res.content ?? '',
      tool_calls: res.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });
    for (const tc of res.toolCalls) {
      const handler = byName.get(tc.name);
      let result: Record<string, unknown>;
      if (!handler) {
        result = { error: `unknown tool ${tc.name}` };
      } else {
        try {
          const args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
          result = await handler.run(args);
        } catch (err) {
          result = { error: String(err) };
        }
      }
      messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
    }
  }
  return 'Sorry, I got stuck on that one. Could you rephrase?';
}
