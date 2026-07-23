import { Octokit } from '@octokit/rest';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { AppError, ValidationError } from '../../utils/errors';

/**
 * GitHub API access (Octokit).
 *
 * Kept strictly separate from `GitManager`: this class talks to the GitHub API
 * (pull requests, metadata, issues), while GitManager manipulates the local
 * checkout. Splitting them means a self-hosted GitLab/Bitbucket provider can be
 * added by implementing this surface only.
 */
export interface RepoCoordinates {
  owner: string;
  repo: string;
}

export interface PullRequestInput extends RepoCoordinates {
  title: string;
  head: string;
  base: string;
  body: string;
  draft?: boolean;
}

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string = env.GITHUB_TOKEN) {
    this.octokit = new Octokit({ auth: token || undefined, userAgent: 'ai-engineering-company/0.1' });
  }

  get isConfigured(): boolean {
    return Boolean(env.GITHUB_TOKEN);
  }

  /** Parse `https://github.com/owner/repo(.git)` or `owner/repo`. */
  static parseUrl(url: string): RepoCoordinates {
    const cleaned = url.trim().replace(/\.git$/, '');
    const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
    if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]! };

    try {
      const parsed = new URL(cleaned);
      const [owner, repo] = parsed.pathname.replace(/^\//, '').split('/');
      if (!owner || !repo) throw new Error('missing segments');
      return { owner, repo };
    } catch {
      throw new ValidationError(
        `Could not parse repository URL '${url}'. Expected https://github.com/owner/repo or owner/repo.`,
      );
    }
  }

  async getRepository(coords: RepoCoordinates) {
    try {
      const { data } = await this.octokit.repos.get({ owner: coords.owner, repo: coords.repo });
      return {
        fullName: data.full_name,
        description: data.description ?? '',
        defaultBranch: data.default_branch,
        private: data.private,
        language: data.language ?? 'unknown',
        topics: data.topics ?? [],
        cloneUrl: data.clone_url,
        size: data.size,
      };
    } catch (err) {
      throw new AppError(
        `Unable to read repository ${coords.owner}/${coords.repo}: ${(err as Error).message}`,
        502,
        'github_error',
      );
    }
  }

  async createPullRequest(input: PullRequestInput): Promise<{ number: number; url: string }> {
    const { data } = await this.octokit.pulls.create({
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: input.draft ?? false,
    });
    logger.info({ pr: data.number, url: data.html_url }, 'Pull request created');
    return { number: data.number, url: data.html_url };
  }

  async listOpenPullRequests(coords: RepoCoordinates) {
    const { data } = await this.octokit.pulls.list({ ...coords, state: 'open', per_page: 30 });
    return data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      head: pr.head.ref,
      base: pr.base.ref,
      url: pr.html_url,
    }));
  }

  async getPullRequestDiff(coords: RepoCoordinates, pullNumber: number): Promise<string> {
    const { data } = await this.octokit.pulls.get({
      ...coords,
      pull_number: pullNumber,
      mediaType: { format: 'diff' },
    });
    return data as unknown as string;
  }

  async commentOnPullRequest(
    coords: RepoCoordinates,
    pullNumber: number,
    body: string,
  ): Promise<void> {
    await this.octokit.issues.createComment({
      ...coords,
      issue_number: pullNumber,
      body,
    });
  }
}

export const githubClient = new GitHubClient();
