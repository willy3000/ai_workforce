import { Types } from 'mongoose';
import {
  WorkflowRunModel,
  type IWorkflowRun,
  type IWorkflowStepState,
  type WorkflowRunStatus,
} from '../models/workflow-run.model';
import { NotFoundError } from '../../utils/errors';

export class WorkflowRunRepository {
  async create(data: Partial<IWorkflowRun>): Promise<IWorkflowRun> {
    const doc = await WorkflowRunModel.create(data);
    return doc.toObject<IWorkflowRun>();
  }

  async findById(id: string | Types.ObjectId): Promise<IWorkflowRun | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return WorkflowRunModel.findById(id).lean<IWorkflowRun>().exec();
  }

  async findByIdOrFail(id: string | Types.ObjectId): Promise<IWorkflowRun> {
    const run = await this.findById(id);
    if (!run) throw new NotFoundError('WorkflowRun', String(id));
    return run;
  }

  async list(projectId?: string | Types.ObjectId, limit = 50): Promise<IWorkflowRun[]> {
    const query = projectId ? { projectId } : {};
    return WorkflowRunModel.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
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
    await WorkflowRunModel.updateOne(
      { _id: runId },
      { $set: { [`context.${key}`]: value } },
    ).exec();
  }
}

export const workflowRunRepository = new WorkflowRunRepository();
