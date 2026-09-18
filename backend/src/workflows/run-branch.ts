import path from 'node:path';
import { GitManager } from '../integrations/github/git-manager';
import { GitHubClient } from '../integrations/github/github-client';
import { discoverRepos, toWorkspacePath, type WorkspaceRepo } from '../integrations/github/workspace-repos';
import { isSecretPath } from '../security/secret-paths';
import type { IRepository } from '../database/models/repository.model';
import type { IRunRepoState, IWorkflowRun } from '../database/models/workflow-run.model';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { toErrorMessage } from '../utils/errors';

/**
 * The platform-owned branch a run's work lives on.
 *
 * Branching used to be left to the model, which named branches ad hoc, created
 * a new one per step, and — when the checkout was not itself a repository —
 * created them in the wrong repository entirely. The result was that after a
 * run there was nowhere to *look* at the work: no branch, no commits, just a
 * working tree mixed with the leftovers of every previous attempt.
 *
 * The lifecycle is now owned here:
 *
 *  1. **open** — in every repository in the checkout, record where the run
 *     started, create `aiec/<request>-<run>`, and commit any uncommitted work
 *     already present as a labelled *baseline* commit.
 *  2. the steps run, on that branch.
 *  3. **close** — commit what the agents changed, publish the branch into the
 *     project's own repositories, then put the checkout back exactly as it was
 *     (base branch, operator's uncommitted work re-applied), so the next run
 *     starts from the same place instead of from this run's leftovers.
 *
 * The baseline commit exists because an imported project often has work in
 * progress that was never committed. The agents build on top of it, so it has
 * to be in the branch for the branch to run — but as its own commit, so
 * `baseline..head` is exactly the feature.
 */

const BASELINE_MESSAGE =
  'chore(aiec): baseline — uncommitted work present when the run started\n\n' +
  'Not written by the workforce. Committed so the run branch contains the code the agents ' +
  'built on. The feature is the commit(s) after this one.';

/** Never commit secrets or dependency folders, even when a repo does not ignore them. */
export function excludeFromCommit(repo: WorkspaceRepo): (repoRelative: string) => boolean {
  return (repoRelative) => {
    const workspacePath = toWorkspacePath(repo, repoRelative);
    return (
      isSecretPath(workspacePath) ||
      /(^|\/)(node_modules|\.next|dist|build|coverage|__pycache__|\.venv|venv)\//.test(`${repoRelative}/`)
    );
  };
}

/** `aiec/add-a-payment-feature-users-can-pay-3fd07a1c` */
export function runBranchName(run: Pick<IWorkflowRun, '_id' | 'request'>): string {
  const slug = run.request
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `aiec/${slug || 'run'}-${String(run._id).slice(-8)}`;
}

export async function openRunBranch(
  run: IWorkflowRun,
  workspacePath: string,
): Promise<{ branch: string; repos: IRunRepoState[] } | null> {
  const repos = await discoverRepos(workspacePath);
  if (!repos.length) return null;

  const branch = run.changeSet?.branch?.startsWith('aiec/') ? run.changeSet.branch : runBranchName(run);
  const previous = new Map((run.changeSet?.repos ?? []).map((r) => [r.root, r]));
  const states: IRunRepoState[] = [];

  for (const repo of repos) {
    const existing = previous.get(repo.root);
    if (existing) {
      // Resuming: the branch already holds this run's earlier work.
      await repo.git.checkoutOrCreate(branch);
      states.push(existing);
      continue;
    }

    const baseBranch = await repo.git.currentBranch();
    const baseCommit = await repo.git.headCommit();
    await repo.git.checkoutOrCreate(branch);
    const baselineCommit = (await repo.git.hasChanges())
      ? ((await repo.git.commitAll(BASELINE_MESSAGE, excludeFromCommit(repo))) ?? undefined)
      : undefined;
    states.push({ root: repo.root, baseBranch, baseCommit, baselineCommit });
    logger.info(
      { runId: String(run._id), repo: repo.root || '.', branch, baseBranch, baseline: Boolean(baselineCommit) },
      'Opened run branch',
    );
  }
  return { branch, repos: states };
}

export interface CloseResult {
  repos: IRunRepoState[];
  commits: { hash: string; message: string }[];
  changedPaths: string[];
}

/**
 * Commit, publish and restore. Never throws: a failure in one repository is
 * recorded on that repository's state and the others still close, because a
 * checkout left on a run branch would silently corrupt the next run.
 */
