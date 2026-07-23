import fs from 'node:fs/promises';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { AppError, ConflictError, ValidationError } from '../../utils/errors';
import { Workspace } from '../../integrations/filesystem/workspace';
import { GitManager } from '../../integrations/github/git-manager';
import { GitHubClient, githubClient } from '../../integrations/github/github-client';
import {
  codeRepositoryRepository,
  projectRepository,
} from '../../database/repositories';
import type { IProject, IProjectProfile } from '../../database/models/project.model';
import { projectMemory } from '../../memory/project-memory';
import { detectStack } from './detectors';
import { FileIndexer, directoryOverview, importantFilesFor } from './file-indexer';
import { knowledgeRepository } from '../../database/repositories';

/**
 * Project onboarding: connect any repository, in any language, and produce the
 * profile + memory that every agent runs against.
 *
 * Pipeline:
 *   1. Resolve the source (GitHub URL, or a local path for air-gapped use).
 *   2. Clone/attach into a per-project workspace directory.
 *   3. Walk + index the tree (paths, summaries, symbols).
 *   4. Run detection over the index and the manifests.
 *   5. Persist the profile, the file index, and seed long-term memory.
 *
 * Steps 3–5 are re-runnable (`reanalyze`) without a re-clone, which is what you
 * want after the platform's own agents have changed the codebase.
 */
export interface ConnectProjectInput {
  name?: string;
  repositoryUrl?: string;
  localPath?: string;
  branch?: string;
  description?: string;
  customInstructions?: string;
}

export class OnboardingService {
  async connect(input: ConnectProjectInput): Promise<IProject> {
    if (!input.repositoryUrl && !input.localPath) {
      throw new ValidationError('Provide either repositoryUrl or localPath');
    }

    const name = input.name ?? this.deriveName(input);
    if (await projectRepository.findByName(name)) {
      throw new ConflictError(
        `A project named '${name}' already exists. Delete it or choose a different name.`,
      );
    }

    await Workspace.ensureRoot();

    const project = await projectRepository.create({
      name,
      description: input.description,
      customInstructions: input.customInstructions,
      status: 'connecting',
      profile: { projectName: name } as IProjectProfile,
    });

    try {
      const workspacePath = Workspace.pathForProject(project._id.toString());
      const { provider, url, defaultBranch, currentBranch, headCommit } =
        await this.materialize(input, workspacePath);

      const repository = await codeRepositoryRepository.create({
        projectId: project._id,
        provider,
        url,
        owner: provider === 'github' ? GitHubClient.parseUrl(url).owner : undefined,
        repo: provider === 'github' ? GitHubClient.parseUrl(url).repo : undefined,
        defaultBranch,
        currentBranch,
        headCommit,
        clonePath: workspacePath,
      });

      await projectRepository.update(project._id, {
        repositoryId: repository._id,
        workspacePath,
        status: 'analyzing',
      });

      const analyzed = await this.analyze(project._id, workspacePath);
      logger.info(
        { projectId: project._id.toString(), name, files: analyzed.profile.fileCount },
        'Project onboarded',
      );
      return analyzed;
    } catch (err) {
      await projectRepository.setStatus(project._id, 'failed', (err as Error).message);
      throw err;
    }
  }

  /** Re-index an already-connected project (after agents changed it, or on demand). */
  async reanalyze(projectId: string | Types.ObjectId): Promise<IProject> {
    const project = await projectRepository.findByIdOrFail(projectId);
    if (!project.workspacePath) {
      throw new AppError('Project has no workspace to analyse', 409, 'workspace_missing');
    }
    await projectRepository.setStatus(project._id, 'analyzing');
    return this.analyze(project._id, project.workspacePath);
  }

