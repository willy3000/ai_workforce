import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Types } from 'mongoose';
import { GitManager } from '../integrations/github/git-manager';
import { discoverRepos } from '../integrations/github/workspace-repos';
import { closeRunBranch, openRunBranch, runBranchName } from './run-branch';
import type { IWorkflowRun } from '../database/models/workflow-run.model';
import type { IRepository } from '../database/models/repository.model';
import { commitTool, gitStatusTool } from '../tools/git.tool';
import type { ToolContext } from '../tools/types';
import { deliveryPermissions } from '../agents/types';

/**
 * End-to-end cover, on real git repositories, for the two failures this module
 * exists to prevent:
 *
 *  - git walking up out of a checkout that is not itself a repository, into
 *    whatever repository contains it (it found the platform's own repo);
 *  - a finished run leaving nothing the operator can check out.
 *
 * The fixture mirrors the real project: an "original" folder with no
 * repository at its top, holding a backend repo and a frontend repo, each with
 * uncommitted work in progress; and a workspace copy of it.
 */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

let tmp: string;
let original: string;
let workspace: string;

async function makeRepo(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'app.js'), 'export const v = 1;\n');
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  // Uncommitted work in progress, the way the real project had it.
  await fs.writeFile(path.join(dir, 'src', 'wip.js'), 'export const wip = true;\n');
}

async function makeTrackedSecretRepo(name: string): Promise<string> {
  const dir = path.join(tmp, name);
  await makeRepo(dir);
  await fs.writeFile(path.join(dir, '.env'), 'SMTP_PASS=initial-fixture-value\n');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'Original operator notes\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'existing tracked configuration and notes');
  return dir;
}

async function gitToolContext(workspacePath: string): Promise<{ context: ToolContext; artifacts: string[] }> {
  const artifacts: string[] = [];
  const context = {
    agentKey: 'qa-engineer',
    permissions: deliveryPermissions(),
    packages: [],
    repos: await discoverRepos(workspacePath),
    recordArtifact: async (artifact: { content: string }) => { artifacts.push(artifact.content); },
  } as unknown as ToolContext;
  return { context, artifacts };
}

const fakeRun = (overrides: Partial<IWorkflowRun> = {}): IWorkflowRun =>
  ({
    _id: new Types.ObjectId(),
    request: 'Add a payment feature with Stripe',
    status: 'running',
    changeSet: {},
    ...overrides,
  }) as IWorkflowRun;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiec-run-branch-'));
  // An enclosing repository, standing in for the platform's own repo. Nothing
  // below may ever touch it.
  git(tmp, 'init', '-q', '-b', 'main');
  git(tmp, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(tmp, 'outer.txt'), 'outer\n');
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', 'outer');

  original = path.join(tmp, 'original');
  await makeRepo(path.join(original, 'api'));
  await makeRepo(path.join(original, 'web'));
  workspace = path.join(tmp, 'workspace');
  await fs.cp(original, workspace, { recursive: true });
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GitManager containment', () => {
  it('refuses to operate on a directory that is inside another repository', async () => {
    await assert.rejects(new GitManager(workspace).currentBranch(), /not a git repository|inside another repository/);
    assert.equal(await GitManager.isRepositoryRoot(workspace), false);
    assert.equal(await GitManager.isRepositoryRoot(path.join(workspace, 'api')), true);
  });

  it('finds the package repositories, not the enclosing one', async () => {
    const repos = await discoverRepos(workspace);
    assert.deepEqual(repos.map((r) => r.root).sort(), ['api', 'web']);
  });
});