export async function closeRunBranch(
  run: IWorkflowRun,
  workspacePath: string,
  repository: IRepository | null,
  options: { publish: boolean },
): Promise<CloseResult> {
  const branch = run.changeSet?.branch;
  const states = run.changeSet?.repos ?? [];
  const result: CloseResult = { repos: [], commits: [], changedPaths: [] };
  if (!branch || !states.length) return result;

  const repos = await discoverRepos(workspacePath);
  const terminal = ['completed', 'failed', 'cancelled'].includes(run.status);

  for (const state of states) {
    const repo = repos.find((r) => r.root === state.root);
    const next: IRunRepoState = { ...state };
    if (!repo) {
      result.repos.push({ ...next, publishError: 'Repository no longer present in the checkout' });
      continue;
    }

    try {
      if ((await repo.git.currentBranch()) === branch) {
        const outcome = run.outcome ?? run.status;
        const message =
          `${terminal ? 'feat' : 'wip'}: ${summarise(run.request)}\n\n` +
          `AI Engineering Company run ${String(run._id)}\nOutcome: ${outcome}`;
        const hash = await repo.git.commitAll(message, excludeFromCommit(repo));
        if (hash) result.commits.push({ hash, message: `${repo.root ? `[${repo.root}] ` : ''}${message.split('\n')[0]}` });
      }

      const head = await repo.git.headCommit();
      const from = state.baselineCommit ?? state.baseCommit;
      next.headCommit = head;
      next.changedPaths = head === from ? [] : await repo.git.changedBetween(from, head);
      result.changedPaths.push(...next.changedPaths.map((p) => toWorkspacePath(repo, p)));

      // Publish only finished runs that actually changed something: an empty
      // branch, or one holding only the operator's own baseline, is noise.
      if (options.publish && terminal && next.changedPaths.length) {
        try {
          next.published = { target: await publish(repo, branch, repository), at: new Date() };
          delete next.publishError;
        } catch (err) {
          next.publishError = toErrorMessage(err);
          logger.warn({ err, repo: repo.root || '.', branch }, 'Publishing run branch failed');
        }
      }
    } catch (err) {
      next.publishError = `Could not finalise the run branch: ${toErrorMessage(err)}`;
      logger.error({ err, repo: repo.root || '.', branch }, 'Closing run branch failed');
    } finally {
      await restore(repo, state).catch((err) => {
        next.publishError = `${next.publishError ? `${next.publishError}; ` : ''}could not restore checkout: ${toErrorMessage(err)}`;
        logger.error({ err, repo: repo.root || '.' }, 'Restoring checkout after run failed');
      });
    }
    result.repos.push(next);
  }
  return result;
}

/** Back to the base branch, with the operator's uncommitted work re-applied. */
async function restore(repo: WorkspaceRepo, state: IRunRepoState): Promise<void> {
  // Anything still uncommitted here was excluded from the commit on purpose
  // (secrets, dependency folders); those are untracked and survive a checkout.
  await repo.git.checkout(state.baseBranch);
  if (state.baselineCommit) await repo.git.reapplyUncommitted(state.baselineCommit);
}

/**
 * Push the branch where the operator can check it out.
 *
 * A local import is pushed back into the original folder's repository — the one
 * the operator actually works in. That writes only `refs/heads/aiec/...`; git
 * itself refuses to update the branch that is checked out there.
 */
async function publish(repo: WorkspaceRepo, branch: string, repository: IRepository | null): Promise<string> {
  if (!repository) throw new Error('Project has no repository record, so there is nowhere to publish to');

  if (repository.provider === 'local') {
    const target = path.resolve(repository.url, repo.root);
    if (!(await GitManager.isRepositoryRoot(target))) {
      throw new Error(`'${target}' is not a git repository, so the branch cannot be pushed there`);
    }
    await repo.git.pushBranchToPath(target, branch);
    return target;
  }

  if (repository.provider === 'github') {
    if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured, so the branch cannot be pushed');
    const resolved = GitHubClient.resolve(repository.url);
    await repo.git.push(branch, env.GITHUB_TOKEN, resolved.url);
    return `${resolved.url} (branch ${branch})`;
  }

  throw new Error(`Publishing is not supported for '${String(repository.provider)}' repositories`);
}

function summarise(request: string): string {
  const oneLine = request.replace(/\s+/g, ' ').trim();
  return oneLine.length > 68 ? `${oneLine.slice(0, 67)}…` : oneLine;
}
