import { Types } from 'mongoose';
import {
  TaskModel,
  priorityRankOf,
  type ITask,
  type ITaskArtifact,
  type TaskStatus,
} from '../models/task.model';
import { ConflictError, NotFoundError } from '../../utils/errors';

export interface TaskListFilter {
  projectId?: string | Types.ObjectId;
  status?: TaskStatus | TaskStatus[];
  assignedTo?: string;
  workflowRunId?: string | Types.ObjectId;
}

/**
 * Which statuses a task may move to from where.
 *
 * Audit: "`runTask` can rerun cancelled/failed work without a validated
 * transition graph." Without one, a retry could resurrect a cancelled task, and
 * a stale completion could overwrite a failure — both of which produce history
 * that does not describe what happened. Encoding the graph makes an invalid
 * move a 409 instead of a silent corruption.
 */
const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['ready', 'in_progress', 'awaiting_approval', 'cancelled', 'blocked'],
  ready: ['in_progress', 'awaiting_approval', 'blocked', 'cancelled'],
  in_progress: ['done', 'failed', 'blocked', 'awaiting_review', 'awaiting_approval', 'cancelled', 'ready'],
  blocked: ['ready', 'in_progress', 'cancelled', 'failed'],
  awaiting_review: ['done', 'ready', 'in_progress', 'failed', 'cancelled'],
  awaiting_approval: ['ready', 'in_progress', 'cancelled', 'failed'],
  // Terminal states. A retry creates a new attempt on a `ready` task rather than
  // reanimating a finished one, so its history stays truthful.
  done: [],
  failed: ['ready'],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export class TaskRepository {
  async create(data: Partial<ITask>): Promise<ITask> {
    const doc = await TaskModel.create({
      ...data,
      priorityRank: priorityRankOf(data.priority),
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

  /**
   * List tasks, without the embedded arrays by default.
   *
   * Audit: "list endpoints return full task artifacts/history". A single task can
   * carry a 20 KB command-output artifact and a long history; a board of 100 was
   * shipping megabytes to render title, status and assignee. Callers that need
   * the detail ask for one task by id, where it is proportionate.
   */
  async list(
    filter: TaskListFilter = {},
    limit = 100,
    options: { includeDetail?: boolean } = {},
  ): Promise<ITask[]> {
    const query: Record<string, unknown> = {};
    if (filter.projectId) query.projectId = filter.projectId;
    if (filter.assignedTo) query.assignedTo = filter.assignedTo;
    if (filter.workflowRunId) query.workflowRunId = filter.workflowRunId;
    if (filter.status) {
      query.status = Array.isArray(filter.status) ? { $in: filter.status } : filter.status;
    }

    const cursor = TaskModel.find(query)
      // `_id` is the tiebreaker: without it, two tasks created in the same
      // millisecond can swap places between pages of an otherwise stable sort.
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(limit, 200));
    if (!options.includeDetail) cursor.select('-artifacts -history -description');

    return cursor.lean<ITask[]>().exec();
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
    if (!canTransition(current.status, to)) {
      throw new ConflictError(
        `Task ${String(id)} cannot move from '${current.status}' to '${to}'.` +
          (current.status === 'done' || current.status === 'cancelled'
            ? ' It is already finished; create a new task instead of reopening this one.'
            : ''),
      );
    }

    const patch: Record<string, unknown> = { status: to, ...extra };
    if (to === 'in_progress' && !current.startedAt) patch.startedAt = new Date();
    if (to === 'done' || to === 'failed' || to === 'cancelled') patch.completedAt = new Date();
    // Retrying clears the previous attempt's terminal residue, so a task shown as
    // `ready` never carries a stale error or completion time (audit: "retrying
    // does not reliably clear stale error/completion timestamps").
    const unset: Record<string, string> = {};
    if (to === 'ready' || to === 'in_progress') {
      if (extra.error === undefined) unset.error = '';
      unset.completedAt = '';
    }

    const doc = await TaskModel.findOneAndUpdate(
      // Compare-and-set on the status we read, so a concurrent writer that moved
      // the task in the meantime makes this update fail rather than clobber it.
      { _id: id, status: current.status },
      {
        $set: patch,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
        $push: { history: { at: new Date(), actor, from: current.status, to, note } },
      },
      { new: true },
    )
      .lean<ITask>()
      .exec();
    if (!doc) {
      throw new ConflictError(
        `Task ${String(id)} changed status concurrently while transitioning to '${to}'. Re-read and retry.`,
      );
    }
    return doc;
  }

  /**
   * Atomically take a task for execution.
   *
   * Audit finding E3: `runTask` read the task, checked `status !== 'in_progress'`
   * and *then* wrote `in_progress`. Those are three awaits apart, so two
   * concurrent callers both passed the check and both ran the same agent against
   * the same checkout. One `findOneAndUpdate` collapses read, check and write
   * into a single atomic operation, and the loser gets `null`.
   */
  async claimForExecution(
    id: string | Types.ObjectId,
    actor: string,
    from: TaskStatus[] = ['backlog', 'ready', 'blocked', 'failed'],
  ): Promise<ITask | null> {
    const now = new Date();
    return TaskModel.findOneAndUpdate(
      { _id: id, status: { $in: from } },
      {
        $set: { status: 'in_progress', startedAt: now },
        $unset: { completedAt: '', error: '' },
        $inc: { attempts: 1 },
        $push: {
          history: { at: now, actor, to: 'in_progress' as TaskStatus, note: 'Claimed for execution' },
        },
      },
      { new: true },
    )
      .lean<ITask>()
      .exec();
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

  /**
   * Tasks whose dependencies are all `done` — i.e. eligible to run now.
   *
   * Three corrections from audit finding E7:
   *
   *  1. **Sort by `priorityRank`, not `priority`.** The string sort put
   *     `medium` above `critical`.
   *  2. **One dependency query, not one per candidate.** The old loop issued a
   *     `countDocuments` per task, on every poll of the backlog.
   *  3. **A missing dependency blocks instead of counting as zero blockers.**
   *     Previously a `dependsOn` id pointing at a deleted task matched nothing,
   *     so `blocking === 0` and the task ran as if its prerequisite had
   *     succeeded. A dependency that cannot be found is unresolved, not done.
   *
   * The limit is also enforced for dependency-free candidates, which previously
   * skipped the check via `continue` and could return the whole candidate set.
   */
  async findRunnable(projectId: string | Types.ObjectId, limit = 20): Promise<ITask[]> {
    const candidates = await TaskModel.find({
      projectId,
      status: { $in: ['backlog', 'ready'] },
    })
      .sort({ priorityRank: -1, createdAt: 1 })
      .limit(Math.max(limit * 3, 30))
      .lean<ITask[]>()
      .exec();

    const dependencyIds = [
      ...new Set(candidates.flatMap((task) => task.dependsOn.map((id) => String(id)))),
    ];

    // One batched read resolves every dependency across every candidate.
    const dependencyStatuses = new Map<string, TaskStatus>();
    if (dependencyIds.length) {
      const rows = await TaskModel.find({ _id: { $in: dependencyIds } })
        .select('_id status')
        .lean<{ _id: Types.ObjectId; status: TaskStatus }[]>()
        .exec();
      for (const row of rows) dependencyStatuses.set(String(row._id), row.status);
    }

    const runnable: ITask[] = [];
    for (const task of candidates) {
      if (runnable.length >= limit) break;
      const blocked = task.dependsOn.some((dependencyId) => {
        const status = dependencyStatuses.get(String(dependencyId));
        // `undefined` — the dependency does not exist — blocks deliberately.
        return status !== 'done';
      });
      if (!blocked) runnable.push(task);
    }
    return runnable;
  }

  /** Unresolvable dependency ids on a task, for surfacing a broken plan. */
  async findMissingDependencies(task: ITask): Promise<string[]> {
    if (!task.dependsOn.length) return [];
    const found = await TaskModel.find({ _id: { $in: task.dependsOn } })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    const foundIds = new Set(found.map((row) => String(row._id)));
    return task.dependsOn.map(String).filter((id) => !foundIds.has(id));
  }

  async countByStatus(projectId: string | Types.ObjectId): Promise<Record<string, number>> {
    const rows = await TaskModel.aggregate<{ _id: string; count: number }>([
      { $match: { projectId: new Types.ObjectId(String(projectId)) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();
    return Object.fromEntries(rows.map((r) => [r._id, r.count]));
  }

  /**
   * Remove every record owned by a project.
   *
   * Part of completing project deletion (audit: "Deletion is incomplete").
   * Scoped by `projectId` alone, which is safe here only because disconnect has
   * already established the caller owns the project; when tenancy arrives this
   * filter gains a workspace equality term alongside it.
   */
  async deleteByProject(projectId: string | Types.ObjectId): Promise<number> {
    const result = await TaskModel.deleteMany({ projectId }).exec();
    return result.deletedCount ?? 0;
  }
}

export const taskRepository = new TaskRepository();
