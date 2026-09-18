import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ToolExecutionError } from '../../utils/errors';

/**
 * Local git operations on a project's checkout.
 *
 * The clone URL carries the token only in memory for the clone/push call and is
 * never written to `.git/config` (we set the remote back to the clean URL right
 * after cloning), so a token cannot leak through a repository artifact or a
 * `git remote -v` in a terminal tool call.
 */
export interface CloneOptions {
  url: string;
  destination: string;
  branch?: string;
  token?: string;
  depth?: number;
}

export interface RepoStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  created: string[];
  deleted: string[];
  isClean: boolean;
}

/**
 * ## Git never leaves the directory it was given
 * Git finds a repository by walking *up* from the working directory. A
 * workspace whose top level is not itself a repository — a local import where
 * only the packages inside have `.git` — therefore resolved to whatever
 * repository contained the workspace. On this platform that was the platform's
 * own source tree: agents created six branches in it and switched its checkout,
 * and a commit would have staged the operator's uncommitted platform code.
 *
 * Two guards, either of which alone would have prevented it:
 *  - `GIT_CEILING_DIRECTORIES` is set to the parent of `repoPath`, so git itself
 *    refuses to search above the directory this manager was created for;
 *  - `assertOwnRepository()` checks `--show-toplevel` equals `repoPath` before
 *    any operation, and fails with a message naming the problem.
 */
export class GitManager {
  private readonly git: SimpleGit;
  private ownership?: Promise<void>;