describe('run branch lifecycle', () => {
  it('opens, commits, publishes to the original, and restores the checkout', async () => {
    const run = fakeRun();
    const opened = await openRunBranch(run, workspace);
    assert.ok(opened);
    assert.equal(opened.branch, runBranchName(run));
    for (const state of opened.repos) {
      assert.equal(state.baseBranch, 'master');
      assert.ok(state.baselineCommit, 'uncommitted WIP is captured as a baseline commit');
    }

    // The "agents" change the backend only.
    await fs.writeFile(path.join(workspace, 'api', 'src', 'stripe.js'), 'export const stripe = {};\n');

    const repository = { provider: 'local', url: original } as unknown as IRepository;
    const finished = fakeRun({
      _id: run._id,
      status: 'completed',
      outcome: 'delivered',
      changeSet: { branch: opened.branch, repos: opened.repos },
    });
    const closed = await closeRunBranch(finished, workspace, repository, { publish: true });

    const api = closed.repos.find((r) => r.root === 'api')!;
    const web = closed.repos.find((r) => r.root === 'web')!;
    assert.deepEqual(api.changedPaths, ['src/stripe.js'], 'the feature diff excludes the baseline');
    assert.ok(api.published, 'the changed repository is published');
    assert.equal(web.published, undefined, 'a repository with no feature changes is not published');
    assert.deepEqual(closed.changedPaths, ['api/src/stripe.js']);

    // The branch exists in the original, with baseline + feature.
    const apiOriginal = path.join(original, 'api');
    const files = git(apiOriginal, 'ls-tree', '-r', '--name-only', opened.branch).split('\n');
    assert.ok(files.includes('src/stripe.js') && files.includes('src/wip.js'));
    // …and the original's own checkout and uncommitted work are untouched.
    assert.equal(git(apiOriginal, 'branch', '--show-current'), 'master');
    assert.match(git(apiOriginal, 'status', '--porcelain'), /\?\? src\/wip\.js/);

    // The workspace is back where it started: base branch, WIP uncommitted,
    // and the feature gone from the working tree.
    const apiWorkspace = path.join(workspace, 'api');
    assert.equal(git(apiWorkspace, 'branch', '--show-current'), 'master');
    await fs.access(path.join(apiWorkspace, 'src', 'wip.js'));
    await assert.rejects(fs.access(path.join(apiWorkspace, 'src', 'stripe.js')));

    // And the enclosing repository never moved.
    assert.equal(git(tmp, 'branch', '--list').trim(), '* main');
  });

  it('resumes a paused branch, preserves its earlier feature, and restores operator work', async () => {
    const source = path.join(tmp, 'paused-original');
    const checkout = path.join(tmp, 'paused-workspace');
    await makeRepo(path.join(source, 'api'));
    await makeRepo(path.join(source, 'web'));
    await fs.cp(source, checkout, { recursive: true });
    const run = fakeRun();
    const opened = await openRunBranch(run, checkout);
    assert.ok(opened);
    await fs.writeFile(path.join(checkout, 'web', 'src', 'first.js'), 'export const first = true;\n');
    const paused = fakeRun({ _id: run._id, status: 'awaiting_approval', changeSet: { branch: opened.branch, repos: opened.repos } });
    const closedPause = await closeRunBranch(paused, checkout, null, { publish: false });
    assert.ok(closedPause.repos.every((repo) => !repo.publishError));
    assert.equal(git(path.join(checkout, 'web'), 'branch', '--show-current'), 'master');
    await fs.access(path.join(checkout, 'web', 'src', 'wip.js'));

    const resumedRun = fakeRun({ _id: run._id, changeSet: { branch: opened.branch, repos: closedPause.repos } });
    const reopened = await openRunBranch(resumedRun, checkout);
    assert.ok(reopened);
    await fs.access(path.join(checkout, 'web', 'src', 'first.js'));
    await fs.writeFile(path.join(checkout, 'web', 'src', 'second.js'), 'export const second = true;\n');
    const closed = await closeRunBranch(
      fakeRun({ _id: run._id, status: 'completed', outcome: 'delivered', changeSet: { branch: reopened.branch, repos: reopened.repos } }),
      checkout,
      { provider: 'local', url: source } as unknown as IRepository,
      { publish: true },
    );

    assert.ok(closed.repos.every((repo) => !repo.publishError));
    assert.deepEqual(closed.changedPaths.sort(), ['web/src/first.js', 'web/src/second.js']);
    assert.ok(closed.repos.find((repo) => repo.root === 'web')?.published);
    assert.match(git(path.join(source, 'web'), 'ls-tree', '-r', '--name-only', reopened.branch), /src\/first.js/);
    for (const name of ['api', 'web']) {
      assert.equal(git(path.join(checkout, name), 'branch', '--show-current'), 'master');
      assert.match(git(path.join(checkout, name), 'status', '--porcelain'), /\?\? src\/wip\.js/);
    }
  });

  it('never commits secret files, even untracked and unignored', async () => {
    await fs.writeFile(path.join(workspace, 'api', '.env'), 'STRIPE_SECRET=sk_live_x\n');
    const run = fakeRun();
    const opened = await openRunBranch(run, workspace);
    assert.ok(opened);
    const tree = git(path.join(workspace, 'api'), 'ls-tree', '-r', '--name-only', 'HEAD');
    assert.ok(!tree.split('\n').includes('.env'));
    await closeRunBranch(
      fakeRun({ _id: run._id, status: 'cancelled', changeSet: { branch: opened.branch, repos: opened.repos } }),
      workspace,
      null,
      { publish: false },
    );
    // Still present on disk for the operator, just never committed.
    await fs.access(path.join(workspace, 'api', '.env'));
  });

  it('preserves a staged tracked secret through baseline, feature commit, and checkout restoration', async () => {
    const dir = await makeTrackedSecretRepo('tracked-secret-lifecycle');
    await fs.writeFile(path.join(dir, '.env'), 'SMTP_PASS=operator-fixture-value\n');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'Operator work in progress\n');
    git(dir, 'add', '.env', 'notes.txt');

    const run = fakeRun();
    const opened = await openRunBranch(run, dir);
    assert.ok(opened);
    assert.ok(opened.repos[0].baselineCommit);
    assert.equal(git(dir, 'show', 'HEAD:.env'), 'SMTP_PASS=initial-fixture-value');
    assert.equal(await fs.readFile(path.join(dir, '.env'), 'utf8'), 'SMTP_PASS=operator-fixture-value\n');

    await fs.writeFile(path.join(dir, 'src', 'app.js'), 'export const v = 2;\n');
    await fs.writeFile(path.join(dir, '.env'), 'SMTP_PASS=updated-operator-fixture-value\n');
    git(dir, 'add', '.env');
    const closed = await closeRunBranch(
      fakeRun({ _id: run._id, status: 'completed', outcome: 'delivered', changeSet: { branch: opened.branch, repos: opened.repos } }),
      dir,
      null,
      { publish: false },
    );

    assert.equal(closed.repos[0].publishError, undefined);
    assert.deepEqual(closed.changedPaths, ['src/app.js']);
    assert.equal(git(dir, 'show', `${opened.branch}:.env`), 'SMTP_PASS=initial-fixture-value');
    assert.equal(git(dir, 'branch', '--show-current'), 'master');
    assert.equal(await fs.readFile(path.join(dir, '.env'), 'utf8'), 'SMTP_PASS=updated-operator-fixture-value\n');
    assert.equal(await fs.readFile(path.join(dir, 'notes.txt'), 'utf8'), 'Operator work in progress\n');
    assert.equal(await fs.readFile(path.join(dir, 'src', 'app.js'), 'utf8'), 'export const v = 1;\n');
  });
});

