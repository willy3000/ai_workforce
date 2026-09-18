import { Schema, model, type Types } from 'mongoose';

/**
 * A single execution of a workflow (feature development, bug fix, code review).
 *
 * The run document is the durable state machine: each step records its status,
 * the task it produced, and the agent output. Because state lives here rather
 * than in memory, a run can be resumed after a crash and inspected by a human
 * mid-flight (which is what makes the human-approval gate practical).
 */
export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'skipped'
  | 'failed';

export type WorkflowRunStatus =
  | 'pending'
  // Admitted and durable, but not yet picked up by a worker. This state is what
  // lets the API return a run id immediately instead of holding the HTTP request
  // open for the whole execution (audit findings E4 and the launch-feedback UX
  // finding).
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  // The operator asked to stop and the worker has not yet acknowledged. Distinct
  // from `cancelled`, which asserts that nothing is still executing (E1).
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  // The owning process died mid-run. Recovery marks it so, rather than leaving a
  // `running` run that no worker owns (E4).
  | 'interrupted';

/**
 * How a run ended, separately from whether the engine reached the last step.
 *
 * Audit finding E2: "workflow completed" meant only that the engine traversed
 * its steps. A refusal, a truncated response, an iteration-limit stop and a
 * `needs_review` verdict all became `completed`, so the status the operator
 * trusted did not distinguish "the change is ready" from "the model gave up".
 */
export type WorkflowOutcome =
  /** Every required step produced a completion report and its checks passed. */
  | 'delivered'
  /** Finished, but a human must look before anything is published. */
  | 'needs_review'
  /** An agent reported it could not proceed. */
  | 'blocked'
  /** A step failed: exception, refusal, truncation or iteration limit. */
  | 'failed'
  /** Stopped on request or by deadline. */
  | 'cancelled';

export type StepOutcome =
  | 'completed'
  | 'needs_review'
  | 'blocked'
  | 'refused'
  | 'truncated'
  | 'iteration_limit'
  | 'error'
  | 'cancelled';

export interface IWorkflowStepState {
  id: string;
  name: string;
  agentKey: string;
  status: WorkflowStepStatus;
  /** Why the step reached its status — the machine-readable half of E2. */
  outcome?: StepOutcome;
  taskId?: Types.ObjectId;
  output?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  usage?: { inputTokens: number; outputTokens: number; toolCalls: number };
  /** Attempt counter, so a retry is distinguishable from the original run. */
  attempt?: number;
}

/**
 * The change a run produced, recorded by the platform rather than described by a
 * model.
 *
 * Audit finding E8: PR/review evidence was unreliable because nothing owned an
 * immutable base commit. The commit tool asked for the *working-tree* diff after
 * committing (which is empty by construction), and QA reviewed unstaged changes.
 * Pinning `baseCommit` when the run claims the checkout, and recording
 * `headCommit` as it advances, is what makes "here is exactly what changed"
 * answerable.
 */
export interface IChangeSet {
  /** Commit the run started from. Never updated after the run begins. */
  baseCommit?: string;
  /** Latest commit produced by the run. */
  headCommit?: string;
  branch?: string;
  /** Repository-relative paths touched, deduplicated across steps. */
  changedPaths?: string[];
  commits?: { hash: string; message: string; at: Date }[];
  pullRequest?: { number: number; url: string; draft: boolean; openedAt: Date };
  /** Verification commands the run actually executed, with their exit codes. */
  checks?: { command: string; exitCode: number | null; passed: boolean; at: Date }[];
  /**
   * One entry per git repository in the checkout. A local import can hold
   * several (a backend repo and a frontend repo side by side), and each gets
   * the run branch, its own base and head, and its own publication.
   */
  repos?: IRunRepoState[];
}

export interface IRunRepoState {
  /** Workspace-relative directory of the repository; '' for the checkout root. */
  root: string;
  /** The branch and commit the run started from. */
  baseBranch: string;
  baseCommit: string;
  /**
   * The operator's uncommitted work at run start, committed as its own labelled
   * commit so the feature's diff (`baselineCommit..headCommit`) is clean.
   */
  baselineCommit?: string;
  headCommit?: string;
  changedPaths?: string[];
  /** Where the run branch was pushed, so it can be checked out and tested. */
  published?: { target: string; at: Date };
  publishError?: string;
}