  constructor(public readonly repoPath: string) {
    this.git = simpleGit({ baseDir: repoPath, maxConcurrentProcesses: 2 }).env({
      ...GitManager.inheritedEnv(),
      GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(repoPath)),
    });
  }

  /**
   * The environment git runs with: the process environment minus every `GIT_*`
   * variable and the editor/pager hooks. An inherited `GIT_DIR` or
   * `GIT_WORK_TREE` would point git at a different repository just as surely as
   * walking up does, and simple-git refuses to run with `EDITOR`/`PAGER` set.
   */
  private static inheritedEnv(): Record<string, string> {
    const blocked = /^(GIT_|EDITOR$|VISUAL$|PAGER$|SSH_ASKPASS$)/i;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !blocked.test(key)) result[key] = value;
    }
    return result;
  }

  /** True when `dir` is the top level of its own git repository. */
  static async isRepositoryRoot(dir: string): Promise<boolean> {
    try {
      await new GitManager(dir).assertOwnRepository();
      return true;
    } catch {
      return false;
    }
  }

  /** Throw unless `repoPath` is the top level of a repository. Cached per instance. */
  assertOwnRepository(): Promise<void> {
    this.ownership ??= (async () => {
      let top: string;
      try {
        top = (await this.git.revparse(['--show-toplevel'])).trim();
      } catch (err) {
        throw new ToolExecutionError(
          `'${this.repoPath}' is not a git repository (${(err as Error).message.split('\n')[0]}).`,
          false,
        );
      }
      const [a, b] = await Promise.all([
        fs.realpath(top).catch(() => path.resolve(top)),
        fs.realpath(this.repoPath).catch(() => path.resolve(this.repoPath)),
      ]);
      if (path.normalize(a).toLowerCase() !== path.normalize(b).toLowerCase()) {
        throw new ToolExecutionError(
          `Refusing git operation: '${this.repoPath}' is inside another repository ('${top}') ` +
            'rather than being a repository itself.',
          false,
        );
      }
    })();
    return this.ownership;
  }

  static async clone(options: CloneOptions): Promise<GitManager> {
    const { url, destination, branch, token, depth = 1 } = options;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rm(destination, { recursive: true, force: true });

    const authUrl = token ? GitManager.withToken(url, token) : url;
    const args = ['--depth', String(depth), '--single-branch'];
    if (branch) args.push('--branch', branch);

    logger.info({ url: GitManager.redact(url), destination, branch }, 'Cloning repository');
    await simpleGit().clone(authUrl, destination, args);

    const manager = new GitManager(destination);
    // Strip credentials from the persisted remote immediately.
    await manager.git.remote(['set-url', 'origin', url]);
    await manager.git.addConfig('user.name', env.GIT_AUTHOR_NAME);
    await manager.git.addConfig('user.email', env.GIT_AUTHOR_EMAIL);
    return manager;
  }

  static withToken(url: string, token: string): string {
    try {
      const parsed = new URL(url);
      parsed.username = 'x-access-token';
      parsed.password = token;
      return parsed.toString();
    } catch {
      return url;
    }
  }

  static redact(url: string): string {
    return url.replace(/\/\/[^@]+@/, '//***@');
  }

  /** The git client, after proving this directory is its own repository. */
  private async g(): Promise<SimpleGit> {
    await this.assertOwnRepository();
    return this.git;
  }

  async currentBranch(): Promise<string> {
    return (await (await this.g()).revparse(['--abbrev-ref', 'HEAD'])).trim();
  }

  async headCommit(): Promise<string> {
    return (await (await this.g()).revparse(['HEAD'])).trim();
  }

  async defaultBranch(): Promise<string> {
    try {
      const result = await (await this.g()).raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      return result.trim().split('/').pop() ?? 'main';
    } catch {
      return this.currentBranch();
    }
  }

  async status(): Promise<RepoStatus> {
    const s = await (await this.g()).status();
    return {
      branch: s.current ?? 'unknown',
      ahead: s.ahead,
      behind: s.behind,
      staged: s.staged,
      modified: s.modified,
      created: s.created,
      deleted: s.deleted,
      isClean: s.isClean(),
    };
  }

  async createBranch(name: string, from?: string): Promise<string> {
    const safe = name.replace(/[^a-zA-Z0-9._/-]/g, '-');
    if (!safe || safe.startsWith('-')) throw new ToolExecutionError(`Invalid branch name '${name}'`);
    if (from) await (await this.g()).checkout(from);
    await (await this.g()).checkoutLocalBranch(safe);
    logger.info({ branch: safe, repoPath: this.repoPath }, 'Created branch');
    return safe;
  }

  async checkout(branch: string): Promise<void> {
    await (await this.g()).checkout(branch);
  }

  async stageAll(): Promise<void> {
    await (await this.g()).add(['-A']);
  }

  async stage(paths: string[]): Promise<void> {
    if (paths.length) await (await this.g()).add(paths);
  }

  /** Commit what is staged. Returns null when nothing is staged. */
  async commit(message: string): Promise<string | null> {
    const git = await this.g();
    const staged = (await git.raw(['diff', '--cached', '--name-only'])).trim();
    if (!staged) return null;
    // Identity is passed per command rather than read from the repository's
    // config: an imported repository may have none, and the commit would fail.
    await git.raw([
      '-c', `user.name=${env.GIT_AUTHOR_NAME}`,
      '-c', `user.email=${env.GIT_AUTHOR_EMAIL}`,
      'commit', '--no-verify', '-q', '-m', message,
    ]);
    return this.headCommit();
  }

  async diff(staged = false, maxChars = 40_000): Promise<string> {
    const args = staged ? ['--cached'] : [];
    const output = await (await this.g()).diff(args);
    return output.length > maxChars
      ? `${output.slice(0, maxChars)}\n... [diff truncated at ${maxChars} characters]`
      : output;
  }

  async diffAgainst(base: string, maxChars = 40_000): Promise<string> {
    const output = await (await this.g()).diff([`${base}...HEAD`]);
    return output.length > maxChars ? `${output.slice(0, maxChars)}\n... [truncated]` : output;
  }

  async push(branch: string, token?: string, remoteUrl?: string): Promise<void> {
    if (token && remoteUrl) {
      // Push with an inline authenticated URL; the stored remote stays clean.
      await (await this.g()).push(GitManager.withToken(remoteUrl, token), branch, ['--set-upstream']);
    } else {
      await (await this.g()).push('origin', branch, ['--set-upstream']);
    }
    logger.info({ branch }, 'Pushed branch');
  }

  async log(limit = 20): Promise<{ hash: string; message: string; author: string; date: string }[]> {
    const log = await (await this.g()).log({ maxCount: limit });
    return log.all.map((c) => ({
      hash: c.hash.slice(0, 8),
      message: c.message,
      author: c.author_name,
      date: c.date,
    }));
  }

  async reset(): Promise<void> {
    await (await this.g()).reset(['--hard']);
    await (await this.g()).clean('f', ['-d']);
  }

  // --- Run branches ---------------------------------------------------------

  async branchExists(name: string): Promise<boolean> {
    const out = await (await this.g()).raw(['branch', '--list', name]);
    return out.trim().length > 0;
  }

  /** Check out `name`, creating it from the current HEAD if it does not exist. */
  async checkoutOrCreate(name: string): Promise<void> {
    const git = await this.g();
    if (await this.branchExists(name)) await git.checkout(name);
    else await git.checkoutLocalBranch(name);
  }

  async hasChanges(): Promise<boolean> {
    return !(await (await this.g()).status()).isClean();
  }

  /**
   * Stage everything except excluded paths, and commit.
   *
   * `exclude` receives repo-relative POSIX paths. It is how secret files and
   * dependency folders are kept out of a commit even when a repository has no
   * `.gitignore` for them — `git add -A` alone would commit a stray `.env`.
   * Returns null when nothing was left to commit.
   */
  async commitAll(message: string, exclude: (relativePath: string) => boolean): Promise<string | null> {
    const git = await this.g();
    await git.add(['-A']);
    const staged = (await git.raw(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
    const excluded = staged.filter(exclude);
    if (excluded.length) {
      // Unstage in chunks to stay under Windows' command-line length limit.
      for (let i = 0; i < excluded.length; i += 100) {
        await git.raw(['reset', '-q', 'HEAD', '--', ...excluded.slice(i, i + 100)]);
      }
    }
    return this.commit(message);
  }

  /**
   * Re-apply a commit's changes to the working tree *without* committing them.
   * Used to put an operator's uncommitted work back after a run, so the
   * checkout is exactly as it was before the run started.
   */
  async reapplyUncommitted(commit: string): Promise<void> {
    const git = await this.g();
    await git.raw([
      '-c', `user.name=${env.GIT_AUTHOR_NAME}`,
      '-c', `user.email=${env.GIT_AUTHOR_EMAIL}`,
      'cherry-pick', '--no-commit', commit,
    ]);
    await git.raw(['reset', '-q']);
  }

  /** Paths changed between two commits, repo-relative. */
  async changedBetween(base: string, head: string): Promise<string[]> {
    const out = await (await this.g()).raw(['diff', '--name-only', `${base}..${head}`]);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /**
   * Publish a branch into another local repository without touching its
   * working tree: this updates only the ref `refs/heads/<branch>` there. Git
   * refuses if that branch is the one checked out in the target, which is the
   * behaviour we want. Force is safe because run branches are namespaced to the
   * platform (`aiec/...`) and owned by it.
   */
  async pushBranchToPath(targetRepo: string, branch: string): Promise<void> {
    await (await this.g()).raw(['push', '--force', '--no-verify', targetRepo, `refs/heads/${branch}:refs/heads/${branch}`]);
    logger.info({ branch, targetRepo }, 'Published run branch to local repository');
  }
}

