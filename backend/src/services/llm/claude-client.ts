import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ProviderError } from '../../utils/errors';
import type {
  LlmCompletionRequest,
  LlmProvider,
  LlmResponse,
  ResponseBlock,
  ToolUseBlock,
} from './types';

/**
 * Anthropic Claude provider.
 *
 * Model-behaviour notes that are load-bearing here (Claude 4.7/4.8 family):
 *
 *  - `temperature` / `top_p` / `top_k` are rejected with a 400 on these models.
 *    Behaviour is steered through the system prompt instead — see agent definitions.
 *  - Fixed thinking budgets (`budget_tokens`) are removed. We use adaptive
 *    thinking plus `output_config.effort` to trade cost against depth per agent:
 *    the Project Manager plans at `high`, the file-mechanical agents run lower.
 *  - Thinking text is omitted by default. We opt into `display: "summarized"`
 *    when an agent's reasoning is persisted for the audit trail.
 *  - `max_tokens` above ~16k risks an HTTP timeout on a non-streaming request,
 *    so anything larger is issued as a stream and collapsed with `finalMessage()`.
 *
 * Prompt caching: the system prompt is sent as a single cached block. Agent
 * instructions + the project profile are the stable prefix and are identical
 * across every step of a workflow, so from the second call onwards that prefix
 * is served from cache. This is why the profile is injected into `system` and
 * the task-specific context into `messages` — never the other way around.
 */
export class ClaudeProvider implements LlmProvider {
  public readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string = env.CLAUDE_API_KEY) {
    this.client = new Anthropic({
      apiKey,
      maxRetries: 3, // SDK retries 429/5xx with exponential backoff
      timeout: 10 * 60 * 1000,
    });
  }

  async complete(request: LlmCompletionRequest): Promise<LlmResponse> {
    const model = request.model ?? env.CLAUDE_MODEL;
    const maxTokens = request.maxTokens ?? env.CLAUDE_MAX_TOKENS;
    const useThinking = request.thinking !== false;

    // Built as a plain object and cast at the call site: `output_config` and
    // adaptive thinking are newer than some SDK typings, and we would rather
    // track the wire API than pin the platform to one SDK minor version.
    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: [
        {
          type: 'text',
          text: request.system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: request.messages,
      output_config: { effort: request.effort ?? env.CLAUDE_EFFORT },
    };

    if (useThinking) {
      params.thinking = request.showThinking
        ? { type: 'adaptive', display: 'summarized' }
        : { type: 'adaptive' };
    } else {
      params.thinking = { type: 'disabled' };
    }

    if (request.tools?.length) params.tools = request.tools;

    const startedAt = Date.now();
    // The SDK accepts a request-level signal; passing the run's signal is what
    // makes cancelling a run stop the in-flight (and billed) turn (audit E1).
    const options = request.signal ? { signal: request.signal } : undefined;
    try {
      const message =
        maxTokens > 16_000
          ? await this.streamed(params, options)
          : ((await this.client.messages.create(
              params as never,
              options,
            )) as unknown as Anthropic.Message);

      const response = this.normalize(message);
      logger.debug(
        {
          model,
          stopReason: response.stopReason,
          durationMs: Date.now() - startedAt,
          usage: response.usage,
          toolCalls: response.toolUses.length,
        },
        'Claude completion',
      );
      return response;
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        // `APIError.status` is loosely typed by the SDK; narrow it here rather
        // than letting an `any` flow into the error envelope the client sees.
        const status = typeof err.status === 'number' ? err.status : undefined;
        throw new ProviderError(`Claude API error (${status ?? 'unknown'}): ${err.message}`, {
          status,
          type: err.name,
        });
      }
      throw err;
    }
  }

  /** Large-output path: streaming avoids the non-streaming HTTP timeout. */
  private async streamed(
    params: Record<string, unknown>,
    options?: { signal: AbortSignal },
  ): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream(params as never, options);
    return stream.finalMessage();
  }

  private normalize(message: Anthropic.Message): LlmResponse {
    const content = message.content as unknown as ResponseBlock[];

    const toolUses: ToolUseBlock[] = content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: (b.input ?? {}),
      }));

    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const usage = message.usage as unknown as {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };

    // `stop_details` is only populated on a refusal and may be absent entirely —
    // always branch on stop_reason first.
    const stopDetails = (message as unknown as {
      stop_details?: { category?: string; explanation?: string } | null;
    }).stop_details;

    return {
      id: message.id,
      model: message.model,
      stopReason: (message.stop_reason ?? 'end_turn'),
      content,
      text,
      toolUses,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
      },
      refusal:
        message.stop_reason === 'refusal'
          ? { category: stopDetails?.category, explanation: stopDetails?.explanation }
          : undefined,
    };
  }
}

export const claudeProvider = new ClaudeProvider();
