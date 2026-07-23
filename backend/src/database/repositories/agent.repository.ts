import { Types } from 'mongoose';
import { AgentModel, type IAgent } from '../models/agent.model';

export class AgentRepository {
  /** Mirror a code-defined agent into the DB so operators can list/tune it. */
  async upsertGlobal(data: Partial<IAgent> & { key: string }): Promise<IAgent> {
    const doc = await AgentModel.findOneAndUpdate(
      { key: data.key, projectId: null },
      { $set: { ...data, projectId: null } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )
      .lean<IAgent>()
      .exec();
    return doc;
  }

  async list(projectId?: string | Types.ObjectId): Promise<IAgent[]> {
    const query = projectId ? { $or: [{ projectId: null }, { projectId }] } : { projectId: null };
    return AgentModel.find(query).sort({ key: 1 }).lean<IAgent[]>().exec();
  }

  /** Project-scoped override wins over the global entry when present. */
  async findEffective(key: string, projectId?: string | Types.ObjectId): Promise<IAgent | null> {
    if (projectId) {
      const override = await AgentModel.findOne({ key, projectId }).lean<IAgent>().exec();
      if (override) return override;
    }
    return AgentModel.findOne({ key, projectId: null }).lean<IAgent>().exec();
  }

  async recordRun(
    key: string,
    usage: { inputTokens: number; outputTokens: number; toolCalls: number },
  ): Promise<void> {
    await AgentModel.updateOne(
      { key, projectId: null },
      {
        $inc: {
          'stats.runs': 1,
          'stats.toolCalls': usage.toolCalls,
          'stats.inputTokens': usage.inputTokens,
          'stats.outputTokens': usage.outputTokens,
        },
      },
    ).exec();
  }
}

export const agentRepository = new AgentRepository();
