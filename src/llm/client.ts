import type { EventLog } from '../log/eventLog.js';

/**
 * Provider-agnostic LLM client over the OpenAI-compatible chat completions
 * API. Default host is OpenRouter (with data collection denied so only
 * zero-retention providers serve the request); DeepInfra or any compatible
 * host is a base-URL swap. Models come from env. Hard rule 3: the key lives
 * here; a leak guard refuses to send any request whose serialised body
 * contains a configured secret value.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface ChatResult {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: ChatUsage;
}

export interface ChatOptions {
  /** telemetry label, e.g. 'assistant', 'school_classify', 'curator' */
  task: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  jsonMode?: boolean;
  escalate?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmClient {
  chat(opts: ChatOptions): Promise<ChatResult>;
  readonly defaultModel: string;
}

export class OpenAiCompatClient implements LlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly defaultModel: string,
    private readonly escalatedModel: string,
    private readonly secretValues: string[],
    private readonly log: EventLog,
  ) {}

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const model = opts.escalate ? this.escalatedModel : this.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 2048,
      // OpenRouter: request usage accounting and restrict to zero-retention providers.
      usage: { include: true },
      provider: { data_collection: 'deny' },
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (opts.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const serialised = JSON.stringify(body);
    for (const secret of this.secretValues) {
      if (secret && serialised.includes(secret)) {
        this.log.append({
          actor: 'system',
          chat: null,
          type: 'error',
          payload: { kind: 'secret_leak_blocked', task: opts.task },
        });
        throw new Error('Refusing LLM call: request body contains a configured secret');
      }
    }

    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: serialised,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`LLM call failed: ${res.status} ${errText.slice(0, 500)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      const message = json.choices?.[0]?.message;
      const result: ChatResult = {
        content: message?.content ?? null,
        toolCalls: (message?.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
          costUsd: json.usage?.cost ?? null,
        },
      };
      this.log.append({
        actor: 'system',
        chat: null,
        type: 'llm_call',
        payload: {
          task: opts.task,
          model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
          latencyMs: Date.now() - started,
          ok: true,
        },
      });
      return result;
    } catch (err) {
      this.log.append({
        actor: 'system',
        chat: null,
        type: 'llm_call',
        payload: { task: opts.task, model, latencyMs: Date.now() - started, ok: false },
      });
      throw err;
    }
  }
}
