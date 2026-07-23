import { Schema, model, type Types } from 'mongoose';

/**
 * A Repository is the VCS side of a Project: where the code came from, which
 * branch is checked out, and a lightweight index of its files.
 *
 * `fileIndex` is the backbone of retrieval-based context. We never ship a whole
 * repository to the model — we ship the handful of file records that matched the
 * task, and let the agent pull full contents on demand via the RepositoryReader
 * tool. Storing a per-file `summary` + `symbols` keeps that selection cheap.
 */
export interface IFileIndexEntry {
  path: string;
  extension: string;
  language: string;
  bytes: number;
  lines: number;
  /** First meaningful lines / doc comment — enough to rank relevance. */
  summary: string;
  /** Exported/declared identifiers detected by the lightweight symbol scanner. */
  symbols: string[];
  /** True for files an agent should treat as architecturally important. */
  important: boolean;
  hash: string;
}

export type RepositoryProvider = 'github' | 'local';

export interface IRepository {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  provider: RepositoryProvider;
  url: string;
  owner?: string;
  repo?: string;
  defaultBranch: string;
  currentBranch: string;
  headCommit?: string;
  clonePath: string;
  fileIndex: IFileIndexEntry[];
  indexedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const FileIndexEntrySchema = new Schema<IFileIndexEntry>(
  {
    path: { type: String, required: true },
    extension: { type: String, default: '' },
    language: { type: String, default: 'unknown' },
    bytes: { type: Number, default: 0 },
    lines: { type: Number, default: 0 },
    summary: { type: String, default: '' },
    symbols: { type: [String], default: [] },
    important: { type: Boolean, default: false },
    hash: { type: String, default: '' },
  },
  { _id: false },
);

const RepositorySchema = new Schema<IRepository>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    provider: { type: String, enum: ['github', 'local'], default: 'github' },
    url: { type: String, required: true },
    owner: { type: String },
    repo: { type: String },
    defaultBranch: { type: String, default: 'main' },
    currentBranch: { type: String, default: 'main' },
    headCommit: { type: String },
    clonePath: { type: String, required: true },
    fileIndex: { type: [FileIndexEntrySchema], default: [] },
    indexedAt: { type: Date },
  },
  { timestamps: true, collection: 'repositories' },
);

export const RepositoryModel = model<IRepository>('Repository', RepositorySchema);
