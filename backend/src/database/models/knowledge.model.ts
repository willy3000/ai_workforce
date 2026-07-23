import { Schema, model, type Types } from 'mongoose';

/**
 * Long-term project memory.
 *
 * Every entry is a small, self-contained, retrievable fact about the project.
 * Retrieval (not stuffing) is the contract: `KnowledgeRetrieval` selects the
 * top-N entries relevant to the current task and only those reach the model.
 *
 * A Mongo text index over `title`/`content`/`tags` provides ranked search with
 * no external vector store. The `KnowledgeRepository` exposes a stable
 * `search()` interface so a pgvector/embedding backend can be swapped in later
 * without touching the agents.
 */
export type KnowledgeKind =
  | 'architecture'
  | 'convention'
  | 'change'
  | 'structure'
  | 'important_file'
  | 'known_issue'
  | 'domain'
  | 'requirement';

export interface IKnowledge {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  kind: KnowledgeKind;
  title: string;
  content: string;
  tags: string[];
  /** Repo-relative paths this fact is about; used to boost path-matched recall. */
  paths: string[];
  source: string;
  taskId?: Types.ObjectId;
  /** 0..1 - lets a reviewer downrank speculative notes without deleting them. */
  confidence: number;
  supersededBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const KnowledgeSchema = new Schema<IKnowledge>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    kind: {
      type: String,
      enum: [
        'architecture', 'convention', 'change', 'structure',
        'important_file', 'known_issue', 'domain', 'requirement',
      ],
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    content: { type: String, required: true },
    tags: { type: [String], default: [], index: true },
    paths: { type: [String], default: [] },
    source: { type: String, default: 'system' },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    confidence: { type: Number, default: 0.8, min: 0, max: 1 },
    supersededBy: { type: Schema.Types.ObjectId, ref: 'Knowledge' },
  },
  { timestamps: true, collection: 'knowledge' },
);

// Weighted text index: a title match is a much stronger relevance signal than
// a passing mention in the body.
KnowledgeSchema.index(
  { title: 'text', content: 'text', tags: 'text' },
  { weights: { title: 10, tags: 5, content: 1 }, name: 'knowledge_text' },
);
KnowledgeSchema.index({ projectId: 1, kind: 1, updatedAt: -1 });

export const KnowledgeModel = model<IKnowledge>('Knowledge', KnowledgeSchema);
