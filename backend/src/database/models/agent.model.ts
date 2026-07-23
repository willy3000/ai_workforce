import { Schema, model, type Types } from 'mongoose';

/**
 * Persisted agent records.
 *
 * Design decision: agent *definitions* live in code (`src/agents/definitions`),
 * not in the database. Prompts and permissions are behaviour — they belong in
 * version control and code review, not in a mutable row.
 *
 * This collection stores (a) an operator-visible mirror of the built-in roster
 * so `GET /agents` works without loading the code registry, and (b) optional
 * per-project overrides (model choice, extra instructions, disabled tools) that
 * an operator can tune at runtime.
 */
export interface IAgentPermissions {
  readPaths: string[];
  writePaths: string[];
  denyPaths: string[];
  allowTerminal: boolean;
  allowedCommands: string[];
  allowGitWrite: boolean;
  requiresHumanApproval: boolean;
  maxToolCalls: number;
}

export interface IAgent {
  _id: Types.ObjectId;
  key: string;
  name: string;
  role: string;
  description: string;
  capabilities: string[];
  tools: string[];
  permissions: IAgentPermissions;
  model?: string;
  effort?: string;
  /** Null for the global roster entry; set for a project-specific override. */
  projectId?: Types.ObjectId;
  extraInstructions?: string;
  enabled: boolean;
  stats: { runs: number; toolCalls: number; inputTokens: number; outputTokens: number };
  createdAt: Date;
  updatedAt: Date;
}

const PermissionsSchema = new Schema<IAgentPermissions>(
  {
    readPaths: { type: [String], default: ['**'] },
    writePaths: { type: [String], default: [] },
    denyPaths: { type: [String], default: [] },
    allowTerminal: { type: Boolean, default: false },
    allowedCommands: { type: [String], default: [] },
    allowGitWrite: { type: Boolean, default: false },
    requiresHumanApproval: { type: Boolean, default: false },
    maxToolCalls: { type: Number, default: 40 },
  },
  { _id: false },
);

const AgentSchema = new Schema<IAgent>(
  {
    key: { type: String, required: true, index: true },
    name: { type: String, required: true },
    role: { type: String, required: true },
    description: { type: String, default: '' },
    capabilities: { type: [String], default: [] },
    tools: { type: [String], default: [] },
    permissions: { type: PermissionsSchema, default: () => ({}) },
    model: { type: String },
    effort: { type: String },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
    extraInstructions: { type: String },
    enabled: { type: Boolean, default: true },
    stats: {
      runs: { type: Number, default: 0 },
      toolCalls: { type: Number, default: 0 },
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
    },
  },
  { timestamps: true, collection: 'agents' },
);

AgentSchema.index({ key: 1, projectId: 1 }, { unique: true });

export const AgentModel = model<IAgent>('Agent', AgentSchema);
