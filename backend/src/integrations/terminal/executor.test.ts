import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveWindowsCommand } from './executor';
import { PermissionDeniedError, ToolExecutionError } from '../../utils/errors';

/**
 * Regression cover for "npm was not available in the environment": on Windows
 * npm is a `.cmd` shim, which `spawn(..., { shell: false })` cannot start. The
 * resolver is exercised with an injected filesystem so these run on any OS.
 */
const nodeDir = path.join('C:', 'node');
const toolDir = path.join('C:', 'tools');
const files = new Set([
  path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  path.join(toolDir, 'pnpm.cmd'),
  path.join(toolDir, 'go.exe'),
]);
const lookup = { path: toolDir, pathExt: '.COM;.EXE;.BAT;.CMD', nodeDir, exists: (p: string) => files.has(p) };

describe('resolveWindowsCommand', () => {
  it('runs npm through node and its CLI script, with no shell', () => {
    const r = resolveWindowsCommand('npm', ['install', 'stripe'], lookup);
    assert.equal(r.executable, process.execPath);
    assert.deepEqual(r.args, [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'install', 'stripe']);
    assert.equal(r.verbatim, false);
  });

  it('runs npx the same way', () => {
    assert.match(resolveWindowsCommand('npx', ['tsc'], lookup).args[0], /npx-cli\.js$/);
  });

  it('spawns a real executable by full path', () => {
    const r = resolveWindowsCommand('go', ['test', './...'], lookup);
    assert.equal(r.executable, path.join(toolDir, 'go.exe'));
    assert.equal(r.verbatim, false);
  });

  it('runs other batch shims through cmd.exe with every argument quoted', () => {
    const r = resolveWindowsCommand('pnpm', ['add', 'stripe'], lookup);
    assert.equal(r.verbatim, true);
    assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(r.args[3], `""${path.join(toolDir, 'pnpm.cmd')}" "add" "stripe""`);
  });

  it('refuses arguments cmd.exe would interpret', () => {
    for (const bad of ['stripe & calc', 'a|b', '%PATH%', 'x"y', '>out', 'a^b', '!x!']) {
      assert.throws(() => resolveWindowsCommand('pnpm', ['add', bad], lookup), PermissionDeniedError, bad);
    }
  });

  it('reports a genuinely missing tool as missing, not as a permission problem', () => {
    assert.throws(() => resolveWindowsCommand('yarn', ['install'], lookup), ToolExecutionError);
  });
});
