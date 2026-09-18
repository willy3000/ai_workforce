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

/**
 * A repository reference that has been validated against the host allowlist and
 * rebuilt from its parts.
 *
 * The distinction matters: `url` here is *constructed* by this module from
 * `owner`/`repo`, never echoed from caller input. That is what closes audit
 * finding S6 — `parseUrl` previously accepted any host and any scheme, and the
 * caller then cloned the raw string with the platform token attached, so a
 * request naming `https://attacker.example/x/y` would send the token there.
 */
export interface ResolvedRepository extends RepoCoordinates {
  /** Canonical HTTPS clone URL built from the coordinates. */
  url: string;
  host: string;
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

  /**
   * Resolve `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo`
   * or `owner/repo` to an allowlisted, canonical HTTPS repository.
   *
   * Everything that reaches git or Octokit goes through here. The rules are
   * deliberately strict, because the output of this function is a destination
   * the platform will attach a credential to:
   *
   *  - the host must appear in `GIT_ALLOWED_HOSTS` (default: github.com);
   *  - embedded credentials (`user:pass@host`) are rejected outright rather
   *    than stripped, since their presence means the caller intended a
   *    different authentication than the platform's;
   *  - explicit ports, query strings and fragments are rejected — they are how
   *    an allowlisted hostname gets pointed somewhere else;
   *  - the returned `url` is rebuilt from the validated parts, so no attacker-
   *    controlled substring survives into the clone command.
   *
   * See the OWASP SSRF prevention cheat sheet: validate against an allowlist and
   * rebuild the request, never sanitise the caller's string in place.
   */
  static resolve(input: string): ResolvedRepository {
    const raw = String(input ?? '').trim();
    if (!raw) throw new ValidationError('A repository URL is required');
    if (raw.length > 400) throw new ValidationError('Repository URL is implausibly long');

    const defaultHost = env.GIT_ALLOWED_HOSTS[0] ?? 'github.com';
    let host = defaultHost;
    let pathPart: string;

    const scpLike = /^(?:([\w.-]+)@)?([\w.-]+):(?!\/)(.+)$/.exec(raw);
    const shorthand = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw);

    if (shorthand && !raw.includes('://') && !raw.includes('@')) {
      // `owner/repo` — resolved against the default allowlisted host.
      pathPart = `${shorthand[1]}/${shorthand[2]}`;
    } else if (scpLike && !raw.includes('://')) {
      // `git@github.com:owner/repo.git` — SSH shorthand, normalised to HTTPS.
      host = scpLike[2].toLowerCase();
      pathPart = scpLike[3]!;
    } else {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new ValidationError(
          `Could not parse repository URL '${raw}'. Expected https://${defaultHost}/owner/repo or owner/repo.`,
        );
      }
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) {
        throw new ValidationError(
          `Repository scheme '${parsed.protocol.replace(':', '')}' is not supported. Use https.`,
        );
      }
      if (parsed.username || parsed.password) {
        throw new ValidationError(
          'Repository URLs must not embed credentials. Remove the "user:token@" prefix — the ' +
            'platform supplies its own GitHub credential.',
        );
      }
      if (parsed.port) {
        throw new ValidationError('Repository URLs must not specify a port.');
      }
      if (parsed.search || parsed.hash) {
        throw new ValidationError('Repository URLs must not carry a query string or fragment.');
      }
      host = parsed.hostname.toLowerCase();
      pathPart = parsed.pathname;
    }

    if (!env.GIT_ALLOWED_HOSTS.includes(host)) {
      throw new ValidationError(
        `Repository host '${host}' is not allowed. Permitted hosts: ${env.GIT_ALLOWED_HOSTS.join(', ')}. ` +
          'Ask an operator to add it to GIT_ALLOWED_HOSTS if it is a trusted enterprise instance.',
      );
    }

    const segments = pathPart.replace(/^\/+/, '').replace(/\.git\/?$/, '').split('/').filter(Boolean);
    if (segments.length !== 2) {
      throw new ValidationError(
        `Expected exactly owner/repo in '${raw}', found ${segments.length} path segment(s).`,
      );
    }
    const [owner, repo] = segments as [string, string];

    // Reject anything that is not a plain GitHub-shaped name. `..` and `%2e` are
    // the interesting cases: they would let a path segment escape the repo.
    const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$/;
    if (!NAME.test(owner) || !NAME.test(repo) || owner.includes('..') || repo.includes('..')) {
      throw new ValidationError(
        `'${owner}/${repo}' is not a valid repository name. Names may contain letters, digits, ` +
          '".", "_" and "-" only.',
      );
    }

    return { owner, repo, host, url: `https://${host}/${owner}/${repo}.git` };
  }

  /** Coordinates only, for callers that already hold a resolved URL. */
  static parseUrl(url: string): RepoCoordinates {
    const { owner, repo } = GitHubClient.resolve(url);
    return { owner, repo };
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
