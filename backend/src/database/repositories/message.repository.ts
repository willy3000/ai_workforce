import { Types } from 'mongoose';
import { MessageModel, type IMessage } from '../models/message.model';

export interface MessageFilter {
  projectId?: string | Types.ObjectId;
  taskId?: string | Types.ObjectId;
  workflowRunId?: string | Types.ObjectId;
  to?: string;
  from?: string;
  unreadOnly?: boolean;
}

export class MessageRepository {
  async create(data: Partial<IMessage>): Promise<IMessage> {
    const doc = await MessageModel.create(data);
    return doc.toObject<IMessage>();
  }

  async list(filter: MessageFilter = {}, limit = 100): Promise<IMessage[]> {
    const query: Record<string, unknown> = {};
    if (filter.projectId) query.projectId = filter.projectId;
    if (filter.taskId) query.taskId = filter.taskId;
    if (filter.workflowRunId) query.workflowRunId = filter.workflowRunId;
    if (filter.to) query.to = filter.to;
    if (filter.from) query.from = filter.from;
    if (filter.unreadOnly) query.readAt = { $exists: false };

    return MessageModel.find(query).sort({ createdAt: -1 }).limit(limit).lean<IMessage[]>().exec();
  }

  /** Oldest-first thread for a task — the shape agents need for context. */
  async thread(taskId: string | Types.ObjectId, limit = 50): Promise<IMessage[]> {
    return MessageModel.find({ taskId })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean<IMessage[]>()
      .exec();
  }

  async markRead(ids: (string | Types.ObjectId)[]): Promise<void> {
    if (!ids.length) return;
    await MessageModel.updateMany(
      { _id: { $in: ids } },
      { $set: { readAt: new Date() } },
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
    const result = await MessageModel.deleteMany({ projectId }).exec();
    return result.deletedCount ?? 0;
  }
}

export const messageRepository = new MessageRepository();
