import { defineTool, type ToolContext, type ToolResult } from './types';
import { PermissionGuard } from './permission-guard';
import { ToolExecutionError } from '../utils/errors';
import { env } from '../config/env';
import { githubClient, GitHubClient } from '../integrations/github/github-client';
import { repoFor, toWorkspacePath, type WorkspaceRepo } from '../integrations/github/workspace-repos';
import { truncateMiddle } from '../utils/text';

/**
 * Git tools.
 *
 * A checkout may contain several repositories (a local import of a folder that
 * holds a backend repo and a frontend repo), so these tools work across
 * `ctx.repos`, and every path an agent sees is workspace-relative — the same
 * paths it reads and writes with the file tools.
 *
 * During a workflow run the *platform* owns the branch: it creates one run
 * branch in every repository before the first step, then commits and publishes
 * it when the run ends. Agents therefore do not create branches during a run,
 * and a commit an agent makes lands on that run branch.
 */
function requireRepos(ctx: ToolContext): WorkspaceRepo[] {
  if (!ctx.repos.length) {
    throw new ToolExecutionError(
      'This project has no git repository in its checkout, so git operations are unavailable.',
      false,
    );
  }
  return ctx.repos;
}

/** Only the PR tool needs a single root repository. */
function requireGit(ctx: ToolContext): asserts ctx is ToolContext & { git: NonNullable<ToolContext['git']> } {
  if (!ctx.git) {
    throw new ToolExecutionError(
      'Pull requests are opened for a single repository at the checkout root. This checkout holds ' +
        'several repositories (or none); the platform publishes the run branch to each repository ' +
        'when the run ends — report that instead.',
      false,
    );
  }
}

const label = (repo: WorkspaceRepo) => (repo.root ? `${repo.root}/` : '(repository root)');

interface GitStatusInput {
  include_diff?: boolean;
}

export const gitStatusTool = defineTool<GitStatusInput>({
  name: 'git_status',
  description:
    'Show the branch and the modified/created/deleted files of every git repository in the ' +
    'checkout. Set include_diff to also see the unified diff of uncommitted changes.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      include_diff: { type: 'boolean', description: 'Include the unified diff (default false)' },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const sections: string[] = [];
    for (const repo of requireRepos(ctx)) {
      const status = await repo.git.status();
      const at = (paths: string[]) => paths.map((p) => toWorkspacePath(repo, p)).join(', ');
      const lines = [
        `== ${label(repo)} on branch ${status.branch}${status.isClean ? ' (clean)' : ''}`,
        status.created.length ? `created: ${at(status.created)}` : '',
        status.modified.length ? `modified: ${at(status.modified)}` : '',
        status.deleted.length ? `deleted: ${at(status.deleted)}` : '',
      ].filter(Boolean);
      if (input.include_diff && !status.isClean) {
        lines.push(`--- diff ---\n${truncateMiddle((await repo.git.diff()) || '(no textual diff)', 20_000)}`);
      }
      sections.push(lines.join('\n'));
    }
    if (ctx.runBranch) sections.unshift(`Platform run branch: ${ctx.runBranch}`);
    return { output: sections.join('\n\n') };
  },
});

interface CreateBranchInput {
  name: string;
  from?: string;
}

export const createBranchTool = defineTool<CreateBranchInput>({
  name: 'create_branch',
  description:
    'Create and check out a new git branch. During a workflow run the platform has already ' +
    'created the run branch, so this only reports it.',
  mutating: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'New branch name' },
      from: { type: 'string', description: 'Base branch (defaults to current)' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const repos = requireRepos(ctx);
    new PermissionGuard(ctx.permissions, ctx.agentKey, ctx.packages).assertCanWriteGit();

    // Not an error: the agent's intent ("work on a branch") is already met.
    if (ctx.runBranch) {
      return {
        output:
          `You are already on the run branch '${ctx.runBranch}' in ${repos.map(label).join(', ')}. ` +
          'The platform manages this branch and publishes it when the run ends — keep working on it.',
        data: { branch: ctx.runBranch },
      };
    }

    let created = input.name;
    for (const repo of repos) created = await repo.git.createBranch(input.name, input.from);
    await ctx.recordArtifact({ type: 'branch', content: created });
    return {
      output: `Created and checked out '${created}' in ${repos.map(label).join(', ')}.`,
      data: { branch: created },
    };
  },
});

interface CommitInput {
  message: string;
  paths?: string[];
}

