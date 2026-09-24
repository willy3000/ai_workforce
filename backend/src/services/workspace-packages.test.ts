import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPackageJson, packageFor, type WorkspacePackage } from './workspace-packages';
import { PermissionGuard } from '../tools/permission-guard';
import { agentRegistry } from '../agents/registry';
import { permissions } from '../agents/types';
import { PermissionDeniedError } from '../utils/errors';

/**
 * Regression cover for the "blocked by restricted write scope" failure: in a
 * repository whose code lives under package directories, root-anchored globs
 * like `src/**` matched nothing and both engineers were blocked on their first
 * write.
 */
const packages: WorkspacePackage[] = [
  { root: 'project-mibm-back', kind: 'backend', manifest: 'package.json' },
  { root: 'inventory-project', kind: 'frontend', manifest: 'package.json' },
];

// Explicit scoped profiles remain supported; built-in delivery roles now work
// across packages when a delegated change requires it.
const guardFor = (key: string) =>
  new PermissionGuard(permissions({
    writePaths: ['src/**', 'package.json', 'package-lock.json', 'Dockerfile'],
    denyPaths: ['**/Dockerfile'],
    packageKinds: [key === 'backend-engineer' ? 'backend' : 'frontend'],
  }), key, packages);

describe('classifyPackageJson', () => {
  it('recognises a server package', () => {
    assert.equal(classifyPackageJson({ dependencies: { express: '^4', monk: '^7' } }), 'backend');
  });
  it('recognises a UI package, counting Next.js as frontend', () => {
    assert.equal(classifyPackageJson({ dependencies: { next: '14', react: '18' } }), 'frontend');
  });
  it('recognises a package that is both', () => {
    assert.equal(classifyPackageJson({ dependencies: { react: '18', express: '4' } }), 'fullstack');
  });
  it('falls back to unknown', () => {
    assert.equal(classifyPackageJson({ dependencies: { lodash: '4' } }), 'unknown');
    assert.equal(classifyPackageJson(null), 'unknown');
  });
});

describe('built-in delivery roles across packages', () => {
  it('allows frontend, backend, and QA roles to finish cross-package changes', () => {
    for (const role of ['frontend-engineer', 'backend-engineer', 'qa-engineer']) {
      const guard = new PermissionGuard(agentRegistry.getOrFail(role).permissions, role, packages);
      for (const target of ['project-mibm-back/src/server.js', 'inventory-project/src/auth.jsx', '.github/workflows/test.yml']) {
        assert.equal(guard.assertCanWrite(target), target);
      }
      assert.throws(() => guard.assertCanWrite('../../outside.js'), PermissionDeniedError);
      assert.throws(() => guard.assertCanWrite('project-mibm-back/.env'), PermissionDeniedError);
    }
  });
});

describe('packageFor', () => {
  it('finds the containing package and ignores prefix look-alikes', () => {
    assert.equal(packageFor('project-mibm-back/src/app.js', packages)?.root, 'project-mibm-back');
    assert.equal(packageFor('project-mibm-backup/src/app.js', packages), undefined);
    assert.equal(packageFor('README.md', packages), undefined);
  });
  it('prefers the deepest package', () => {
    const nested = [...packages, { root: 'project-mibm-back/worker', kind: 'backend' as const, manifest: 'package.json' }];
    assert.equal(packageFor('project-mibm-back/worker/index.js', nested)?.root, 'project-mibm-back/worker');
  });
});

describe('package-scoped write permissions', () => {
  it('lets the backend engineer write its own package, including dependency files', () => {
    const guard = guardFor('backend-engineer');
    for (const p of [
      'project-mibm-back/src/services/billing.js',
      'project-mibm-back/package.json',
      'project-mibm-back/package-lock.json',
    ]) {
      assert.equal(guard.assertCanWrite(p), p);
    }
  });

  it('keeps each engineer out of the other package', () => {
    assert.throws(() => guardFor('backend-engineer').assertCanWrite('inventory-project/src/app/page.js'), PermissionDeniedError);
    assert.throws(() => guardFor('frontend-engineer').assertCanWrite('project-mibm-back/src/routes/billing.js'), PermissionDeniedError);
    assert.equal(guardFor('frontend-engineer').assertCanWrite('inventory-project/src/app/page.js'), 'inventory-project/src/app/page.js');
  });

  it('still applies deny rules and the secret policy inside a package', () => {
    assert.throws(() => guardFor('backend-engineer').assertCanWrite('project-mibm-back/Dockerfile'), PermissionDeniedError);
    assert.throws(() => guardFor('backend-engineer').assertCanWrite('project-mibm-back/.env'), PermissionDeniedError);
  });

  it('does not let traversal hop from an owned package into another', () => {
    assert.throws(
      () => guardFor('backend-engineer').assertCanWrite('project-mibm-back/../inventory-project/src/x.js'),
      PermissionDeniedError,
    );
  });

  it('leaves single-package repositories unchanged', () => {
    const guard = new PermissionGuard(agentRegistry.getOrFail('backend-engineer').permissions, 'backend-engineer', []);
    assert.equal(guard.assertCanWrite('src/server.ts'), 'src/server.ts');
  });
});
