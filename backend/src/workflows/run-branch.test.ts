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
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  // Uncommitted work in progress, the way the real project had it.
  await fs.writeFile(path.join(dir, 'src', 'wip.js'), 'export const wip = true;\n');
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
});
