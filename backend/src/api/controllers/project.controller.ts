import type { Request, Response } from 'express';
import { z } from 'zod';
import { onboardingService } from '../../services/onboarding/onboarding.service';
import { projectRepository, codeRepositoryRepository } from '../../database/repositories';
import { projectMemory } from '../../memory/project-memory';
import { agentCoordinator } from '../../orchestrator/agent-coordinator';
import { ValidationError } from '../../utils/errors';

const ConnectSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    repositoryUrl: z.string().min(3).optional(),
    localPath: z.string().min(1).optional(),
    branch: z.string().optional(),
    description: z.string().max(2000).optional(),
    customInstructions: z.string().max(20_000).optional(),
  })
  .refine((v) => v.repositoryUrl || v.localPath, {
    message: 'Either repositoryUrl or localPath is required',
  });

export const projectController = {
  /** POST /api/projects/connect — clone, analyse, profile, and seed memory. */
  async connect(req: Request, res: Response): Promise<void> {
    const input = ConnectSchema.parse(req.body);
    const project = await onboardingService.connect(input);
    res.status(201).json({ project });
  },

  async list(_req: Request, res: Response): Promise<void> {
    const projects = await projectRepository.list();
    res.json({ projects, count: projects.length });
  },

  async get(req: Request, res: Response): Promise<void> {
    const project = await projectRepository.findByIdOrFail(req.params.id!);
    const repository = await codeRepositoryRepository.findByProject(project._id);
    res.json({
      project,
      repository: repository
        ? {
            id: repository._id,
            provider: repository.provider,
            url: repository.url,
            defaultBranch: repository.defaultBranch,
            currentBranch: repository.currentBranch,
            headCommit: repository.headCommit,
            indexedFiles: repository.fileIndex.length,
            indexedAt: repository.indexedAt,
          }
        : null,
    });
  },

  /** POST /api/projects/:id/reanalyze — refresh the profile and file index. */
  async reanalyze(req: Request, res: Response): Promise<void> {
    const project = await onboardingService.reanalyze(req.params.id!);
    res.json({ project });
  },

  /** GET /api/projects/:id/memory — everything the platform knows. */
  async memory(req: Request, res: Response): Promise<void> {
    const snapshot = await projectMemory.snapshot(req.params.id!);
    res.json(snapshot);
  },

  /** GET /api/projects/:id/status — tasks, counts and recent agent chatter. */
  async status(req: Request, res: Response): Promise<void> {
    const status = await agentCoordinator.projectStatus(req.params.id!);
    res.json(status);
  },

  async updateInstructions(req: Request, res: Response): Promise<void> {
    const schema = z.object({ customInstructions: z.string().max(20_000) });
    const { customInstructions } = schema.parse(req.body);
    const project = await projectRepository.update(req.params.id!, { customInstructions });
    res.json({ project });
  },

  /** DELETE /api/projects/:id — removes workspace, memory and the record. */
  async disconnect(req: Request, res: Response): Promise<void> {
    const confirm = req.query.confirm;
    if (confirm !== 'true') {
      throw new ValidationError(
        'Disconnecting deletes the workspace and all project memory. Re-send with ?confirm=true.',
      );
    }
    await onboardingService.disconnect(req.params.id!);
    res.status(204).send();
  },
};
