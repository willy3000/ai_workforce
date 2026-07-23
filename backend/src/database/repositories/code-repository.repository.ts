import { Types } from 'mongoose';
import {
  RepositoryModel,
  type IFileIndexEntry,
  type IRepository,
} from '../models/repository.model';
import { NotFoundError } from '../../utils/errors';

/** Data access for the VCS-side record of a project (named to avoid the `Repository` clash). */
export class CodeRepositoryRepository {
  async create(data: Partial<IRepository>): Promise<IRepository> {
    const doc = await RepositoryModel.create(data);
    return doc.toObject<IRepository>();
  }

  async findById(id: string | Types.ObjectId): Promise<IRepository | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return RepositoryModel.findById(id).lean<IRepository>().exec();
  }

  async findByProject(projectId: string | Types.ObjectId): Promise<IRepository | null> {
    return RepositoryModel.findOne({ projectId }).lean<IRepository>().exec();
  }

  async findByProjectOrFail(projectId: string | Types.ObjectId): Promise<IRepository> {
    const repo = await this.findByProject(projectId);
    if (!repo) throw new NotFoundError('Repository for project', String(projectId));
    return repo;
  }

  async update(id: string | Types.ObjectId, patch: Partial<IRepository>): Promise<IRepository> {
    const doc = await RepositoryModel.findByIdAndUpdate(id, patch, { new: true })
      .lean<IRepository>()
      .exec();
    if (!doc) throw new NotFoundError('Repository', String(id));
    return doc;
  }

  async replaceFileIndex(
    id: string | Types.ObjectId,
    fileIndex: IFileIndexEntry[],
  ): Promise<void> {
    await RepositoryModel.updateOne(
      { _id: id },
      { $set: { fileIndex, indexedAt: new Date() } },
    ).exec();
  }

  /**
   * Fetch only the index (projection) — the file index can be thousands of
   * entries and is the hot path for retrieval, so we never pull the whole doc.
   */
  async getFileIndex(projectId: string | Types.ObjectId): Promise<IFileIndexEntry[]> {
    const doc = await RepositoryModel.findOne({ projectId }, { fileIndex: 1 })
      .lean<{ fileIndex: IFileIndexEntry[] }>()
      .exec();
    return doc?.fileIndex ?? [];
  }
}

export const codeRepositoryRepository = new CodeRepositoryRepository();
