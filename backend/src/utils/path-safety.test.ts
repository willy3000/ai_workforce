import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PathEscapeError, canonicalRelative, matchesAnyGlob, matchesGlob } from './path-safety';

/**
 * These tests encode the audit's confirmed S4 finding as a regression test.
 *
 * The original check was:
 *   matchesAnyGlob(['frontend/**'], 'frontend/../backend/example.ts') === true
 * while `resolveInside` resolved that same string to `backend/example.ts`. The
 * permission decision and the filesystem action therefore disagreed, which is
 * the whole bug. Canonicalising first is what makes them agree.
 */
describe('canonicalRelative', () => {
  it('collapses traversal that stays inside the root', () => {
    assert.equal(canonicalRelative('frontend/../backend/example.ts'), 'backend/example.ts');
    assert.equal(canonicalRelative('src/./app/../server.ts'), 'src/server.ts');
    assert.equal(canonicalRelative('a/b/../../c/d.ts'), 'c/d.ts');
  });

  it('normalises separators and leading slashes', () => {
    assert.equal(canonicalRelative('/src/server.ts'), 'src/server.ts');
    assert.equal(canonicalRelative('src\\app\\page.tsx'), 'src/app/page.tsx');
    assert.equal(canonicalRelative('  src/server.ts  '), 'src/server.ts');
  });

  it('rejects paths that escape the root', () => {
    assert.throws(() => canonicalRelative('../secrets.txt'), PathEscapeError);
    assert.throws(() => canonicalRelative('a/../../b'), PathEscapeError);
    assert.throws(() => canonicalRelative('..'), PathEscapeError);
  });

  it('rejects absolute and drive-qualified paths', () => {
    assert.throws(() => canonicalRelative('C:/Windows/System32'), PathEscapeError);
    assert.throws(() => canonicalRelative('//server/share/file'), PathEscapeError);
  });

  it('rejects NUL bytes, which truncate paths at the syscall boundary', () => {
    assert.throws(() => canonicalRelative('src/server.ts\0.png'), PathEscapeError);
  });

  it('rejects an empty or dot-only path', () => {
    assert.throws(() => canonicalRelative(''), PathEscapeError);
    assert.throws(() => canonicalRelative('.'), PathEscapeError);
    assert.throws(() => canonicalRelative('./'), PathEscapeError);
  });

  it('closes the confirmed S4 bypass end to end', () => {
    const attack = 'frontend/../backend/example.ts';

    // The original, uncanonicalised comparison was wrong:
    assert.equal(matchesAnyGlob(['frontend/**'], attack), true);

    // Canonicalising first gives the correct answer.
    const canonical = canonicalRelative(attack);
    assert.equal(canonical, 'backend/example.ts');
    assert.equal(matchesAnyGlob(['frontend/**'], canonical), false);
    assert.equal(matchesAnyGlob(['backend/**'], canonical), true);
  });
});

describe('matchesGlob', () => {
  it('matches a single segment with *', () => {
    assert.equal(matchesGlob('src/*.ts', 'src/server.ts'), true);
    assert.equal(matchesGlob('src/*.ts', 'src/api/server.ts'), false);
  });

  it('matches any depth with **', () => {
    assert.equal(matchesGlob('src/**', 'src/api/routes/index.ts'), true);
    assert.equal(matchesGlob('**/*.test.ts', 'src/utils/path-safety.test.ts'), true);
    assert.equal(matchesGlob('**', 'anything/at/all.ts'), true);
  });

  it('treats dots literally rather than as regex wildcards', () => {
    assert.equal(matchesGlob('.env', 'aenv'), false);
    assert.equal(matchesGlob('.env', '.env'), true);
  });
});
