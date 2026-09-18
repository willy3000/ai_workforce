import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ProviderError } from '../../utils/errors';
import { combineSignals } from './types';
import type {
  LlmCompletionRequest,
  LlmMessage,
  LlmProvider,
  LlmResponse,
  LlmToolDefinition,
  ResponseBlock,
  ToolUseBlock,
} from './types';

/**
 * Local Ollama provider.
 *
 * Talks to a locally (or LAN-)hosted `ollama serve` over its native
 * `/api/chat` endpoint — no API key, no billing, no network egress beyond the
 * configured host. This is the "free tier" provider: point `LLM_PROVIDER` (or
 * a per-agent/per-call override) at `ollama` to run against a downloaded
 * model instead of a paid Claude/Gemini call.
 *
 * ## Translating between the two model APIs
 *
 * | Platform / Claude         | Ollama                                    |
 * |---------------------------|-------------------------------------------|
 * | `system` (string)         | messages[0] = { role: 'system', ... }     |
 * | `messages[].content[]`    | messages[] (one entry per turn)           |
 * | `tools[].input_schema`    | `tools[].function.parameters`             |
 * | `tool_use` block          | `message.tool_calls[].function`           |
 * | `tool_result` block       | `{ role: 'tool', content }`               |
 * | adaptive thinking         | `think: true/false` (hybrid-reasoning models only) |
 * | `stop_reason`             | `done_reason`                             |
 *
 * Ollama has no `effort` or thinking-budget concept for local models — cost
 * isn't metered, so there is nothing to trade off. `thinking: false` still
 * disables it for models that support toggling (e.g. Qwen3's hybrid mode).
 *
 * ### The one genuinely awkward difference
 * Like Gemini, Ollama's tool calls carry no id — correlation with a prior
 * `tool_use` is by function name only. Our internal format carries the id, so
 * this provider rebuilds an id→name map by scanning the conversation each
 * call, same approach as the Gemini provider.
 */

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatResponse {
  model?: string;
  message?: { role: string; content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaProvider implements LlmProvider {
  public readonly name = 'ollama';

  constructor(
    private readonly baseUrl: string = env.OLLAMA_BASE_URL,
    private readonly defaultModel: string = env.OLLAMA_MODEL,
  ) {}

  async complete(request: LlmCompletionRequest): Promise<LlmResponse> {
    const model = request.model ?? this.defaultModel;
    const maxTokens = request.maxTokens ?? env.CLAUDE_MAX_TOKENS;

    const body: Record<string, unknown> = {
      model,
      messages: this.toMessages(request.system, request.messages),
      stream: false,
      options: { num_predict: maxTokens },
    };

    // Only send `think` when the caller has an opinion — omitting it lets
    // Ollama use the model's own default, which matters for models that
    // don't support the field at all.
    if (request.thinking === false) body.think = false;
    else if (request.showThinking) body.think = true;

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => this.toToolDeclaration(t));
    }

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: combineSignals(AbortSignal.timeout(10 * 60 * 1000), request.signal),
      });
    } catch (err) {
      throw new ProviderError(
        `Could not reach Ollama at ${this.baseUrl} (${(err as Error).message}). ` +
          `Is 'ollama serve' running and OLLAMA_BASE_URL correct?`,
      );
    }

    const payload = (await res.json().catch(() => ({}))) as OllamaChatResponse;

    if (!res.ok || payload.error) {
      throw new ProviderError(`Ollama API error (${res.status}): ${payload.error ?? `HTTP ${res.status}`}`, {
        status: res.status,
      });
    }

    const normalized = this.normalize(payload, model);
    logger.debug(
      {
        provider: 'ollama',
        model,
        stopReason: normalized.stopReason,
        durationMs: Date.now() - startedAt,
        usage: normalized.usage,
        toolCalls: normalized.toolUses.length,
      },
      'Ollama completion',
    );
    return normalized;
  }

  private toToolDeclaration(tool: LlmToolDefinition): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    };
  }

  /**
   * Convert the platform's message list into Ollama's flat chat message list.
   *
   * `tool_result` blocks (sent by the platform bundled into a `user` turn)
   * are split out into their own `role: 'tool'` messages, matching what
   * Ollama's tool-calling models expect.
   */
  private toMessages(system: string, messages: LlmMessage[]): OllamaMessage[] {
    const idToName = new Map<string, string>();
    for (const msg of messages) {
      if (typeof msg.content === 'string') continue;
      for (const block of msg.content) {
        const b = block as { type?: string; id?: string; name?: string };
        if (b.type === 'tool_use' && b.id && b.name) idToName.set(b.id, b.name);
      }
    }

    const out: OllamaMessage[] = [{ role: 'system', content: system }];

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        out.push({ role: msg.role, content: msg.content });
        continue;
      }

      if (msg.role === 'user') {
        const textParts: string[] = [];
        for (const block of msg.content) {
          const b = block as {
            type?: string;
            text?: string;
            tool_use_id?: string;
            content?: string;
            is_error?: boolean;
          };
          if (b.type === 'tool_result') {
            out.push({
              role: 'tool',
              content: b.is_error ? `Error: ${b.content ?? ''}` : (b.content ?? ''),
            });
          } else if (b.type === 'text' && b.text?.trim()) {
            textParts.push(b.text);
          }
        }
        if (textParts.length) out.push({ role: 'user', content: textParts.join('\n') });
        continue;
      }

      // assistant
      const textParts: string[] = [];
      const toolCalls: OllamaToolCall[] = [];
      for (const block of msg.content) {
        const b = block as {
          type?: string;
          text?: string;
          name?: string;
          input?: Record<string, unknown>;
        };
        if (b.type === 'text' && b.text?.trim()) {
          textParts.push(b.text);
        } else if (b.type === 'tool_use') {
          toolCalls.push({ function: { name: b.name ?? 'unknown', arguments: b.input ?? {} } });
        }
        // `thinking` blocks are not replayed — Ollama re-derives reasoning per turn.
      }
      out.push({
        role: 'assistant',
        content: textParts.join('\n'),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }

    return out;
  }

  private normalize(payload: OllamaChatResponse, model: string): LlmResponse {
    const message: NonNullable<OllamaChatResponse['message']> = payload.message ?? { role: 'assistant' };
    const content: ResponseBlock[] = [];
    const toolUses: ToolUseBlock[] = [];

    if (message.thinking) {
      content.push({ type: 'thinking', thinking: message.thinking });
    }
    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }
    for (const [i, call] of (message.tool_calls ?? []).entries()) {
      // Ollama returns no call id; synthesise a stable one, same as the Gemini provider.
      const block: ToolUseBlock = {
        type: 'tool_use',
        id: `ollama_${Date.now()}_${i}`,
        name: call.function.name,
        input: call.function.arguments ?? {},
      };
      toolUses.push(block);
      content.push(block);
    }

    const hasToolCalls = toolUses.length > 0;
    const stopReason = hasToolCalls
      ? 'tool_use'
      : payload.done_reason === 'length'
        ? 'max_tokens'
        : 'end_turn';

    return {
      id: `ollama-${Date.now()}`,
      model: payload.model ?? model,
      stopReason,
      content,
      text: (message.content ?? '').trim(),
      toolUses,
      usage: {
        inputTokens: payload.prompt_eval_count ?? 0,
        outputTokens: payload.eval_count ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
}

export const ollamaProvider = new OllamaProvider();
