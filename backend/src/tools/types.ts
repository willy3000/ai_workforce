import type { Types } from 'mongoose';
import type { Workspace } from '../integrations/filesystem/workspace';
import type { GitManager } from '../integrations/github/git-manager';
import type { IProject } from '../database/models/project.model';
import type { IRepository } from '../database/models/repository.model';
import type { AgentPermissions } from '../agents/types';
import type { Logger } from '../utils/logger';
import type { LlmToolDefinition } from '../services/llm/types';
import type { WorkspacePackage } from '../services/workspace-packages';
import type { WorkspaceRepo } from '../integrations/github/workspace-repos';

/**
 * Everything a tool is allowed to touch, handed to it explicitly.
 *
 * Tools receive capabilities through this context rather than importing
 * singletons: it makes each tool trivially testable, and it means the
 * permission profile travelling with the context is the *only* authority a tool
 * can act under — there is no ambient access path around it.
 */
export interface ToolContext {
  projectId: Types.ObjectId;
  taskId?: Types.ObjectId;
  workflowRunId?: Types.ObjectId;
  agentKey: string;
  permissions: AgentPermissions;
  project: IProject;
  repository?: IRepository;
  workspace: Workspace;
  /**
   * Packages detected in the checkout (`api/`, `web/`, ...). The permission guard
   * scopes each role's globs to the packages it owns; see workspace-packages.ts.
   */
  packages: WorkspacePackage[];
  /** Every git repository in the checkout (the root, or each package with its own). */
  repos: WorkspaceRepo[];
  /** The repository at the checkout root, when there is one. Used by the PR tool. */
  git?: GitManager;
  /** The platform-owned branch for the current workflow run, if any. */
  runBranch?: string;
  logger: Logger;
  /**
   * Cancellation for the owning run. Tools that spawn processes or make network
   * calls must honour it, so stopping a run stops its side effects (audit E1).
   */
  signal?: AbortSignal;
  /** Set by a tool when it produces a durable artifact worth attaching to the task. */
  recordArtifact: (artifact: {
    type: 'file' | 'diff' | 'note' | 'command_output' | 'branch' | 'pull_request';
    path?: string;
    content: string;
  }) => Promise<void>;
  /**
   * Record a verification result against the owning run's change set.
   * Absent for ad-hoc agent calls that have no run to attribute evidence to.
   */
  recordCheck?: (check: {
    command: string;
    exitCode: number | null;
    passed: boolean;
  }) => Promise<void>;
  /** Record a commit the run produced, advancing the change set's head (E8). */
  recordCommit?: (commit: { hash: string; message: string }) => Promise<void>;
}

export interface ToolResult {
  /** Rendered back to the model as the tool_result content. */
  output: string;
  isError?: boolean;
  /** Structured data for the platform's own bookkeeping (never sent to the model). */
  data?: Record<string, unknown>;
}

export interface Tool<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: LlmToolDefinition['input_schema'];
  /** Tools that change the repository are gated by approval + permissions. */
  mutating: boolean;
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
}

export function defineTool<TInput = Record<string, unknown>>(tool: Tool<TInput>): Tool<TInput> {
  return tool;
}
