import { Schema, model, type Types } from 'mongoose';

/**
 * Architecture Decision Records, written by agents.
 *
 * Kept separate from `knowledge` on purpose: decisions are append-only,
 * carry rationale + alternatives, and are always injected into the
 * Engineering Manager's context regardless of keyword relevance. They are the
 * project's constitution — a later agent must not silently contradict them.
 */
export interface IDecision {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  taskId?: Types.ObjectId;
  title: string;
  context: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  consequences: string[];
  status: 'proposed' | 'accepted' | 'superseded' | 'rejected';
  decidedBy: string;
  supersedes?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DecisionSchema = new Schema<IDecision>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    title: { type: String, required: true },
    context: { type: String, default: '' },
    decision: { type: String, required: true },
    rationale: { type: String, default: '' },
    alternatives: { type: [String], default: [] },
    consequences: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['proposed', 'accepted', 'superseded', 'rejected'],
      default: 'accepted',
      index: true,
    },
    decidedBy: { type: String, default: 'engineering-manager' },
    supersedes: { type: Schema.Types.ObjectId, ref: 'Decision' },
  },
  { timestamps: true, collection: 'decisions' },
);

DecisionSchema.index({ projectId: 1, createdAt: -1 });

export const DecisionModel = model<IDecision>('Decision', DecisionSchema);
