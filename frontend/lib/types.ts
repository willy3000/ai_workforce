/** Types mirroring the backend API responses. */

export interface ProjectProfile {
  projectName: string;
  languages: string[];
  frameworks: string[];
  architecture: string;
  database: string;
  testingFramework: string;
  deployment: string;
  conventions: string[];
  packageManagers: string[];
  entryPoints: string[];
  buildCommand?: string;
  testCommand?: string;
  fileCount: number;
  totalBytes: number;
}

export interface Project {
  _id: string;
  name: string;
  description?: string;
  status: 'connecting' | 'analyzing' | 'ready' | 'failed';
  profile: ProjectProfile;
  workspacePath?: string;
  customInstructions?: string;
  lastAnalyzedAt?: string;
  error?: string;
  createdAt: string;
}

export interface RepositorySummary {
  id: string;
  provider: string;
  url: string;
  defaultBranch: string;
  currentBranch: string;
  headCommit?: string;
  indexedFiles: number;
  indexedAt?: string;
}

export type TaskStatus =
  | 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'awaiting_review'
  | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';

export interface TaskArtifact {
  type: 'file' | 'diff' | 'note' | 'command_output' | 'branch' | 'pull_request';
  path?: string;
  content: string;
  createdAt: string;
}

export interface TaskHistoryEntry {
  at: string;
  actor: string;
  from?: string;
  to?: string;
  note: string;
}

export interface Task {
  _id: string;
  projectId: string;
  workflowRunId?: string;
  title: string;
  description: string;
  type: string;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignedTo?: string;
  createdBy: string;
  acceptanceCriteria: string[];
  result?: string;
  artifacts: TaskArtifact[];
  history: TaskHistoryEntry[];
  attempts: number;
  error?: string;
  createdAt: string;
}

export interface AgentMessage {
  _id: string;
  projectId: string;
  taskId?: string;
  from: string;
  to: string;
  intent: string;
  message: string;
  readAt?: string;
  createdAt: string;
}

export interface AgentPermissionsView {
  canWrite: boolean;
  writePaths: string[];
  deniedPaths: string[];
  canRunCommands: boolean;
  allowedCommands: string[];
  canWriteGit: boolean;
  requiresHumanApproval: boolean;
  maxToolCalls: number;
}

export interface Agent {
  key: string;
  name: string;
  role: string;
  description: string;
  capabilities: string[];
  tools: string[];
  model: string;
  effort: string;
  permissions: AgentPermissionsView;
  stats: { runs: number; toolCalls: number; inputTokens: number; outputTokens: number };
}

export type StepStatus =
  | 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'skipped' | 'failed';

/**
 * Why a step reached its status.
 *
 * Separate from `status` because "the engine moved past this step" and "the work
 * succeeded" are different questions. A refusal, a truncated response and an
 * iteration-limit stop all ended the step; none of them produced usable work.
 */
export type StepOutcome =
  | 'completed' | 'needs_review' | 'blocked' | 'refused'
  | 'truncated' | 'iteration_limit' | 'error' | 'cancelled';

export interface WorkflowStepState {
  id: string;
  name: string;
  agentKey: string;
  status: StepStatus;
  outcome?: StepOutcome;
  taskId?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  usage?: { inputTokens: number; outputTokens: number; toolCalls: number };
  attempt?: number;
}

export type RunStatus =
  | 'pending' | 'queued' | 'running' | 'awaiting_approval'
  | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type RunOutcome = 'delivered' | 'needs_review' | 'blocked' | 'failed' | 'cancelled';

/**
 * What a run actually produced, recorded by the platform from observed effects
 * rather than described by a model. This is the evidence a reviewer approves.
 */
export interface ChangeSet {
  baseCommit?: string;
  headCommit?: string;
  branch?: string;
  changedPaths?: string[];
  commits?: { hash: string; message: string; at: string }[];
  pullRequest?: { number: number; url: string; draft: boolean; openedAt: string };
  checks?: { command: string; exitCode: number | null; passed: boolean; at: string }[];
  /** One per git repository in the checkout, each with its own publication. */
  repos?: RunRepoState[];
}

export interface RunRepoState {
  /** Workspace-relative directory; '' for a repository at the checkout root. */
  root: string;
  baseBranch: string;
  baseCommit: string;
  /** The operator's pre-existing uncommitted work, committed first and labelled. */
  baselineCommit?: string;
  headCommit?: string;
  changedPaths?: string[];
  published?: { target: string; at: string };
  publishError?: string;
}

export interface WorkflowRun {
  _id: string;
  projectId: string;
  workflow: string;
  request: string;
  status: RunStatus;
  outcome?: RunOutcome;
  steps: WorkflowStepState[];
  context: Record<string, string>;
  changeSet?: ChangeSet;
  summary?: string;
  error?: string;
  startedBy: string;
  /** Present on the API but previously missing here, which broke elapsed time. */
  startedAt?: string;
  completedAt?: string;
  cancelRequestedAt?: string;
  usage?: { inputTokens: number; outputTokens: number; toolCalls: number };
  createdAt: string;
  updatedAt?: string;
}

export interface WorkflowDefinition {
  key: string;
  name: string;
  description: string;
  trigger: string;
  steps: {
    id: string;
    name: string;
    agent: string;
    dependsOn: string[];
    conditional: boolean;
    optional: boolean;
    requiresApproval: boolean;
  }[];
}

export interface KnowledgeEntry {
  id: string;
  kind: string;
  title: string;
  content: string;
  tags: string[];
  paths: string[];
  source: string;
  confidence: number;
  updatedAt: string;
}

export interface DecisionEntry {
  id: string;
  title: string;
  decision: string;
  rationale: string;
  status: string;
  decidedBy: string;
  createdAt: string;
}

export interface MemorySnapshot {
  counts: {
    knowledge: Record<string, number>;
    tasks: Record<string, number>;
    decisions: number;
  };
  decisions: DecisionEntry[];
  knowledge: KnowledgeEntry[];
}

export interface ReadyState {
  status: 'ready' | 'not_ready';
  /** Detail is only returned to an authenticated caller, so every field is optional. */
  checks?: {
    database: boolean;
    claudeApiKey: boolean;
    geminiApiKey: boolean;
    ollamaAvailable?: boolean;
    githubToken: boolean;
  };
  providers?: {
    default: string;
    effective: string;
    configured: string[];
    models: Record<string, string>;
  };
  registry?: { agents: string[]; workflows: string[]; tools: string[] };
  config?: {
    model: string;
    effort: string;
    requireHumanApproval: boolean;
    workspaceRoot: string;
  };
  /** The platform's actual posture, so the UI can stop implying absent controls. */
  security?: {
    authenticated: boolean;
    commandsSandboxed: boolean;
    localImportEnabled: boolean;
    allowedGitHosts: string[];
  };
  limits?: {
    maxConcurrentRuns: number;
    runDeadlineMs: number;
    activeRuns: number;
  };
}

export type AgentOutcome =
  | 'completed' | 'needs_review' | 'blocked' | 'refused'
  | 'truncated' | 'iteration_limit' | 'cancelled' | 'no_completion_report';

export interface AgentRunResult {
  agentKey: string;
  provider?: string;
  output: string;
  stopReason: string;
  /** The authoritative verdict — never infer success from the absence of `error`. */
  outcome: AgentOutcome;
  succeeded: boolean;
  iterations: number;
  toolCalls: { name: string; input: unknown; ok: boolean; summary: string }[];
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  completion?: { status: string; summary: string };
  changedPaths?: string[];
  error?: string;
}
