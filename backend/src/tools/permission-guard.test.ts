import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionGuard } from './permission-guard';
import { deliveryPermissions, permissions } from '../agents/types';
import { PermissionDeniedError } from '../utils/errors';

const frontendEngineer = () =>
  new PermissionGuard(
    permissions({
      readPaths: ['**'],
      writePaths: ['frontend/**', 'app/**'],
      denyPaths: ['**/Dockerfile', '.github/**'],
      allowTerminal: true,
      allowedCommands: ['npm', 'node'],
    }),
    'frontend-engineer',
  );

describe('PermissionGuard write authorization', () => {
  it('allows a write inside scope and returns the canonical path', () => {
    assert.equal(frontendEngineer().assertCanWrite('frontend/app/page.tsx'), 'frontend/app/page.tsx');
    assert.equal(frontendEngineer().assertCanWrite('/frontend/app/page.tsx'), 'frontend/app/page.tsx');
  });

  it('denies the confirmed S4 traversal bypass', () => {
    // This is the audit's proof-of-concept: it used to be *allowed*, because the
    // glob matched the raw string while the filesystem resolved somewhere else.
    assert.throws(
      () => frontendEngineer().assertCanWrite('frontend/../backend/example.ts'),
      PermissionDeniedError,
    );
  });

  it('denies writes outside scope', () => {
    assert.throws(() => frontendEngineer().assertCanWrite('backend/src/app.ts'), PermissionDeniedError);
  });

  it('honours explicit deny rules over allow rules', () => {
    assert.throws(() => frontendEngineer().assertCanWrite('frontend/Dockerfile'), PermissionDeniedError);
  });

  it('denies secrets regardless of any allow rule', () => {
    const omnipotent = new PermissionGuard(
      permissions({ readPaths: ['**'], writePaths: ['**'], denyPaths: [] }),
      'test-agent',
    );
    assert.throws(() => omnipotent.assertCanWrite('.env'), PermissionDeniedError);
    assert.throws(() => omnipotent.assertCanRead('backend/.env.production'), PermissionDeniedError);
    // …but the template is readable, which is the point of the exception list.
    assert.equal(omnipotent.assertCanRead('backend/.env.example'), 'backend/.env.example');
  });

  it('rejects absolute paths and drive letters as invalid, not as allowed', () => {
    assert.throws(() => frontendEngineer().assertCanWrite('C:/Windows/system.ini'), PermissionDeniedError);
  });

  it('refuses every write for an advisory role', () => {
    const readOnly = new PermissionGuard(permissions({ writePaths: [] }), 'qa-engineer');
    assert.throws(() => readOnly.assertCanWrite('src/anything.ts'), PermissionDeniedError);
  });
});

describe('PermissionGuard command authorization', () => {
  it('allows an allowlisted command', () => {
    assert.doesNotThrow(() => frontendEngineer().assertCanRunCommand('npm'));
  });

  it('denies anything not on the list', () => {
    assert.throws(() => frontendEngineer().assertCanRunCommand('curl'), PermissionDeniedError);
  });

  it('denies all commands for a role without terminal access', () => {
    const noTerminal = new PermissionGuard(
      permissions({ allowTerminal: false, allowedCommands: ['npm'] }),
      'project-manager',
    );
    assert.throws(() => noTerminal.assertCanRunCommand('npm'), PermissionDeniedError);
  });
});

describe('PermissionGuard.canRead', () => {
  it('reports readability without throwing, for filtering listings', () => {
    const guard = frontendEngineer();
    assert.equal(guard.canRead('src/server.ts'), true);
    assert.equal(guard.canRead('.env'), false);
    assert.equal(guard.canRead('../outside.ts'), false);
  });
});

describe('delivery permissions', () => {
  it('lets QA finish source, configuration, and CI repairs with any executable', () => {
    const guard = new PermissionGuard(deliveryPermissions(), 'qa-engineer');
    for (const target of [
      'inventory-project/src/pages/authentication.jsx',
      'project-mibm-back/src/server.ts',
      'inventory-project/package.json',
      '.github/workflows/check.yml',
    ]) {
      assert.equal(guard.assertCanWrite(target), target);
    }
    assert.doesNotThrow(() => guard.assertCanRunCommand('custom-project-verifier'));
    assert.doesNotThrow(() => guard.assertCanWriteGit());
    assert.equal(guard.requiresApproval(), false);
  });
});
