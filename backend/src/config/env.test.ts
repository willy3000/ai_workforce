import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveWorkspaceRoot } from './env';

describe('resolveWorkspaceRoot', () => {
  it('anchors relative paths to the backend directory', () => {
    const backendRoot = path.resolve('C:/ai-workforce/backend');

    assert.equal(
      resolveWorkspaceRoot('./workspaces', backendRoot),
      path.join(backendRoot, 'workspaces'),
    );
    assert.equal(
      resolveWorkspaceRoot('workspaces', backendRoot),
      path.join(backendRoot, 'workspaces'),
    );
  });

  it('preserves explicitly absolute paths', () => {
    const backendRoot = path.resolve('C:/ai-workforce/backend');
    const configuredRoot = path.resolve('D:/agent-workspaces');

    assert.equal(resolveWorkspaceRoot(configuredRoot, backendRoot), configuredRoot);
  });
});