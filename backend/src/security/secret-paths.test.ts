import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSecretPath, redactSecrets } from './secret-paths';

describe('isSecretPath', () => {
  it('denies environment files at any depth', () => {
    for (const p of ['.env', '.env.local', 'backend/.env', 'apps/api/.env.production']) {
      assert.equal(isSecretPath(p), true, `${p} should be denied`);
    }
  });

  it('allows env templates, which document shape without holding values', () => {
    for (const p of ['.env.example', 'backend/.env.example', '.env.sample', 'frontend/.env.template']) {
      assert.equal(isSecretPath(p), false, `${p} should be readable`);
    }
  });

  it('denies key material and credential stores', () => {
    for (const p of [
      'certs/server.pem',
      'deploy/id_rsa',
      'config/service-account-key.json',
      '.ssh/known_hosts',
      'infra/terraform.tfstate',
      'app/credentials.json',
      '.npmrc',
    ]) {
      assert.equal(isSecretPath(p), true, `${p} should be denied`);
    }
  });

  it('denies the git directory, which holds credentials and full history', () => {
    assert.equal(isSecretPath('.git/config'), true);
    assert.equal(isSecretPath('submodule/.git/config'), true);
  });

  it('allows ordinary source files', () => {
    for (const p of ['src/server.ts', 'README.md', 'package.json', 'src/keyboard.ts']) {
      assert.equal(isSecretPath(p), false, `${p} should be readable`);
    }
  });

  it('normalises Windows separators before matching', () => {
    assert.equal(isSecretPath('backend\\.env'), true);
  });
});

describe('redactSecrets', () => {
  it('removes credentials embedded in a URL', () => {
    const redacted = redactSecrets('cloning https://x-access-token:ghp_secretvalue@github.com/a/b.git');
    assert.ok(!redacted.includes('ghp_secretvalue'), 'token must not survive');
    assert.ok(redacted.includes('github.com/a/b.git'), 'the useful part is preserved');
  });

  it('removes provider key formats', () => {
    assert.ok(!redactSecrets('key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz').includes('abcdefghij'));
    assert.ok(!redactSecrets('AKIAIOSFODNN7EXAMPLE').includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(!redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123').includes('ghp_abcdef'));
  });

  it('removes private key blocks entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK\n-----END RSA PRIVATE KEY-----';
    assert.equal(redactSecrets(pem), '[redacted-private-key]');
  });

  it('removes secret-looking assignments', () => {
    const redacted = redactSecrets('DATABASE_PASSWORD=hunter2hunter2');
    assert.ok(!redacted.includes('hunter2hunter2'));
  });

  it('redacts SMTP_PASS in command output and diffs', () => {
    const output = redactSecrets('+SMTP_PASS=fixture-mail-password\nSMTP_HOST=mail.example.test');
    assert.ok(!output.includes('fixture-mail-password'));
    assert.ok(output.includes('SMTP_HOST=mail.example.test'));
  });

  it('leaves ordinary code untouched', () => {
    const code = 'const total = items.reduce((a, b) => a + b, 0);';
    assert.equal(redactSecrets(code), code);
  });
});
