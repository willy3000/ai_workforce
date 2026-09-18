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
  /**
   * In a repository with several packages (`api/`, `web/`, ...), which kinds of
   * package this role may write inside. `writePaths` are then evaluated relative
   * to that package's directory. Omit to allow every package kind.
   */
  packageKinds?: import('../services/workspace-packages').PackageKind[];
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
  denyPaths: [],
  allowTerminal: false,
  allowedCommands: [],
  allowGitWrite: false,
  requiresHumanApproval: false,
  maxToolCalls: 30,
};

/**
 * Role-independent denials layered onto every agent's `denyPaths`.
 *
 * Secret files are **not** listed here. They are enforced centrally by
 * `security/secret-paths.ts`, which `PermissionGuard` consults before any
 * allow or deny rule and which the filesystem layer consults again.
 *
 * Keeping a second copy of the secret globs here was actively harmful: the two
 * lists drifted, and the one in this file denied `.env.example` — a template
 * that documents which variables exist and holds no values — while the central
 * policy deliberately allows it. Two sources of truth for one policy means the
 * stricter one silently wins and nobody knows which is in force.
 *
 * What remains is the one path that is not a *secret* but still must never be
 * touched: the git directory is the platform's own bookkeeping, and an agent
 * editing it corrupts the checkout the run depends on.
 */
export const ALWAYS_DENIED: string[] = ['.git/**', '**/.git/**'];

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
  /**
   * Aborting stops the provider call, the tool loop and any spawned process.
   * Supplied by the execution registry; see audit finding E1.
   */
  signal?: AbortSignal;
}

/**
 * How an agent run actually ended.
 *
 * Audit finding E2: the runtime signalled failure by setting a `.error` string
 * that callers did not consistently read, so a refused, truncated or
 * iteration-capped run was recorded as a completed workflow step. An explicit
 * enum forces every caller to handle each case, and makes "completed" mean the
 * agent said so rather than "no exception escaped".
 */
export type AgentOutcome =
  /** The agent called report_completion with status `completed`. */
  | 'completed'
  /** The agent finished but asked for human review before anything is published. */
  | 'needs_review'
  /** The agent reported it cannot proceed. */
  | 'blocked'
  /** The model declined the request; retrying the same prompt will not help. */
  | 'refused'
  /** The response hit the output token limit mid-answer. */
  | 'truncated'
  /** The loop ran out of iterations without a completion report. */
  | 'iteration_limit'
  /** The run was cancelled by an operator or by the run deadline. */
  | 'cancelled'
  /** The loop ended with text but no completion report — an ambiguous stop. */
  | 'no_completion_report';

/** Outcomes that mean the agent's work may be treated as usable. */
export const SUCCESSFUL_OUTCOMES: AgentOutcome[] = ['completed'];

export interface AgentRunResult {
  agentKey: string;
  /** Which provider actually answered — never inferred, always recorded. */
  provider?: string;
  output: string;
  stopReason: string;
  /** The authoritative verdict. Callers branch on this, never on `error`. */
  outcome: AgentOutcome;
  /** True only for outcomes the platform is willing to call a success. */
  succeeded: boolean;
  iterations: number;
  toolCalls: { name: string; input: unknown; ok: boolean; summary: string }[];
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  completion?: { status: 'completed' | 'blocked' | 'needs_review'; summary: string };
  thinking?: string[];
  error?: string;
  /** Repository-relative paths this run wrote, for the run's change set (E8). */
  changedPaths?: string[];
}