describe('git delivery tools', () => {
  it('commits only requested paths while preserving unrelated pre-staged files', async () => {
    const dir = await makeTrackedSecretRepo('scoped-tool-commit');
    await fs.writeFile(path.join(dir, '.env'), 'SMTP_PASS=staged-fixture-secret\n');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'Unrelated staged notes\n');
    git(dir, 'add', '.env', 'notes.txt');
    await fs.writeFile(path.join(dir, 'src', 'app.js'), 'export const v = 2;\n');
    const { context, artifacts } = await gitToolContext(dir);
    const result = await commitTool.execute({ message: 'feat: change app', paths: ['src/app.js'] }, context);

    assert.match(result.output, /Committed:/);
    assert.equal(git(dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'src/app.js');
    assert.equal(git(dir, 'show', 'HEAD:.env'), 'SMTP_PASS=initial-fixture-value');
    assert.equal(git(dir, 'show', 'HEAD:notes.txt'), 'Original operator notes');
    assert.deepEqual(git(dir, 'diff', '--cached', '--name-only').split('\n').sort(), ['.env', 'notes.txt']);
    assert.equal(artifacts.length, 1);
    assert.match(artifacts[0], /\+export const v = 2/);
    assert.ok(!artifacts[0].includes('staged-fixture-secret'));
    assert.ok(!artifacts[0].includes('Unrelated staged notes'));
  });

  it('reviews committed feature changes against the run baseline without exposing local secrets', async () => {
    const dir = await makeTrackedSecretRepo('complete-feature-review');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'Operator-only baseline notes\n');
    const opened = await openRunBranch(fakeRun(), dir);
    assert.ok(opened);
    await fs.writeFile(path.join(dir, 'src', 'app.js'), 'export const v = 2;\n');
    git(dir, 'add', 'src/app.js');
    git(dir, 'commit', '-q', '-m', 'feat: reset button');
    await fs.writeFile(path.join(dir, '.env'), 'SMTP_PASS=never-show-in-review\n');
    git(dir, 'add', '.env');

    const { context } = await gitToolContext(dir);
    context.runBranch = opened.branch;
    context.runRepos = opened.repos;
    const result = await gitStatusTool.execute({ include_diff: true }, context);
    assert.match(result.output, /\+export const v = 2/);
    assert.ok(result.output.includes(opened.repos[0].baselineCommit!));
    assert.ok(!result.output.includes('Operator-only baseline notes'));
    assert.ok(!result.output.includes('never-show-in-review'));
    assert.ok(!result.output.includes('.env'));
  });
});
