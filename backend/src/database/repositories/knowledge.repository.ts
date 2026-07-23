import { Types } from 'mongoose';
import { KnowledgeModel, type IKnowledge, type KnowledgeKind } from '../models/knowledge.model';
import { keywordScore } from '../../utils/text';

export interface KnowledgeSearchOptions {
  projectId: string | Types.ObjectId;
  query: string;
  kinds?: KnowledgeKind[];
  paths?: string[];
  limit?: number;
}

export interface ScoredKnowledge {
  entry: IKnowledge;
  score: number;
}

/**
 * Knowledge access + ranked retrieval.
 *
 * `search()` is deliberately the only retrieval entry point. Today it is backed
 * by MongoDB's weighted text index; substituting embeddings later means
 * reimplementing this one method, with no change to agents or workflows.
 */
export class KnowledgeRepository {
  async create(data: Partial<IKnowledge>): Promise<IKnowledge> {
    const doc = await KnowledgeModel.create(data);
    return doc.toObject<IKnowledge>();
  }

  /** Upsert by (project, kind, title) so re-running onboarding does not duplicate facts. */
  async upsert(data: Partial<IKnowledge> & { projectId: Types.ObjectId; kind: KnowledgeKind; title: string }): Promise<IKnowledge> {
    const doc = await KnowledgeModel.findOneAndUpdate(
      { projectId: data.projectId, kind: data.kind, title: data.title },
      { $set: data },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )
      .lean<IKnowledge>()
      .exec();
    return doc;
  }

  async list(
    projectId: string | Types.ObjectId,
    kind?: KnowledgeKind,
    limit = 200,
  ): Promise<IKnowledge[]> {
    const query: Record<string, unknown> = { projectId, supersededBy: { $exists: false } };
    if (kind) query.kind = kind;
    return KnowledgeModel.find(query)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean<IKnowledge[]>()
      .exec();
  }

  async search(options: KnowledgeSearchOptions): Promise<ScoredKnowledge[]> {
    const { projectId, query, kinds, paths = [], limit = 8 } = options;
    const base: Record<string, unknown> = { projectId, supersededBy: { $exists: false } };
    if (kinds?.length) base.kind = { $in: kinds };

    const results = new Map<string, ScoredKnowledge>();

    // 1. Weighted text search (primary ranker).
    if (query.trim()) {
      try {
        const textHits = await KnowledgeModel.find(
          { ...base, $text: { $search: query } },
          { score: { $meta: 'textScore' } },
        )
          .sort({ score: { $meta: 'textScore' } })
          .limit(limit * 2)
          .lean<(IKnowledge & { score: number })[]>()
          .exec();

        for (const hit of textHits) {
          results.set(String(hit._id), { entry: hit, score: hit.score * hit.confidence });
        }
      } catch {
        // Text index missing (e.g. fresh DB before ensureIndexes) — fall through
        // to the keyword scorer rather than failing an agent run.
      }
    }

    // 2. Path-anchored recall: facts about files the task already mentions are
    //    relevant even when their prose shares no keywords with the request.
    if (paths.length) {
      const pathHits = await KnowledgeModel.find({ ...base, paths: { $in: paths } })
        .limit(limit)
        .lean<IKnowledge[]>()
        .exec();
      for (const hit of pathHits) {
        const key = String(hit._id);
        const existing = results.get(key);
        results.set(key, { entry: hit, score: (existing?.score ?? 0) + 5 });
      }
    }

    // 3. Fallback keyword scoring when text search produced nothing.
    if (results.size === 0 && query.trim()) {
      const all = await this.list(projectId, undefined, 300);
      const keywords = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
      for (const entry of all) {
        const score = keywordScore(`${entry.title} ${entry.content} ${entry.tags.join(' ')}`, keywords);
        if (score > 0) results.set(String(entry._id), { entry, score: score * entry.confidence });
      }
    }

    return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async supersede(id: string | Types.ObjectId, replacementId: Types.ObjectId): Promise<void> {
    await KnowledgeModel.updateOne({ _id: id }, { $set: { supersededBy: replacementId } }).exec();
  }

  async deleteByProject(projectId: string | Types.ObjectId): Promise<void> {
    await KnowledgeModel.deleteMany({ projectId }).exec();
  }

  async countByKind(projectId: string | Types.ObjectId): Promise<Record<string, number>> {
    const rows = await KnowledgeModel.aggregate<{ _id: string; count: number }>([
      { $match: { projectId: new Types.ObjectId(String(projectId)) } },
      { $group: { _id: '$kind', count: { $sum: 1 } } },
    ]).exec();
    return Object.fromEntries(rows.map((r) => [r._id, r.count]));
  }
}

export const knowledgeRepository = new KnowledgeRepository();
