import { Types } from 'mongoose';
import { DecisionModel, type IDecision } from '../models/decision.model';

export class DecisionRepository {
  async create(data: Partial<IDecision>): Promise<IDecision> {
    const doc = await DecisionModel.create(data);
    return doc.toObject<IDecision>();
  }

  async list(projectId: string | Types.ObjectId, limit = 50): Promise<IDecision[]> {
    return DecisionModel.find({ projectId, status: { $in: ['accepted', 'proposed'] } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<IDecision[]>()
      .exec();
  }

  async findById(id: string | Types.ObjectId): Promise<IDecision | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return DecisionModel.findById(id).lean<IDecision>().exec();
  }

  /** Recording a new decision that replaces an old one marks the old superseded. */
  async supersede(oldId: Types.ObjectId, newId: Types.ObjectId): Promise<void> {
    await DecisionModel.updateOne({ _id: oldId }, { $set: { status: 'superseded' } }).exec();
    await DecisionModel.updateOne({ _id: newId }, { $set: { supersedes: oldId } }).exec();
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
    const result = await DecisionModel.deleteMany({ projectId }).exec();
    return result.deletedCount ?? 0;
  }
}

export const decisionRepository = new DecisionRepository();
