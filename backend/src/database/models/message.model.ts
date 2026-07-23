import { Schema, model, type Types } from 'mongoose';

/**
 * The inter-agent message bus, persisted.
 *
 * Design decision: agents never call each other directly. They emit messages
 * into this collection through the AgentCoordinator. That gives us three things
 * an in-memory event emitter cannot: a durable audit trail of who asked whom for
 * what, the ability to resume a workflow after a process restart, and a natural
 * place for the human operator to read (and inject) messages.
 */
export type MessageIntent =
  | 'instruction'
  | 'question'
  | 'clarification'
  | 'review_request'
  | 'review_result'
  | 'status'
  | 'completion'
  | 'handoff'
  | 'escalation';

export interface IMessage {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  taskId?: Types.ObjectId;
  workflowRunId?: Types.ObjectId;
  /** Agent key, or `human` / `orchestrator`. */
  from: string;
  to: string;
  intent: MessageIntent;
  message: string;
  payload?: Record<string, unknown>;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', index: true },
    workflowRunId: { type: Schema.Types.ObjectId, ref: 'WorkflowRun', index: true },
    from: { type: String, required: true, index: true },
    to: { type: String, required: true, index: true },
    intent: {
      type: String,
      enum: [
        'instruction', 'question', 'clarification', 'review_request',
        'review_result', 'status', 'completion', 'handoff', 'escalation',
      ],
      default: 'status',
    },
    message: { type: String, required: true },
    payload: { type: Schema.Types.Mixed },
    readAt: { type: Date },
  },
  { timestamps: true, collection: 'messages' },
);

MessageSchema.index({ projectId: 1, createdAt: -1 });
MessageSchema.index({ to: 1, readAt: 1 });

export const MessageModel = model<IMessage>('Message', MessageSchema);
