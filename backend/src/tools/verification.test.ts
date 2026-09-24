import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { looksLikeVerification, prepareVerification, latestChecks } from './verification';
import { runCommandTool } from './terminal.tool';
import { TerminalExecutor } from '../integrations/terminal/executor';
import { Workspace } from '../integrations/filesystem/workspace';
import { deliveryPermissions } from '../agents/types';
import type { ToolContext } from './types';

test('missing scripts and undeclared frameworks are limitations, not failing checks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiec-verification-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'next build' } }));
  assert.match((await prepareVerification('npm', ['test'], root, root)).unavailable!, /No 'test' script/);
  assert.match((await prepareVerification('npx', ['jest'], root, root)).unavailable!, /not declared/);
  assert.deepEqual((await prepareVerification('npm', ['run', 'build'], root, root)).install?.args,
    ['install', '--include=dev', '--package-lock=false']);
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}');
  assert.deepEqual((await prepareVerification('npm', ['run', 'build'], root, root)).install?.args, ['ci', '--include=dev']);
  await fs.mkdir(path.join(root, 'node_modules'));
  assert.deepEqual(await prepareVerification('npm', ['run', 'build'], root, root), {});
});

test('a nested workspace uses hoisted dependencies or the root lockfile', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiec-workspace-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'web');
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'package.json'), '{"scripts":{"test":"node --test"}}');
  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), '');
  assert.deepEqual((await prepareVerification('pnpm', ['test'], cwd, root)).install,
    { command: 'pnpm', args: ['install'], cwd: root });
  await fs.mkdir(path.join(root, 'node_modules'));
  assert.deepEqual(await prepareVerification('pnpm', ['test'], cwd, root), {});
});

test('terminal tool installs before verification and never records install success as verification', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiec-check-tool-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), '{"scripts":{"build":"next build"}}');
  const calls: string[][] = [];
  const checks: unknown[] = [];
  t.mock.method(TerminalExecutor.prototype, 'run', async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return { command, args, exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, cancelled: false };
  });
  const ctx = { workspace: new Workspace(root), permissions: deliveryPermissions(), packages: [],
    agentKey: 'qa-engineer', recordArtifact: async () => {}, recordCheck: async (c: unknown) => { checks.push(c); } } as unknown as ToolContext;
  await runCommandTool.execute({ command: 'npm', args: ['test'], reason: 'verify' }, ctx);
  assert.equal(calls.length, 0);
  assert.equal(checks.length, 0);
  await runCommandTool.execute({ command: 'npm', args: ['run', 'build'], reason: 'verify' }, ctx);
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['npm', 'install'], ['npm', 'run']]);
  assert.deepEqual(checks, [{ command: 'npm run build', passed: true, exitCode: 0 }]);
});

test('builds, node tests and namespaced checks count; dependency installs do not', () => {
  for (const [command, args] of [['npm', ['run', 'build']], ['npm', ['run', 'test:unit']], ['node', ['--test']]] as const) {
    assert.equal(looksLikeVerification(command, [...args]), true);
  }
  assert.equal(looksLikeVerification('npm', ['install', 'jest']), false);
  assert.equal(looksLikeVerification('echo', ['test']), false);
  const history = [{ command: 'web: npm test', passed: false }, { command: 'api: npm test', passed: false },
    { command: 'web: npm test', passed: true }];
  assert.deepEqual(latestChecks(history).map((c) => c.passed), [true, false]);
  assert.equal(history.length, 3);
});