export const commitTool = defineTool<CommitInput>({
  name: 'commit_changes',
  description:
    'Commit current changes in whichever repositories they belong to. Write a conventional-' +
    'commit style message (e.g. "feat(payments): add checkout session endpoint"). Paths are ' +
    'workspace-relative, the same paths you edit; omit them to commit all your changes.',
  mutating: true,
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific workspace-relative paths to commit (defaults to all changes)',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const repos = requireRepos(ctx);
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey, ctx.packages);
    guard.assertCanWriteGit();

    // Work out, per repository, which paths to commit. Every one is permission-
    // checked: an agent cannot commit a file it was not allowed to write, even if
    // something else modified it.
    const plan = new Map<WorkspaceRepo, string[]>();
    if (input.paths?.length) {
      for (const raw of input.paths) {
        const target = guard.assertCanWrite(raw);
        const repo = repoFor(target, repos);
        if (!repo) throw new ToolExecutionError(`'${target}' is not inside a git repository.`);
        const inRepo = repo.root ? target.slice(repo.root.length + 1) : target;
        plan.set(repo, [...(plan.get(repo) ?? []), inRepo]);
      }
    } else {
      for (const repo of repos) {
        const status = await repo.git.status();
        const changed = [...new Set([...status.created, ...status.modified, ...status.deleted, ...status.staged])];
        if (!changed.length) continue;
        for (const p of changed) guard.assertCanWrite(toWorkspacePath(repo, p));
        plan.set(repo, changed);
      }
    }

    if (!plan.size) return { output: 'Nothing to commit — no repository has changes.' };

    const committed: string[] = [];
    for (const [repo, paths] of plan) {
      await repo.git.stage(paths);
      // Staged diff captured *before* the commit: taking it afterwards is empty by
      // construction, which is how commits used to record no changes (audit E8).
      const stagedDiff = await repo.git.diff(true, 20_000);
      const hash = await repo.git.commit(input.message);
      if (!hash) continue;
      committed.push(`${label(repo)} ${hash.slice(0, 8)}`);
      await ctx.recordArtifact({
        type: 'diff',
        content: `commit ${hash} in ${label(repo)}: ${input.message}\n${stagedDiff || '(no textual diff)'}`,
      });
      await ctx.recordCommit?.({ hash, message: `${repo.root ? `[${repo.root}] ` : ''}${input.message}` });
    }

    if (!committed.length) return { output: 'Nothing to commit — the staged paths had no changes.' };
    return { output: `Committed: ${committed.join('; ')} — ${input.message}`, data: { commits: committed } };
  },
});

interface PullRequestInput {
  title: string;
  body: string;
  base?: string;
  draft?: boolean;
}

/**
 * Push + open a pull request.
 *
 * This is the platform's outward-facing action, so it is gated twice: by the
 * agent's `allowGitWrite` permission and by the `requiresHumanApproval` flag
 * (the workflow engine holds the step in `awaiting_approval` when set).
 */
export const openPullRequestTool = defineTool<PullRequestInput>({
  name: 'open_pull_request',
  description:
    'Push the current branch and open a pull request on GitHub. Only call this when the ' +
    'work is complete, committed, and reviewed. The body should summarise what changed, ' +
    'why, and how it was verified.',
  mutating: true,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request description (markdown)' },
      base: { type: 'string', description: 'Target branch (defaults to the repo default branch)' },
      draft: { type: 'boolean', description: 'Open as a draft PR' },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    requireGit(ctx);
    new PermissionGuard(ctx.permissions, ctx.agentKey, ctx.packages).assertCanWriteGit();

    if (!ctx.repository || ctx.repository.provider !== 'github') {
      throw new ToolExecutionError('This project is not connected to a GitHub repository.', false);
    }
    if (!env.GITHUB_TOKEN) {
      throw new ToolExecutionError(
        'GITHUB_TOKEN is not configured on the platform, so a pull request cannot be opened. ' +
          'Report the branch name to the operator instead.',
        false,
      );
    }

    // Opening a PR is the platform's only irreversible outward-facing action, so
    // it is the most important place to honour cancellation: a stopped run must
    // not publish (audit finding E1).
    if (ctx.signal?.aborted) {
      throw new ToolExecutionError(
        'This run was cancelled — refusing to publish a pull request. Report the branch name instead.',
        false,
      );
    }

    const branch = await ctx.git.currentBranch();
    const base = input.base ?? ctx.repository.defaultBranch;
    if (branch === base) {
      throw new ToolExecutionError(
        `Refusing to open a PR from '${branch}' into itself. Create a feature branch first.`,
      );
    }

    // Re-resolve through the allowlist rather than trusting the stored URL: the
    // repository document could predate the current policy (audit finding S6).
    const resolved = GitHubClient.resolve(ctx.repository.url);
    await ctx.git.push(branch, env.GITHUB_TOKEN, resolved.url);

    const pr = await githubClient.createPullRequest({
      owner: resolved.owner,
      repo: resolved.repo,
      title: input.title,
      body: `${input.body}\n\n---\n_Opened by the AI Engineering Company platform (agent: ${ctx.agentKey})._`,
      head: branch,
      base,
      // Default to draft: publishing something a human has not looked at is the
      // decision that most needs to be deliberate, so the safe value is the one
      // you get by omission.
      draft: input.draft ?? true,
    });

    await ctx.recordArtifact({ type: 'pull_request', content: `#${pr.number} ${pr.url}` });
    return { output: `Opened pull request #${pr.number}: ${pr.url}`, data: { ...pr, branch, base } };
  },
});
