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

TaskSchema.index({ projectId: 1, status: 1, priority: 1 });
TaskSchema.index({ projectId: 1, createdAt: -1 });

export const TaskModel = model<ITask>('Task', TaskSchema);
