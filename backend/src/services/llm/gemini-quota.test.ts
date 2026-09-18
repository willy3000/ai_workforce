import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiQuotaLimiter } from './gemini-quota';

test('Gemini quota rejects a request larger than the TPM budget', async () => {
  const limiter = new GeminiQuotaLimiter(30, 100, 10);
  await assert.rejects(
    limiter.reserve(80, 21),
    /above the 100-token per-minute quota/,
  );
});

test('Gemini quota reserves tokens across concurrent requests', async () => {
  const limiter = new GeminiQuotaLimiter(30, 100, 10);
  const first = await limiter.reserve(40, 40);
  const controller = new AbortController();
  const waiting = limiter.reserve(40, 40, controller.signal);
  controller.abort();

  await assert.rejects(waiting);
  first.release(20);
  assert.ok(true);
});