  /** Steps 3–5 of the pipeline. */
  private async analyze(projectId: Types.ObjectId, workspacePath: string): Promise<IProject> {
    const workspace = new Workspace(workspacePath);
    const indexer = new FileIndexer(workspace);

    const { entries, extensionCounts, manifests, totalBytes } = await indexer.build();
    const paths = entries.map((e) => e.path);

    const detected = detectStack({ paths, manifests, extensionCounts });
    const project = await projectRepository.findByIdOrFail(projectId);

    const profile: IProjectProfile = {
      projectName: project.name,
      languages: detected.languages,
      frameworks: detected.frameworks,
      architecture: detected.architecture,
      database: detected.database,
      testingFramework: detected.testingFramework,
      deployment: detected.deployment,
      conventions: detected.conventions,
      packageManagers: detected.packageManagers,
      entryPoints: detected.entryPoints,
      buildCommand: detected.buildCommand,
      testCommand: detected.testCommand,
      fileCount: entries.length,
      totalBytes,
    };

    const repository = await codeRepositoryRepository.findByProject(projectId);
    if (repository) await codeRepositoryRepository.replaceFileIndex(repository._id, entries);

    // Seed long-term memory so the very first agent run already has context.
    await projectMemory.seedFromProfile(projectId, profile, importantFilesFor(entries));
    await knowledgeRepository.upsert({
      projectId,
      kind: 'structure',
      title: 'Directory layout',
      content: `File counts by top-level directory:\n${directoryOverview(entries)}`,
      tags: ['structure', 'layout'],
      source: 'onboarding',
      confidence: 0.9,
    });

    return projectRepository.update(projectId, {
      profile,
      status: 'ready',
      lastAnalyzedAt: new Date(),
      error: undefined,
    });
  }

  /** Step 2: get the code onto disk. */
  private async materialize(
    input: ConnectProjectInput,
    workspacePath: string,
  ): Promise<{
    provider: 'github' | 'local';
    url: string;
    defaultBranch: string;
    currentBranch: string;
    headCommit?: string;
  }> {
    if (input.localPath) {
      // Local mode: no clone, no token, useful for air-gapped evaluation.
      const stat = await fs.stat(input.localPath).catch(() => null);
      if (!stat?.isDirectory()) {
        throw new ValidationError(`localPath '${input.localPath}' is not a directory`);
      }
      await fs.cp(input.localPath, workspacePath, { recursive: true, force: true });

      let branch = 'main';
      let head: string | undefined;
      try {
        const git = new GitManager(workspacePath);
        branch = await git.currentBranch();
        head = await git.headCommit();
      } catch {
        // Not a git repository — still perfectly usable, just no VCS features.
      }
      return { provider: 'local', url: input.localPath, defaultBranch: branch, currentBranch: branch, headCommit: head };
    }

    const url = input.repositoryUrl!;
    const coords = GitHubClient.parseUrl(url);
    let defaultBranch = input.branch ?? 'main';

    if (githubClient.isConfigured) {
      const meta = await githubClient.getRepository(coords);
      defaultBranch = input.branch ?? meta.defaultBranch;
    }

    const git = await GitManager.clone({
      url,
      destination: workspacePath,
      branch: input.branch ?? defaultBranch,
      token: env.GITHUB_TOKEN || undefined,
    });

    return {
      provider: 'github',
      url,
      defaultBranch,
      currentBranch: await git.currentBranch(),
      headCommit: await git.headCommit(),
    };
  }

  private deriveName(input: ConnectProjectInput): string {
    if (input.repositoryUrl) {
      const { owner, repo } = GitHubClient.parseUrl(input.repositoryUrl);
      return `${owner}/${repo}`;
    }
    return input.localPath!.split(/[/\\]/).filter(Boolean).pop() ?? 'project';
  }

  /** Remove a project, its memory, and its workspace. */
  async disconnect(projectId: string | Types.ObjectId): Promise<void> {
    const project = await projectRepository.findByIdOrFail(projectId);
    if (project.workspacePath) {
      await fs.rm(project.workspacePath, { recursive: true, force: true });
    }
    await knowledgeRepository.deleteByProject(project._id);
    await projectRepository.delete(project._id);
    logger.info({ projectId: String(projectId) }, 'Project disconnected');
  }
}

export const onboardingService = new OnboardingService();
