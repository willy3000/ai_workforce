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
}

export const decisionRepository = new DecisionRepository();
