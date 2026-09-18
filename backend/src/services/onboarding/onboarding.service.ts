import fs from 'node:fs/promises';
import path from 'node:path';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { isInside } from '../../utils/path-safety';
import { AppError, ConflictError, ValidationError, toErrorMessage } from '../../utils/errors';
import { Workspace } from '../../integrations/filesystem/workspace';
import { GitManager } from '../../integrations/github/git-manager';
import { GitHubClient, githubClient } from '../../integrations/github/github-client';
import {
  codeRepositoryRepository,
  decisionRepository,
  messageRepository,
  projectRepository,
  taskRepository,
  workflowRunRepository,
} from '../../database/repositories';
import { workflowEngine } from '../../workflows/engine';
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

  /**
   * Re-index an already-connected project (after agents changed it, or on demand).
   *
   * Audit: "Reanalysis sets `analyzing` without its own failure transition; a
   * failed reanalysis can leave that state indefinitely." A project stuck in
   * `analyzing` cannot start a run — `start()` requires `ready` — so a single
   * transient indexing error bricked the project with no way back through the
   * UI. The failure path now restores a usable status and records why.
   */
  async reanalyze(projectId: string | Types.ObjectId): Promise<IProject> {
    const project = await projectRepository.findByIdOrFail(projectId);
    if (!project.workspacePath) {
      throw new AppError('Project has no workspace to analyse', 409, 'workspace_missing');
    }

    const previousStatus = project.status;
    await projectRepository.setStatus(project._id, 'analyzing');
    try {
      return await this.analyze(project._id, project.workspacePath);
    } catch (err) {
      const message = toErrorMessage(err);
      logger.error({ err, projectId: String(project._id) }, 'Reanalysis failed');
      // Return to `ready` when the project was usable before: the existing index
      // is stale, not gone, which is strictly better than an unusable project.
      await projectRepository.setStatus(
        project._id,
        previousStatus === 'ready' ? 'ready' : 'failed',
        `Reanalysis failed: ${message}`,
      );
      throw err;
    }
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
      const source = await this.resolveLocalImport(input.localPath);
      await fs.cp(source, workspacePath, { recursive: true, force: true });

      let branch = 'main';
      let head: string | undefined;
      try {
        const git = new GitManager(workspacePath);
        branch = await git.currentBranch();
        head = await git.headCommit();
      } catch {
        // Not a git repository — still perfectly usable, just no VCS features.
      }
      return { provider: 'local', url: source, defaultBranch: branch, currentBranch: branch, headCommit: head };
    }

    // Resolve through the host allowlist and clone the *rebuilt* URL, never the
    // caller's string — the token travels with it (audit finding S6).
    const resolved = GitHubClient.resolve(input.repositoryUrl!);
    let defaultBranch = input.branch ?? 'main';

    if (githubClient.isConfigured) {
      const meta = await githubClient.getRepository(resolved);
      defaultBranch = input.branch ?? meta.defaultBranch;
      // GitHub reports size in KiB. Refusing up front beats discovering the
      // problem after filling the disk and half-building a 16 MiB index.
      const bytes = meta.size * 1024;
      if (bytes > env.MAX_REPOSITORY_BYTES) {
        throw new ValidationError(
          `Repository ${resolved.owner}/${resolved.repo} is roughly ${Math.round(bytes / 1_048_576)} MB, ` +
            `over the ${Math.round(env.MAX_REPOSITORY_BYTES / 1_048_576)} MB import limit.`,
        );
      }
    }

    const git = await GitManager.clone({
      url: resolved.url,
      destination: workspacePath,
      branch: input.branch ?? defaultBranch,
      token: env.GITHUB_TOKEN || undefined,
    });

    return {
      provider: 'github',
      url: resolved.url,
      defaultBranch,
      currentBranch: await git.currentBranch(),
      headCommit: await git.headCommit(),
    };
  }

  /**
   * Validate a server-local import path.
   *
   * Audit finding S6: `localPath` accepted any directory on the server, so a
   * caller could copy `/etc`, a sibling customer's checkout, or the platform's
   * own source — including its `.env` — into a workspace agents can read. Two
   * controls: the feature can be switched off entirely for hosted deployments,
   * and when on it can be confined to explicit roots.
   */
  private async resolveLocalImport(requested: string): Promise<string> {
    if (!env.ALLOW_LOCAL_PATH_IMPORT) {
      throw new ValidationError(
        'Importing from a server-local directory is disabled on this deployment. ' +
          'Connect a repository by URL instead.',
      );
    }

    const resolved = path.resolve(requested);
    if (env.LOCAL_IMPORT_ROOTS.length) {
      const permitted = env.LOCAL_IMPORT_ROOTS.some((root) => isInside(path.resolve(root), resolved));
      if (!permitted) {
        throw new ValidationError(
          `'${requested}' is outside the directories this deployment allows importing from.`,
        );
      }
    }
    // Never let an import target the platform's own workspace tree: copying a
    // workspace into a workspace is either a loop or a cross-project leak.
    if (isInside(env.WORKSPACE_ROOT_ABS, resolved)) {
      throw new ValidationError('Cannot import a directory inside the platform workspace root.');
    }

    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new ValidationError(`localPath '${requested}' is not a directory`);
    }
    return resolved;
  }

  private deriveName(input: ConnectProjectInput): string {
    if (input.repositoryUrl) {
      const { owner, repo } = GitHubClient.parseUrl(input.repositoryUrl);
      return `${owner}/${repo}`;
    }
    return input.localPath!.split(/[/\\]/).filter(Boolean).pop() ?? 'project';
  }

  /**
   * Remove a project and everything that belongs to it.
   *
   * Audit: "Deletion is incomplete: disconnect removes checkout, knowledge and
   * project but leaves repositories, tasks, runs, messages and decisions. It
   * does not stop active work." Orphaned rows accumulated forever, still
   * referencing a project id that no longer resolved, and an in-flight run kept
   * writing to a checkout being deleted underneath it.
   *
   * Order matters: stop work, then delete data, then remove the checkout. Doing
   * the checkout last means a crash partway through leaves files on disk (easy
   * to reclaim) rather than a live run writing into a half-deleted tree.
   */
  async disconnect(projectId: string | Types.ObjectId): Promise<{ stoppedRuns: number }> {
    const project = await projectRepository.findByIdOrFail(projectId);
    const id = project._id;

    // 1. Stop anything executing against this project before removing its data.
    const activeRuns = await workflowRunRepository.list(id, 200);
    const inFlight = activeRuns.filter((run) =>
      ['queued', 'running', 'awaiting_approval', 'cancelling'].includes(run.status),
    );
    for (const run of inFlight) {
      await workflowEngine
        .cancel(run._id, 'Project disconnected', 'system')
        .catch((err) => logger.warn({ err, runId: String(run._id) }, 'Could not cancel run during disconnect'));
    }

    // 2. Delete owned records. Each repository knows its own collection, so the
    //    set of things that must be cleaned is visible in one place here rather
    //    than implied across eight modules.
    await Promise.all([
      knowledgeRepository.deleteByProject(id),
      decisionRepository.deleteByProject(id),
      taskRepository.deleteByProject(id),
      messageRepository.deleteByProject(id),
      workflowRunRepository.deleteByProject(id),
      codeRepositoryRepository.deleteByProject(id),
    ]);

    // 3. Remove the checkout, then the project row itself.
    if (project.workspacePath) {
      await fs.rm(project.workspacePath, { recursive: true, force: true });
    }
    await projectRepository.delete(id);

    logger.info(
      { projectId: String(id), stoppedRuns: inFlight.length },
      'Project disconnected and purged',
    );
    return { stoppedRuns: inFlight.length };
  }
}

export const onboardingService = new OnboardingService();
