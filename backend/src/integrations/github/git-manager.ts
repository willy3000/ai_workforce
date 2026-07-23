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

export class GitManager {
  private readonly git: SimpleGit;

  constructor(public readonly repoPath: string) {
    this.git = simpleGit({ baseDir: repoPath, maxConcurrentProcesses: 2 });
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

  async currentBranch(): Promise<string> {
    return (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  }

  async headCommit(): Promise<string> {
    return (await this.git.revparse(['HEAD'])).trim();
  }

  async defaultBranch(): Promise<string> {
    try {
      const result = await this.git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      return result.trim().split('/').pop() ?? 'main';
    } catch {
      return this.currentBranch();
    }
  }

  async status(): Promise<RepoStatus> {
    const s = await this.git.status();
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
    const safe = name.replace(/[^a-zA-Z0-9._\/-]/g, '-');
    if (!safe || safe.startsWith('-')) throw new ToolExecutionError(`Invalid branch name '${name}'`);
    if (from) await this.git.checkout(from);
    await this.git.checkoutLocalBranch(safe);
    logger.info({ branch: safe, repoPath: this.repoPath }, 'Created branch');
    return safe;
  }

  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  async stageAll(): Promise<void> {
    await this.git.add(['-A']);
  }

  async stage(paths: string[]): Promise<void> {
    if (paths.length) await this.git.add(paths);
  }

  async commit(message: string): Promise<string | null> {
    const status = await this.git.status();
    if (status.isClean()) return null;
    const result = await this.git.commit(message);
    return result.commit || null;
  }

  async diff(staged = false, maxChars = 40_000): Promise<string> {
    const args = staged ? ['--cached'] : [];
    const output = await this.git.diff(args);
    return output.length > maxChars
      ? `${output.slice(0, maxChars)}\n... [diff truncated at ${maxChars} characters]`
      : output;
  }

  async diffAgainst(base: string, maxChars = 40_000): Promise<string> {
    const output = await this.git.diff([`${base}...HEAD`]);
    return output.length > maxChars ? `${output.slice(0, maxChars)}\n... [truncated]` : output;
  }

  async push(branch: string, token?: string, remoteUrl?: string): Promise<void> {
    if (token && remoteUrl) {
      // Push with an inline authenticated URL; the stored remote stays clean.
      await this.git.push(GitManager.withToken(remoteUrl, token), branch, ['--set-upstream']);
    } else {
      await this.git.push('origin', branch, ['--set-upstream']);
    }
    logger.info({ branch }, 'Pushed branch');
  }

  async log(limit = 20): Promise<{ hash: string; message: string; author: string; date: string }[]> {
    const log = await this.git.log({ maxCount: limit });
    return log.all.map((c) => ({
      hash: c.hash.slice(0, 8),
      message: c.message,
      author: c.author_name,
      date: c.date,
    }));
  }

  async reset(): Promise<void> {
    await this.git.reset(['--hard']);
    await this.git.clean('f', ['-d']);
  }
}
