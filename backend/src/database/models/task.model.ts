import { Schema, model, type Types } from 'mongoose';

export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'awaiting_review'
  | 'awaiting_approval'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * Numeric urgency, because the string sorts alphabetically.
 *
 * Audit finding E7: `findRunnable` sorted by `priority: -1` on the *string*,
 * giving the descending order `medium > low > high > critical` — the exact
 * inverse of intent for the two urgent levels. Storing a rank alongside the
 * label keeps the readable enum in the API while making the sort correct, and
 * makes the scheduling index (`projectId, status, priorityRank, createdAt`)
 * meaningful.
 */
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function priorityRankOf(priority: TaskPriority | undefined): number {
  return PRIORITY_RANK[priority ?? 'medium'] ?? PRIORITY_RANK.medium;
}

export type TaskType =
  | 'analysis'
  | 'planning'
  | 'architecture'
  | 'backend'
  | 'frontend'
  | 'testing'
  | 'review'
  | 'documentation'
  | 'bugfix'
  | 'devops';

export interface ITaskHistoryEntry {
  at: Date;
  actor: string;
  from?: TaskStatus;
  to?: TaskStatus;
  note: string;
}

export interface ITaskArtifact {
  type: 'file' | 'diff' | 'note' | 'command_output' | 'branch' | 'pull_request';
  path?: string;
  content: string;
  createdAt: Date;
}

export interface ITask {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  workflowRunId?: Types.ObjectId;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  /** Derived from `priority` on every write; the field the scheduler sorts on. */
  priorityRank: number;
  /** Agent key (e.g. `backend-engineer`) this task is assigned to. */
  assignedTo?: string;
  createdBy: string;
  /** Task IDs that must reach `done` before this one becomes `ready`. */
  dependsOn: Types.ObjectId[];
  acceptanceCriteria: string[];
  /** Structured output produced by the assigned agent. */
  result?: string;
  artifacts: ITaskArtifact[];
  history: ITaskHistoryEntry[];
  attempts: number;
  maxAttempts: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const HistorySchema = new Schema<ITaskHistoryEntry>(
  {
    at: { type: Date, default: Date.now },
    actor: { type: String, required: true },
    from: { type: String },
    to: { type: String },
    note: { type: String, default: '' },
  },
  { _id: false },
);

const ArtifactSchema = new Schema<ITaskArtifact>(
  {
    type: {
      type: String,
      enum: ['file', 'diff', 'note', 'command_output', 'branch', 'pull_request'],
      required: true,
    },
    path: { type: String },
    content: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const TaskSchema = new Schema<ITask>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    workflowRunId: { type: Schema.Types.ObjectId, ref: 'WorkflowRun', index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    type: {
      type: String,
      enum: [
        'analysis', 'planning', 'architecture', 'backend', 'frontend',
        'testing', 'review', 'documentation', 'bugfix', 'devops',
      ],
      default: 'analysis',
      index: true,
    },
    status: {
      type: String,
      enum: [
        'backlog', 'ready', 'in_progress', 'blocked', 'awaiting_review',
        'awaiting_approval', 'done', 'failed', 'cancelled',
      ],
      default: 'backlog',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    priorityRank: { type: Number, default: PRIORITY_RANK.medium },
    assignedTo: { type: String, index: true },
    createdBy: { type: String, default: 'human' },
    dependsOn: { type: [Schema.Types.ObjectId], ref: 'Task', default: [] },
    acceptanceCriteria: { type: [String], default: [] },
    result: { type: String },
    artifacts: { type: [ArtifactSchema], default: [] },
    history: { type: [HistorySchema], default: [] },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 2 },
    error: { type: String },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true, collection: 'tasks' },
);

/**
 * Keep `priorityRank` consistent with `priority` no matter which write path set
 * it. Doing this in middleware rather than at each call site means a future
 * controller cannot forget and silently produce a task the scheduler misorders.
 */
TaskSchema.pre('save', function syncPriorityRank(next) {
  this.priorityRank = priorityRankOf(this.priority);
  next();
});

TaskSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function syncPriorityRank(next) {
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (!update) return next();
  const set = (update.$set ?? update) as Record<string, unknown>;
  if (typeof set.priority === 'string') {
    set.priorityRank = priorityRankOf(set.priority as TaskPriority);
    if (update.$set) update.$set = set;
    this.setUpdate(update);
  }
  return next();
});

// Scheduling: equality on project+status, then urgency, then arrival order.
TaskSchema.index({ projectId: 1, status: 1, priorityRank: -1, createdAt: 1 });
// Listing: newest first, with `_id` as a stable tiebreaker for cursor paging.
TaskSchema.index({ projectId: 1, createdAt: -1, _id: -1 });
TaskSchema.index({ workflowRunId: 1, createdAt: -1, _id: -1 });

export const TaskModel = model<ITask>('Task', TaskSchema);
