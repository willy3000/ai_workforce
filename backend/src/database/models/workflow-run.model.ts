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
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface IWorkflowStepState {
  id: string;
  name: string;
  agentKey: string;
  status: WorkflowStepStatus;
  taskId?: Types.ObjectId;
  output?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  usage?: { inputTokens: number; outputTokens: number; toolCalls: number };
}

export interface IWorkflowRun {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  workflow: string;
  request: string;
  status: WorkflowRunStatus;
  steps: IWorkflowStepState[];
  /** Cross-step scratchpad: step id -> output summary, used for prompt templating. */
  context: Record<string, string>;
  summary?: string;
  error?: string;
  startedBy: string;
  startedAt?: Date;
  completedAt?: Date;
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
      enum: ['pending', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    steps: { type: [StepSchema], default: [] },
    context: { type: Schema.Types.Mixed, default: {} },
    summary: { type: String },
    error: { type: String },
    startedBy: { type: String, default: 'human' },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true, collection: 'workflow_runs' },
);

WorkflowRunSchema.index({ projectId: 1, createdAt: -1 });

export const WorkflowRunModel = model<IWorkflowRun>('WorkflowRun', WorkflowRunSchema);
