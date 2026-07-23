import { Types } from 'mongoose';
import { ProjectModel, type IProject, type ProjectStatus } from '../models/project.model';
import { NotFoundError } from '../../utils/errors';

/**
 * Repository pattern.
 *
 * Nothing outside `database/` imports a Mongoose model directly. Agents,
 * workflows and controllers depend on these narrow interfaces, which keeps the
 * ODM swappable and — more importantly — keeps query construction in one
 * reviewable place instead of scattered across the agent layer.
 */
export class ProjectRepository {
  async create(data: Partial<IProject>): Promise<IProject> {
    const doc = await ProjectModel.create(data);
    return doc.toObject<IProject>();
  }

  async findById(id: string | Types.ObjectId): Promise<IProject | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return ProjectModel.findById(id).lean<IProject>().exec();
  }

  async findByIdOrFail(id: string | Types.ObjectId): Promise<IProject> {
    const project = await this.findById(id);
    if (!project) throw new NotFoundError('Project', String(id));
    return project;
  }

  async findByName(name: string): Promise<IProject | null> {
    return ProjectModel.findOne({ name }).lean<IProject>().exec();
  }

  async list(filter: { status?: ProjectStatus } = {}, limit = 50): Promise<IProject[]> {
    return ProjectModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean<IProject[]>().exec();
  }

  async update(id: string | Types.ObjectId, patch: Partial<IProject>): Promise<IProject> {
    const doc = await ProjectModel.findByIdAndUpdate(id, patch, { new: true })
      .lean<IProject>()
      .exec();
    if (!doc) throw new NotFoundError('Project', String(id));
    return doc;
  }

  async setStatus(
    id: string | Types.ObjectId,
    status: ProjectStatus,
    error?: string,
  ): Promise<void> {
    await ProjectModel.updateOne({ _id: id }, { $set: { status, error: error ?? null } }).exec();
  }

  async delete(id: string | Types.ObjectId): Promise<void> {
    await ProjectModel.deleteOne({ _id: id }).exec();
  }
}

export const projectRepository = new ProjectRepository();
