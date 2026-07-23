import { defineTool, type ToolResult } from './types';
import { PermissionGuard } from './permission-guard';
import { ToolExecutionError } from '../utils/errors';
import { env } from '../config/env';
import { githubClient, GitHubClient } from '../integrations/github/github-client';
import { truncateMiddle } from '../utils/text';

function requireGit(ctx: { git?: unknown }): asserts ctx is { git: NonNullable<typeof ctx.git> } {
  if (!ctx.git) {
    throw new ToolExecutionError(
      'This project has no git checkout attached, so git operations are unavailable.',
      false,
    );
  }
}

interface GitStatusInput {
  include_diff?: boolean;
}

export const gitStatusTool = defineTool<GitStatusInput>({
  name: 'git_status',
  description:
    'Show the current branch and which files are modified/created/deleted in the working ' +
    'tree. Set include_diff to also see the unified diff of uncommitted changes.',
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
    requireGit(ctx);
    const status = await ctx.git!.status();
    const lines = [
      `branch: ${status.branch}`,
      `clean: ${status.isClean}`,
      status.created.length ? `created: ${status.created.join(', ')}` : '',
      status.modified.length ? `modified: ${status.modified.join(', ')}` : '',
      status.deleted.length ? `deleted: ${status.deleted.join(', ')}` : '',
    ].filter(Boolean);

    if (input.include_diff) {
      const diff = await ctx.git!.diff();
      lines.push(`--- diff ---\n${truncateMiddle(diff || '(no changes)', 30_000)}`);
    }
    return { output: lines.join('\n') };
  },
});

interface CreateBranchInput {
  name: string;
  from?: string;
}

export const createBranchTool = defineTool<CreateBranchInput>({
  name: 'create_branch',
  description:
    'Create and check out a new git branch for this unit of work. Use a descriptive name ' +
    'such as "feature/payments-api" or "fix/null-user-session".',
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
    requireGit(ctx);
    new PermissionGuard(ctx.permissions, ctx.agentKey).assertCanWriteGit();
    const branch = await ctx.git!.createBranch(input.name, input.from);
    await ctx.recordArtifact({ type: 'branch', content: branch });
    return { output: `Created and checked out branch '${branch}'.`, data: { branch } };
  },
});

interface CommitInput {
  message: string;
  paths?: string[];
}

export const commitTool = defineTool<CommitInput>({
  name: 'commit_changes',
  description:
    'Stage and commit the current changes. Write a conventional-commit style message ' +
    '(e.g. "feat(payments): add checkout session endpoint"). Returns the commit hash.',
  mutating: true,
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific paths to stage (defaults to all changes)',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    requireGit(ctx);
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey);
    guard.assertCanWriteGit();

    // Staging is permission-checked path by path: an agent cannot commit a file
    // it was not allowed to write, even if something else modified it.
    if (input.paths?.length) {
      for (const p of input.paths) guard.assertCanWrite(p);
      await ctx.git!.stage(input.paths);
    } else {
      const status = await ctx.git!.status();
      const changed = [...status.created, ...status.modified, ...status.deleted, ...status.staged];
      for (const p of changed) guard.assertCanWrite(p);
      await ctx.git!.stageAll();
    }

    const hash = await ctx.git!.commit(input.message);
    if (!hash) return { output: 'Nothing to commit — the working tree is clean.' };

    const diff = await ctx.git!.diff(false, 20_000);
    await ctx.recordArtifact({ type: 'diff', content: `commit ${hash}: ${input.message}\n${diff}` });
    return { output: `Committed as ${hash}: ${input.message}`, data: { hash } };
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
    new PermissionGuard(ctx.permissions, ctx.agentKey).assertCanWriteGit();

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

    const branch = await ctx.git!.currentBranch();
    const base = input.base ?? ctx.repository.defaultBranch;
    if (branch === base) {
      throw new ToolExecutionError(
        `Refusing to open a PR from '${branch}' into itself. Create a feature branch first.`,
      );
    }

    await ctx.git!.push(branch, env.GITHUB_TOKEN, ctx.repository.url);

    const coords = GitHubClient.parseUrl(ctx.repository.url);
    const pr = await githubClient.createPullRequest({
      ...coords,
      title: input.title,
      body: `${input.body}\n\n---\n_Opened by the AI Engineering Company platform (agent: ${ctx.agentKey})._`,
      head: branch,
      base,
      draft: input.draft,
    });

    await ctx.recordArtifact({ type: 'pull_request', content: `#${pr.number} ${pr.url}` });
    return { output: `Opened pull request #${pr.number}: ${pr.url}`, data: pr };
  },
});
