import { Types } from 'mongoose';
import {
  TaskModel,
  type ITask,
  type ITaskArtifact,
  type TaskStatus,
} from '../models/task.model';
import { NotFoundError } from '../../utils/errors';

export interface TaskListFilter {
  projectId?: string | Types.ObjectId;
  status?: TaskStatus | TaskStatus[];
  assignedTo?: string;
  workflowRunId?: string | Types.ObjectId;
}

export class TaskRepository {
  async create(data: Partial<ITask>): Promise<ITask> {
    const doc = await TaskModel.create({
      ...data,
      history: [
        {
          at: new Date(),
          actor: data.createdBy ?? 'system',
          to: data.status ?? 'backlog',
          note: 'Task created',
        },
      ],
    });
    return doc.toObject<ITask>();
  }

  async findById(id: string | Types.ObjectId): Promise<ITask | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return TaskModel.findById(id).lean<ITask>().exec();
  }

  async findByIdOrFail(id: string | Types.ObjectId): Promise<ITask> {
    const task = await this.findById(id);
    if (!task) throw new NotFoundError('Task', String(id));
    return task;
  }

  async list(filter: TaskListFilter = {}, limit = 100): Promise<ITask[]> {
    const query: Record<string, unknown> = {};
    if (filter.projectId) query.projectId = filter.projectId;
    if (filter.assignedTo) query.assignedTo = filter.assignedTo;
    if (filter.workflowRunId) query.workflowRunId = filter.workflowRunId;
    if (filter.status) {
      query.status = Array.isArray(filter.status) ? { $in: filter.status } : filter.status;
    }
    return TaskModel.find(query).sort({ createdAt: -1 }).limit(limit).lean<ITask[]>().exec();
  }

  /**
   * Status transitions always append to `history`. The audit trail is what makes
   * an autonomous system debuggable after the fact — never mutate status alone.
   */
  async transition(
    id: string | Types.ObjectId,
    to: TaskStatus,
    actor: string,
    note = '',
    extra: Partial<ITask> = {},
  ): Promise<ITask> {
    const current = await this.findByIdOrFail(id);
    const patch: Record<string, unknown> = { status: to, ...extra };
    if (to === 'in_progress' && !current.startedAt) patch.startedAt = new Date();
    if (to === 'done' || to === 'failed' || to === 'cancelled') patch.completedAt = new Date();

    const doc = await TaskModel.findByIdAndUpdate(
      id,
      {
        $set: patch,
        $push: { history: { at: new Date(), actor, from: current.status, to, note } },
      },
      { new: true },
    )
      .lean<ITask>()
      .exec();
    if (!doc) throw new NotFoundError('Task', String(id));
    return doc;
  }

  async assign(id: string | Types.ObjectId, agentKey: string, actor: string): Promise<ITask> {
    const doc = await TaskModel.findByIdAndUpdate(
      id,
      {
        $set: { assignedTo: agentKey },
        $push: {
          history: { at: new Date(), actor, note: `Assigned to ${agentKey}` },
        },
      },
      { new: true },
    )
      .lean<ITask>()
      .exec();
    if (!doc) throw new NotFoundError('Task', String(id));
    return doc;
  }

  async addArtifact(id: string | Types.ObjectId, artifact: ITaskArtifact): Promise<void> {
    await TaskModel.updateOne({ _id: id }, { $push: { artifacts: artifact } }).exec();
  }

  async incrementAttempts(id: string | Types.ObjectId): Promise<number> {
    const doc = await TaskModel.findByIdAndUpdate(
      id,
      { $inc: { attempts: 1 } },
      { new: true, projection: { attempts: 1 } },
    )
      .lean<{ attempts: number }>()
      .exec();
    return doc?.attempts ?? 0;
  }

  /** Tasks whose dependencies are all `done` — i.e. eligible to run now. */
  async findRunnable(projectId: string | Types.ObjectId, limit = 20): Promise<ITask[]> {
    const candidates = await TaskModel.find({
      projectId,
      status: { $in: ['backlog', 'ready'] },
    })
      .sort({ priority: -1, createdAt: 1 })
      .limit(limit * 3)
      .lean<ITask[]>()
      .exec();

    const runnable: ITask[] = [];
    for (const task of candidates) {
      if (!task.dependsOn.length) {
        runnable.push(task);
        continue;
      }
      const blocking = await TaskModel.countDocuments({
        _id: { $in: task.dependsOn },
        status: { $ne: 'done' },
      }).exec();
      if (blocking === 0) runnable.push(task);
      if (runnable.length >= limit) break;
    }
    return runnable;
  }

  async countByStatus(projectId: string | Types.ObjectId): Promise<Record<string, number>> {
    const rows = await TaskModel.aggregate<{ _id: string; count: number }>([
      { $match: { projectId: new Types.ObjectId(String(projectId)) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();
    return Object.fromEntries(rows.map((r) => [r._id, r.count]));
  }
}

export const taskRepository = new TaskRepository();