export interface IWorkflowRun {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  workflow: string;
  request: string;
  status: WorkflowRunStatus;
  outcome?: WorkflowOutcome;
  steps: IWorkflowStepState[];
  /** Cross-step scratchpad: step id -> output summary, used for prompt templating. */
  context: Record<string, string>;
  changeSet?: IChangeSet;
  summary?: string;
  error?: string;
  startedBy: string;
  startedAt?: Date;
  completedAt?: Date;
  /** Set when an operator requests cancellation, before the worker acknowledges. */
  cancelRequestedAt?: Date;
  cancelRequestedBy?: string;
  /**
   * Execution lease. `leaseOwner` identifies the process that claimed the run and
   * `leaseExpiresAt` is refreshed as it works; a lease in the past means the
   * owner died and the run may be recovered (E3/E4).
   */
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  /** Total provider usage, accumulated as steps finish rather than only at the end. */
  usage?: { inputTokens: number; outputTokens: number; toolCalls: number };
  createdAt: Date;
  updatedAt: Date;
}

const StepSchema = new Schema<IWorkflowStepState>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    agentKey: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'awaiting_approval', 'completed', 'skipped', 'failed'],
      default: 'pending',
    },
    outcome: {
      type: String,
      enum: [
        'completed', 'needs_review', 'blocked', 'refused',
        'truncated', 'iteration_limit', 'error', 'cancelled',
      ],
    },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    output: { type: String },
    error: { type: String },
    startedAt: { type: Date },
    completedAt: { type: Date },
    usage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      toolCalls: { type: Number, default: 0 },
    },
    attempt: { type: Number, default: 0 },
  },
  { _id: false },
);

const ChangeSetSchema = new Schema<IChangeSet>(
  {
    baseCommit: { type: String },
    headCommit: { type: String },
    branch: { type: String },
    changedPaths: { type: [String], default: [] },
    commits: {
      type: [
        new Schema(
          { hash: String, message: String, at: Date },
          { _id: false },
        ),
      ],
      default: [],
    },
    pullRequest: {
      type: new Schema(
        { number: Number, url: String, draft: Boolean, openedAt: Date },
        { _id: false },
      ),
      required: false,
    },
    checks: {
      type: [
        new Schema(
          { command: String, exitCode: Number, passed: Boolean, at: Date },
          { _id: false },
        ),
      ],
      default: [],
    },
    repos: { type: [Schema.Types.Mixed], default: [] },
  },
  { _id: false },
);

const WorkflowRunSchema = new Schema<IWorkflowRun>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    workflow: { type: String, required: true, index: true },
    request: { type: String, required: true },
    status: {
      type: String,
      enum: [
        'pending', 'queued', 'running', 'awaiting_approval',
        'cancelling', 'completed', 'failed', 'cancelled', 'interrupted',
      ],
      default: 'pending',
      index: true,
    },
    outcome: {
      type: String,
      enum: ['delivered', 'needs_review', 'blocked', 'failed', 'cancelled'],
    },
    steps: { type: [StepSchema], default: [] },
    context: { type: Schema.Types.Mixed, default: {} },
    changeSet: { type: ChangeSetSchema, default: () => ({}) },
    summary: { type: String },
    error: { type: String },
    startedBy: { type: String, default: 'human' },
    startedAt: { type: Date },
    completedAt: { type: Date },
    cancelRequestedAt: { type: Date },
    cancelRequestedBy: { type: String },
    leaseOwner: { type: String },
    leaseExpiresAt: { type: Date },
    usage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      toolCalls: { type: Number, default: 0 },
    },
  },
  { timestamps: true, collection: 'workflow_runs' },
);

WorkflowRunSchema.index({ projectId: 1, createdAt: -1 });
// Recovery scan: find runs whose owner died. Partial so it indexes only the
// handful of in-flight runs rather than every run ever executed.
WorkflowRunSchema.index(
  { status: 1, leaseExpiresAt: 1 },
  { partialFilterExpression: { status: { $in: ['queued', 'running', 'cancelling'] } } },
);

export const WorkflowRunModel = model<IWorkflowRun>('WorkflowRun', WorkflowRunSchema);
