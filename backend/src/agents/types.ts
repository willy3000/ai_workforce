import type { Effort } from '../services/llm/types';

/**
 * What an agent is allowed to do.
 *
 * Permissions are part of the *definition*, not a runtime argument, so the blast
 * radius of every role is reviewable in one file. Paths are globs evaluated
 * against repository-relative paths (`**` = any depth).
 */
export interface AgentPermissions {
  readPaths: string[];
  writePaths: string[];
  /** Evaluated first and wins over any allow rule. */
  denyPaths: string[];
  allowTerminal: boolean;
  allowedCommands: string[];
  allowGitWrite: boolean;
  /** When true, mutating work pauses in `awaiting_approval` until a human approves. */
  requiresHumanApproval: boolean;
  maxToolCalls: number;
}

export interface AgentDefinition {
  /** Stable identifier used in tasks, messages and routing. */
  key: string;
  name: string;
  role: string;
  description: string;
  /** Routing signals: the task router scores these against the task. */
  capabilities: string[];
  /** Body of the system prompt: responsibilities, method, and boundaries. */
  instructions: string;
  /** Tool names resolved through the ToolRegistry. */
  tools: string[];
  permissions: AgentPermissions;
  model?: string;
  effort?: Effort;
  /**
   * Pin this role to a specific LLM provider ('claude' | 'gemini' | 'ollama').
   * Omit to use the platform default (`LLM_PROVIDER`). Useful for deliberately
   * getting a second opinion — e.g. running QA on a different model family than
   * the engineer whose work it is reviewing.
   */
  provider?: string;
  /** Persist a summarized reasoning trace for this agent's runs. */
  auditThinking?: boolean;
}

/** Sensible baseline: read everything, change nothing, run nothing. */
export const READ_ONLY_PERMISSIONS: AgentPermissions = {
  readPaths: ['**'],
  writePaths: [],
  denyPaths: ['.env', '.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/secrets/**'],
  allowTerminal: false,
  allowedCommands: [],
  allowGitWrite: false,
  requiresHumanApproval: false,
  maxToolCalls: 30,
};

/**
 * Secrets are denied to every role without exception. An agent has no
 * legitimate need to read credentials, and a model that has read them may echo
 * them into a task result, a commit, or a pull-request body.
 */
export const ALWAYS_DENIED: string[] = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/id_rsa*',
  '**/secrets/**',
  '**/credentials.json',
  '.git/**',
];

export function permissions(overrides: Partial<AgentPermissions>): AgentPermissions {
  return {
    ...READ_ONLY_PERMISSIONS,
    ...overrides,
    denyPaths: [...new Set([...ALWAYS_DENIED, ...(overrides.denyPaths ?? [])])],
  };
}

export interface AgentRunInput {
  projectId: string;
  taskId?: string;
  workflowRunId?: string;
  /** The instruction for this turn. */
  prompt: string;
  /** Extra context blocks assembled by the caller (workflow step outputs, etc). */
  additionalContext?: string;
  maxIterations?: number;
  /** Override the LLM provider for this run only. */
  provider?: string;
}

export interface AgentRunResult {
  agentKey: string;
  /** Which provider actually answered — never inferred, always recorded. */
  provider?: string;
  output: string;
  stopReason: string;
  iterations: number;
  toolCalls: { name: string; input: unknown; ok: boolean; summary: string }[];
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  completion?: { status: 'completed' | 'blocked' | 'needs_review'; summary: string };
  thinking?: string[];
  error?: string;
}
