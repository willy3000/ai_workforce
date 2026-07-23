/**
 * Provider-agnostic LLM types.
 *
 * The agent runtime is written against these types, not against the Anthropic
 * SDK's. That boundary is what allows a second provider (or a different Claude
 * surface, e.g. Bedrock) to be added without touching agents, tools, or
 * workflows — only `claude-client.ts` implements it.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/**
 * Opaque provider state that must survive a round trip.
 *
 * Gemini 3.x returns a `thoughtSignature` on text and functionCall parts and
 * **rejects the next request if it is not echoed back** in the same position
 * (400: "Function call is missing a thought_signature"). Claude has no
 * equivalent. Rather than leak that asymmetry into the agent runtime, the
 * signature rides along on the content block: the runtime already replays
 * `response.content` verbatim, so it round-trips for free and every provider
 * ignores the field it does not use.
 */
export interface ProviderSignature {
  thoughtSignature?: string;
}

export interface TextBlock extends ProviderSignature {
  type: 'text';
  text: string;
}

export interface ToolUseBlock extends ProviderSignature {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

/** Blocks we act on. Unknown block types are preserved opaquely for replay. */
export type ResponseBlock = TextBlock | ToolUseBlock | ThinkingBlock | { type: string; [k: string]: unknown };

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlockParam = TextBlock | ToolResultBlock | Record<string, unknown>;

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlockParam[];
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'pause_turn'
  | 'refusal'
  | string;

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  id: string;
  model: string;
  stopReason: StopReason;
  /** Raw content blocks — echoed back verbatim on the next turn. */
  content: ResponseBlock[];
  text: string;
  toolUses: ToolUseBlock[];
  usage: LlmUsage;
  refusal?: { category?: string; explanation?: string };
}

export interface LlmCompletionRequest {
  /** Stable prefix (project profile, agent instructions) — cached. */
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  model?: string;
  maxTokens?: number;
  effort?: Effort;
  /** Adaptive thinking is on by default; disable for cheap mechanical calls. */
  thinking?: boolean;
  /** Emit a summarized reasoning trace we can persist for auditability. */
  showThinking?: boolean;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmCompletionRequest): Promise<LlmResponse>;
}
