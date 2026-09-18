import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ProviderError } from '../../utils/errors';
import { combineSignals } from './types';
import { GeminiQuotaLimiter } from './gemini-quota';
import type {
  Effort,
  LlmCompletionRequest,
  LlmMessage,
  LlmProvider,
  LlmResponse,
  LlmToolDefinition,
  ResponseBlock,
  ToolUseBlock,
} from './types';

/**
 * Google Gemini provider.
 *
 * Implemented against the REST API with `fetch` rather than an SDK. That is a
 * deliberate trade-off: the `generateContent` wire format is stable and small,
 * whereas Google's JS SDK has changed package name and surface twice
 * (`@google/generative-ai` → `@google/genai`). Pinning the platform to one of
 * those would put a moving dependency underneath the agent loop for no gain —
 * we use four fields of the response.
 *
 * ## Translating between the two model APIs
 *
 * The platform's internal format is Anthropic-shaped (it was the first
 * provider). Everything Gemini-specific is confined to this file:
 *
 * | Platform / Claude         | Gemini                                    |
 * |---------------------------|-------------------------------------------|
 * | `system` (string)         | `systemInstruction.parts[].text`           |
 * | role `assistant`          | role `model`                               |
 * | `messages[].content[]`    | `contents[].parts[]`                       |
 * | `tools[].input_schema`    | `tools[0].functionDeclarations[].parameters` |
 * | `tool_use` block          | `functionCall` part                        |
 * | `tool_result` block       | `functionResponse` part                    |
 * | adaptive thinking         | `generationConfig.thinkingConfig`          |
 * | `stop_reason`             | `candidates[0].finishReason`               |
 *
 * ### The one genuinely awkward difference
 * Claude correlates a tool result to its call by `tool_use_id`; Gemini
 * correlates **by function name**. Our internal format carries the id, so this
 * provider rebuilds an id→name map by scanning the conversation each call. The
 * history is resent on every request anyway, so this costs nothing and keeps
 * the awkwardness out of the agent runtime.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini rejects JSON-Schema keywords it does not implement, so tool schemas are filtered. */
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable',
]);

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown>; thoughtSignature?: string };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thought?: boolean;
  /**
   * Gemini 3.x reasoning receipt. Must be echoed back verbatim when this part is
   * replayed in history, or the API rejects the request with a 400.
   */
  thoughtSignature?: string;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
    safetyRatings?: unknown[];
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { code: number; message: string; status: string };
}

export class GeminiProvider implements LlmProvider {
  public readonly name = 'gemini';

  constructor(
    private readonly apiKey: string = env.GEMINI_API_KEY,
    private readonly defaultModel: string = env.GEMINI_MODEL,
    private readonly quota = new GeminiQuotaLimiter(env.GEMINI_RPM_LIMIT, env.GEMINI_TPM_LIMIT),
  ) {}

  async complete(request: LlmCompletionRequest): Promise<LlmResponse> {
    if (!this.apiKey) {
      throw new ProviderError(
        'GEMINI_API_KEY is not configured. Set it in backend/.env, or switch LLM_PROVIDER back to "claude".',
      );
    }

    const model = request.model ?? this.defaultModel;
    const maxTokens = request.maxTokens ?? env.CLAUDE_MAX_TOKENS;

    const contents = this.toContents(request.messages);
    const tools = request.tools?.length
      ? [{ functionDeclarations: request.tools.map((t) => this.toFunctionDeclaration(t)) }]
      : undefined;
    const estimatedInputTokens = this.estimateTokens({ system: request.system, contents, tools });
    const maxOutputTokens = Math.min(
      maxTokens,
      env.GEMINI_TPM_LIMIT - estimatedInputTokens,
    );
    if (maxOutputTokens < 256) {
      throw new ProviderError(
        `Gemini prompt is too large for the ${env.GEMINI_TPM_LIMIT}-token per-minute quota.`,
        { code: 'gemini_tpm_exceeded' },
      );
    }

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents,
      generationConfig: {
        maxOutputTokens,
        ...this.thinkingConfig(model, request),
      },
    };

    if (request.tools?.length) {
      body.tools = tools;
      // Let the model decide when to call a tool, matching Claude's default.
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }

    const startedAt = Date.now();
    const reservation = await this.quota.reserve(estimatedInputTokens, maxOutputTokens, request.signal);
    const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
      // Both the per-request timeout and the run's cancellation must be able to
      // abort this call, so they are combined rather than chosen between.
      signal: combineSignals(AbortSignal.timeout(10 * 60 * 1000), request.signal),
    });

    const payload = (await res.json().catch(() => ({}))) as GeminiResponse;

    if (!res.ok || payload.error) {
      const message = payload.error?.message ?? `HTTP ${res.status}`;
      throw new ProviderError(`Gemini API error (${res.status}): ${message}`, {
        status: res.status,
        code: payload.error?.status,
      });
    }

    const normalized = this.normalize(payload, model);
    reservation.release(normalized.usage.inputTokens + normalized.usage.outputTokens);
    logger.debug(
      {
        provider: 'gemini',
        model,
        stopReason: normalized.stopReason,
        durationMs: Date.now() - startedAt,
        usage: normalized.usage,
        toolCalls: normalized.toolUses.length,
      },
      'Gemini completion',
    );
    return normalized;
  }

  private estimateTokens(input: unknown): number {
    // A UTF-8 byte is a conservative upper bound for a token, including for
    // code, JSON punctuation, and non-ASCII input. This favors waiting/rejecting
    // over risking an account-level TPM violation.
    return Buffer.byteLength(JSON.stringify(input), 'utf8');
  }

  /**
   * Effort → thinking budget.
   *
   * Gemini takes an explicit token budget where Claude takes an effort level;
   * `-1` means "decide dynamically", which is the closest analogue to Claude's
   * adaptive thinking and what we use for the higher effort levels.
   */
  private thinkingConfig(model: string, request: LlmCompletionRequest): Record<string, unknown> {
    // Gemma models exposed through the Gemini API reject thinkingConfig rather
    // than ignoring it. Their reasoning behavior is model-controlled.
    if (model.toLowerCase().startsWith('gemma')) return {};
    if (request.thinking === false) return { thinkingConfig: { thinkingBudget: 0 } };
    const byEffort: Record<Effort, number> = {
      low: 2048,
      medium: 8192,
      high: -1,
      xhigh: -1,
      max: -1,
    };
    const effort = (request.effort ?? env.CLAUDE_EFFORT);
    return {
      thinkingConfig: {
        thinkingBudget: byEffort[effort] ?? -1,
        includeThoughts: Boolean(request.showThinking),
      },
    };
  }

  private toFunctionDeclaration(tool: LlmToolDefinition) {
    return {
      name: tool.name,
      description: tool.description,
      parameters: this.sanitizeSchema(tool.input_schema) as Record<string, unknown>,
    };
  }

  /** Strip JSON-Schema keywords Gemini rejects (notably `additionalProperties`). */
  private sanitizeSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map((s) => this.sanitizeSchema(s));
    if (!schema || typeof schema !== 'object') return schema;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (!SUPPORTED_SCHEMA_KEYS.has(key)) continue;
      if (key === 'properties' && value && typeof value === 'object') {
        const props: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
          props[propName] = this.sanitizeSchema(propSchema);
        }
        out[key] = props;
      } else if (key === 'items') {
        out[key] = this.sanitizeSchema(value);
      } else {
        out[key] = value;
      }
    }
    // Gemini requires `type` on every schema node.
    if (!out.type && out.properties) out.type = 'object';
    return out;
  }

  /**
   * Convert the platform's message list into Gemini `contents`.
   *
   * Builds the tool_use_id → function-name map from the assistant turns as it
   * goes, so the tool_result blocks that follow can be emitted as
   * `functionResponse` parts with the name Gemini expects.
   */
  private toContents(messages: LlmMessage[]): { role: string; parts: GeminiPart[] }[] {
    const idToName = new Map<string, string>();

    // First pass: learn every tool_use id → name from prior assistant turns.
    for (const msg of messages) {
      if (typeof msg.content === 'string') continue;
      for (const block of msg.content) {
        const b = block as { type?: string; id?: string; name?: string };
        if (b.type === 'tool_use' && b.id && b.name) idToName.set(b.id, b.name);
      }
    }

    const contents: { role: string; parts: GeminiPart[] }[] = [];

    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';

      if (typeof msg.content === 'string') {
        contents.push({ role, parts: [{ text: msg.content }] });
        continue;
      }

      const parts: GeminiPart[] = [];
      for (const block of msg.content) {
        const b = block as {
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
          tool_use_id?: string;
          content?: string;
          is_error?: boolean;
          thoughtSignature?: string;
        };

        switch (b.type) {
          case 'text':
            if (b.text?.trim()) {
              // Echo the signature back in the same position it arrived.
              parts.push(
                b.thoughtSignature
                  ? { text: b.text, thoughtSignature: b.thoughtSignature }
                  : { text: b.text },
              );
            }
            break;

          case 'tool_use': {
            const part: GeminiPart = {
              functionCall: { name: b.name ?? 'unknown', args: b.input ?? {} },
            };
            // Required by Gemini 3.x — without it the next turn 400s.
            if (b.thoughtSignature) part.thoughtSignature = b.thoughtSignature;
            parts.push(part);
            break;
          }

          case 'tool_result': {
            const fnName = (b.tool_use_id && idToName.get(b.tool_use_id)) || 'unknown';
            parts.push({
              functionResponse: {
                name: fnName,
                // Gemini requires an object; the platform's tool output is text.
                response: b.is_error
                  ? { error: b.content ?? '' }
                  : { result: b.content ?? '' },
              },
            });
            break;
          }

          // `thinking` blocks are Claude-specific and are not replayed to Gemini.
          default:
            break;
        }
      }

      if (parts.length) contents.push({ role, parts });
    }

    return contents;
  }

  private normalize(payload: GeminiResponse, model: string): LlmResponse {
    const candidate = payload.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const content: ResponseBlock[] = [];
    const toolUses: ToolUseBlock[] = [];
    let text = '';

    for (const [i, part] of parts.entries()) {
      // The signature may arrive on the part or nested in functionCall.
      const signature = part.thoughtSignature ?? part.functionCall?.thoughtSignature;

      if (part.functionCall) {
        // Gemini returns no call id; synthesise a stable one so the rest of the
        // platform (which is id-based) works unchanged.
        const id = `gemini_${Date.now()}_${i}`;
        const block: ToolUseBlock = {
          type: 'tool_use',
          id,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
          ...(signature ? { thoughtSignature: signature } : {}),
        };
        toolUses.push(block);
        content.push(block);
      } else if (typeof part.text === 'string') {
        if (part.thought) {
          content.push({ type: 'thinking', thinking: part.text });
        } else {
          text += part.text;
          content.push({
            type: 'text',
            text: part.text,
            ...(signature ? { thoughtSignature: signature } : {}),
          });
        }
      }
    }

    const usage = payload.usageMetadata ?? {};

    return {
      id: `gemini-${Date.now()}`,
      model,
      stopReason: this.mapFinishReason(candidate?.finishReason, toolUses.length > 0, payload),
      content,
      text: text.trim(),
      toolUses,
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        // Thinking tokens are billed as output; include them so cost reporting
        // in the dashboard is comparable across providers.
        outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
        cacheReadTokens: usage.cachedContentTokenCount ?? 0,
        cacheWriteTokens: 0,
      },
      refusal:
        candidate?.finishReason === 'SAFETY' || payload.promptFeedback?.blockReason
          ? {
              category: payload.promptFeedback?.blockReason ?? 'safety',
              explanation: 'Gemini blocked this request under its safety policy.',
            }
          : undefined,
    };
  }

  /** Map Gemini finish reasons onto the platform's (Anthropic-shaped) stop reasons. */
  private mapFinishReason(
    reason: string | undefined,
    hasToolCalls: boolean,
    payload: GeminiResponse,
  ): string {
    if (payload.promptFeedback?.blockReason) return 'refusal';
    switch (reason) {
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'SAFETY':
      case 'PROHIBITED_CONTENT':
      case 'BLOCKLIST':
        return 'refusal';
      case 'STOP':
      case undefined:
        return hasToolCalls ? 'tool_use' : 'end_turn';
      default:
        return hasToolCalls ? 'tool_use' : 'end_turn';
    }
  }
}

export const geminiProvider = new GeminiProvider();
