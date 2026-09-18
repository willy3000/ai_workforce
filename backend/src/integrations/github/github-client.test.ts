import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from './github-client';
import { ValidationError } from '../../utils/errors';

/**
 * Audit finding S6: `parseUrl` accepted arbitrary hosts and schemes, and the
 * caller then cloned the *raw* string with the platform's GitHub token attached.
 * A connect request naming an attacker's host would therefore send the token
 * there. These tests pin the allowlist and the rebuild-from-parts behaviour.
 */
describe('GitHubClient.resolve', () => {
  it('accepts the canonical HTTPS form', () => {
    const resolved = GitHubClient.resolve('https://github.com/vercel/next.js');
    assert.equal(resolved.owner, 'vercel');
    assert.equal(resolved.repo, 'next.js');
    assert.equal(resolved.url, 'https://github.com/vercel/next.js.git');
  });

  it('accepts owner/repo shorthand and a .git suffix', () => {
    assert.equal(GitHubClient.resolve('vercel/next.js').url, 'https://github.com/vercel/next.js.git');
    assert.equal(GitHubClient.resolve('vercel/next.js.git').repo, 'next.js');
  });

  it('normalises SSH shorthand to HTTPS', () => {
    const resolved = GitHubClient.resolve('git@github.com:vercel/next.js.git');
    assert.equal(resolved.url, 'https://github.com/vercel/next.js.git');
  });

  it('rejects a host that is not allowlisted', () => {
    assert.throws(() => GitHubClient.resolve('https://evil.example.com/a/b'), ValidationError);
    // The lookalike matters: a substring check would have let this through.
    assert.throws(() => GitHubClient.resolve('https://github.com.evil.example/a/b'), ValidationError);
  });

  it('rejects embedded credentials rather than silently stripping them', () => {
    assert.throws(
      () => GitHubClient.resolve('https://user:token@github.com/a/b'),
      ValidationError,
    );
  });

  it('rejects ports, query strings and fragments', () => {
    assert.throws(() => GitHubClient.resolve('https://github.com:8080/a/b'), ValidationError);
    assert.throws(() => GitHubClient.resolve('https://github.com/a/b?x=1'), ValidationError);
    assert.throws(() => GitHubClient.resolve('https://github.com/a/b#f'), ValidationError);
  });

  it('rejects unsupported schemes', () => {
    assert.throws(() => GitHubClient.resolve('file:///etc/passwd'), ValidationError);
    assert.throws(() => GitHubClient.resolve('ext::sh -c whoami'), ValidationError);
  });

  it('rejects path traversal in the repository coordinates', () => {
    assert.throws(() => GitHubClient.resolve('https://github.com/a/../../etc'), ValidationError);
    assert.throws(() => GitHubClient.resolve('https://github.com/a/b/c'), ValidationError);
    assert.throws(() => GitHubClient.resolve('https://github.com/a'), ValidationError);
  });

  it('never echoes caller input into the clone URL', () => {
    const resolved = GitHubClient.resolve('HTTPS://GitHub.com/Vercel/Next.js');
    // Host is lowercased and the URL is rebuilt from validated parts only.
    assert.equal(resolved.url, 'https://github.com/Vercel/Next.js.git');
  });
});
