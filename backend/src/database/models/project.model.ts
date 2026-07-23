import { Schema, model, type Types } from 'mongoose';

/**
 * A Project is the platform's tenant boundary: one connected codebase.
 * `profile` is the machine-generated fingerprint produced by onboarding and is
 * injected (compactly) into every agent's system prompt so agents write code
 * that matches the stack they are actually operating on.
 */
export interface IProjectProfile {
  projectName: string;
  languages: string[];
  frameworks: string[];
  architecture: string;
  database: string;
  testingFramework: string;
  deployment: string;
  conventions: string[];
  packageManagers: string[];
  entryPoints: string[];
  buildCommand?: string;
  testCommand?: string;
  fileCount: number;
  totalBytes: number;
}

export type ProjectStatus = 'connecting' | 'analyzing' | 'ready' | 'failed';

export interface IProject {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  status: ProjectStatus;
  profile: IProjectProfile;
  repositoryId?: Types.ObjectId;
  /** Absolute path of the checked-out working copy on the platform host. */
  workspacePath?: string;
  /** Free-form operator overrides merged into every agent system prompt. */
  customInstructions?: string;
  lastAnalyzedAt?: Date;
  error?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const ProfileSchema = new Schema<IProjectProfile>(
  {
    projectName: { type: String, default: '' },
    languages: { type: [String], default: [] },
    frameworks: { type: [String], default: [] },
    architecture: { type: String, default: 'unknown' },
    database: { type: String, default: 'unknown' },
    testingFramework: { type: String, default: 'unknown' },
    deployment: { type: String, default: 'unknown' },
    conventions: { type: [String], default: [] },
    packageManagers: { type: [String], default: [] },
    entryPoints: { type: [String], default: [] },
    buildCommand: { type: String },
    testCommand: { type: String },
    fileCount: { type: Number, default: 0 },
    totalBytes: { type: Number, default: 0 },
  },
  { _id: false },
);

const ProjectSchema = new Schema<IProject>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String },
    status: {
      type: String,
      enum: ['connecting', 'analyzing', 'ready', 'failed'],
      default: 'connecting',
      index: true,
    },
    profile: { type: ProfileSchema, default: () => ({}) },
    repositoryId: { type: Schema.Types.ObjectId, ref: 'Repository', index: true },
    workspacePath: { type: String },
    customInstructions: { type: String },
    lastAnalyzedAt: { type: Date },
    error: { type: String },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'projects' },
);

ProjectSchema.index({ name: 1 }, { unique: true });

export const ProjectModel = model<IProject>('Project', ProjectSchema);
