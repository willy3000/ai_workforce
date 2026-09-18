import { Types } from 'mongoose';
import {
  WorkflowRunModel,
  type IChangeSet,
  type IWorkflowRun,
  type IWorkflowStepState,
  type WorkflowRunStatus,
} from '../models/workflow-run.model';
import { env } from '../../config/env';
import { NotFoundError } from '../../utils/errors';
import { normalizeWorkflowContext } from '../../workflows/types';

/** Statuses from which a worker may take ownership of a run. */
const CLAIMABLE_STATUSES: WorkflowRunStatus[] = ['pending', 'queued', 'interrupted'];

/** Statuses that assert nothing is executing and must never be overwritten. */
const TERMINAL_STATUSES: WorkflowRunStatus[] = ['completed', 'failed', 'cancelled'];

export class WorkflowRunRepository {
  async create(data: Partial<IWorkflowRun>): Promise<IWorkflowRun> {
    const doc = await WorkflowRunModel.create(data);
    return doc.toObject<IWorkflowRun>();
  }

  async findById(id: string | Types.ObjectId): Promise<IWorkflowRun | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const run = await WorkflowRunModel.findById(id).lean<IWorkflowRun>().exec();
    if (!run) return null;
    return { ...run, context: normalizeWorkflowContext(run.context) };
  }

  async findByIdOrFail(id: string | Types.ObjectId): Promise<IWorkflowRun> {
    const run = await this.findById(id);
    if (!run) throw new NotFoundError('WorkflowRun', String(id));
    return run;
  }

  /**
   * List runs without their bulky embedded fields.
   *
   * Audit: "list endpoints return full run context/outputs". A run's step
   * outputs are up to 20 KB each and its context up to 12 KB per step; a list of
   * 50 runs was returning megabytes to render a table of names and statuses.
   */
  async list(projectId?: string | Types.ObjectId, limit = 50): Promise<IWorkflowRun[]> {
    const query = projectId ? { projectId } : {};
    return WorkflowRunModel.find(query)
      .select('-context -steps.output -changeSet.commits -changeSet.checks')
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(limit, 200))
      .lean<IWorkflowRun[]>()
      .exec();
  }

  async setStatus(
    id: string | Types.ObjectId,
    status: WorkflowRunStatus,
    patch: Partial<IWorkflowRun> = {},
  ): Promise<void> {
    await WorkflowRunModel.updateOne({ _id: id }, { $set: { status, ...patch } }).exec();
  }

  /**
   * Set a status only if the run has not already reached a terminal one.
   *
   * This is the write that fixes the visible half of audit finding E1: a
   * cancelled run's own in-flight step would finish and call
   * `setStatus('completed')`, so the operator watched "cancelled" flip back to
   * "completed". A conditional update makes the terminal state stick, and the
   * boolean return tells the caller its write lost.
   */
  async setStatusIfNotTerminal(
    id: string | Types.ObjectId,
    status: WorkflowRunStatus,
    patch: Partial<IWorkflowRun> = {},
  ): Promise<boolean> {
    const result = await WorkflowRunModel.updateOne(
      { _id: id, status: { $nin: TERMINAL_STATUSES } },
      { $set: { status, ...patch } },
    ).exec();
    return result.modifiedCount > 0;
  }

  /**
   * Atomically take ownership of a run.
   *
   * Audit finding E3: `resume` had no claim at all, so two concurrent resume
   * requests — an impatient operator clicking twice, or a retry after a slow
   * response — both executed the same run against the same checkout. A
   * compare-and-set on status plus lease makes exactly one caller win.
   *
   * A run whose lease has expired is claimable again: that is how a run orphaned
   * by a crashed process is recovered (E4) without an operator intervening.
   */
  async claimForExecution(
    id: string | Types.ObjectId,
    owner: string,
    leaseMs = env.RUN_LEASE_TIMEOUT_MS,
  ): Promise<IWorkflowRun | null> {
    const now = new Date();
    const doc = await WorkflowRunModel.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { status: { $in: CLAIMABLE_STATUSES } },
          // A `running` run whose owner stopped refreshing the lease is dead.
          { status: { $in: ['running', 'awaiting_approval'] }, leaseExpiresAt: { $lt: now } },
          { status: { $in: ['running', 'awaiting_approval'] }, leaseExpiresAt: { $exists: false } },
        ],
      },
      {
        $set: {
          status: 'running',
          leaseOwner: owner,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          startedAt: now,
        },
      },
      { new: true },
    )
      .lean<IWorkflowRun>()
      .exec();
    return doc;
  }

  /** Extend the lease while work continues; false means ownership was lost. */
  async renewLease(
    id: string | Types.ObjectId,
    owner: string,
    leaseMs = env.RUN_LEASE_TIMEOUT_MS,
  ): Promise<boolean> {
    const result = await WorkflowRunModel.updateOne(
      { _id: id, leaseOwner: owner },
      { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs) } },
    ).exec();
    return result.matchedCount > 0;
  }

  /** Release ownership without changing the run's status. */
  async releaseLease(id: string | Types.ObjectId, owner: string): Promise<void> {
    await WorkflowRunModel.updateOne(
      { _id: id, leaseOwner: owner },
      { $unset: { leaseOwner: '', leaseExpiresAt: '' } },
    ).exec();
  }

  /**
   * Record an operator's intent to stop a run.
   *
   * Written before any attempt to signal the worker, so the intent survives the
   * worker being in another process or the API restarting mid-request. The
   * worker observes `cancelling` at its next checkpoint and confirms the stop.
   */
  async requestCancellation(
    id: string | Types.ObjectId,
    requestedBy: string,
    reason: string,
  ): Promise<IWorkflowRun | null> {
    return WorkflowRunModel.findOneAndUpdate(
      { _id: id, status: { $nin: TERMINAL_STATUSES } },
      {
        $set: {
          status: 'cancelling',
          cancelRequestedAt: new Date(),
          cancelRequestedBy: requestedBy,
          error: reason,
        },
      },
      { new: true },
    )
      .lean<IWorkflowRun>()
      .exec();
  }

  /** Has an operator asked this run to stop? Cheap enough to poll per step. */
  async isCancellationRequested(id: string | Types.ObjectId): Promise<boolean> {
    const doc = await WorkflowRunModel.findById(id)
      .select('status cancelRequestedAt')
      .lean<{ status: WorkflowRunStatus; cancelRequestedAt?: Date }>()
      .exec();
    if (!doc) return false;
    return doc.status === 'cancelling' || doc.status === 'cancelled' || Boolean(doc.cancelRequestedAt);
  }

  /** Runs whose owning process died: `running` with an expired or absent lease. */
  async findOrphaned(olderThan = new Date()): Promise<IWorkflowRun[]> {
    return WorkflowRunModel.find({
      status: { $in: ['queued', 'running', 'cancelling'] },
      $or: [{ leaseExpiresAt: { $lt: olderThan } }, { leaseExpiresAt: { $exists: false } }],
    })
      .select('_id projectId workflow status leaseOwner leaseExpiresAt')
      .limit(200)
      .lean<IWorkflowRun[]>()
      .exec();
  }

  /** Positional update of one step's state — steps are addressed by their stable `id`. */
  async updateStep(
    runId: string | Types.ObjectId,
    stepId: string,
    patch: Partial<IWorkflowStepState>,
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) set[`steps.$[s].${key}`] = value;
    await WorkflowRunModel.updateOne(
      { _id: runId },
      { $set: set },
      { arrayFilters: [{ 's.id': stepId }] },
    ).exec();
  }

  async setContextValue(
    runId: string | Types.ObjectId,
    key: string,
    value: string,
  ): Promise<void> {
    const run = await this.findByIdOrFail(runId);
    const context = { ...normalizeWorkflowContext(run.context), [key]: value };
    await WorkflowRunModel.updateOne(
      { _id: runId },
      { $set: { context } },
    ).exec();
  }

  /**
   * Accumulate provider usage as it is spent.
   *
   * Audit: "thrown mid-run failures lose accumulated usage from durable
   * accounting" — usage was summed in memory and written once at the end, so a
   * run that crashed after spending real money recorded nothing. `$inc` after
   * every step means the ledger only ever undercounts by the last step.
   */
  async addUsage(
    runId: string | Types.ObjectId,
    usage: { inputTokens: number; outputTokens: number; toolCalls: number },
  ): Promise<void> {
    await WorkflowRunModel.updateOne(
      { _id: runId },
      {
        $inc: {
          'usage.inputTokens': usage.inputTokens,
          'usage.outputTokens': usage.outputTokens,
          'usage.toolCalls': usage.toolCalls,
        },
      },
    ).exec();
  }

  /** Merge fields into the run's change set without clobbering sibling fields. */
  async patchChangeSet(
    runId: string | Types.ObjectId,
    patch: Partial<IChangeSet>,
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) set[`changeSet.${key}`] = value;
    }
    if (!Object.keys(set).length) return;
    await WorkflowRunModel.updateOne({ _id: runId }, { $set: set }).exec();
  }

  /** Append to a change-set array, deduplicating paths. */
  async recordChangedPaths(runId: string | Types.ObjectId, paths: string[]): Promise<void> {
    if (!paths.length) return;
    await WorkflowRunModel.updateOne(
      { _id: runId },
      { $addToSet: { 'changeSet.changedPaths': { $each: paths } } },
    ).exec();
  }

  async recordCommit(
    runId: string | Types.ObjectId,
    commit: { hash: string; message: string },
  ): Promise<void> {
    await WorkflowRunModel.updateOne(
      { _id: runId },
      {
        $push: { 'changeSet.commits': { ...commit, at: new Date() } },
        $set: { 'changeSet.headCommit': commit.hash },
      },
    ).exec();
  }

  async recordCheck(
    runId: string | Types.ObjectId,
    check: { command: string; exitCode: number | null; passed: boolean },
  ): Promise<void> {
    await WorkflowRunModel.updateOne(
      { _id: runId },
      { $push: { 'changeSet.checks': { ...check, at: new Date() } } },
    ).exec();
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
    const result = await WorkflowRunModel.deleteMany({ projectId }).exec();
    return result.deletedCount ?? 0;
  }
}

export const workflowRunRepository = new WorkflowRunRepository();
