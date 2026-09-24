import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createKushBitxPilot, PilotError } from './client';
import { BASE_USDC, mayContinueSpend, ORIGIN } from './schemas';
import { spendFixture } from './fixtures';

const checkedAt = '2026-09-23T00:00:00.000Z'; // Synthetic; never live evidence.
const decision = (kind: 'approve' | 'block' = 'approve') => ({
  requestId: spendFixture(kind).requestId, decision: kind === 'approve' ? 'APPROVE' : 'BLOCK',
  reasonCodes: kind === 'approve' ? [] : ['PER_TRANSACTION_LIMIT'],
  decisionId: 'mock-decision', checkedAt,
});
const preview = () => ({
  token: { address: BASE_USDC, name: 'USD Coin', symbol: 'USDC' },
  market: { priceUsd: 1, liquidityUsd: 100, volume24hUsd: 20, priceChange24hPct: 0, dex: 'mock', pair: 'USDC/WETH' },
  source: { provider: 'mock', observedAt: checkedAt, stale: false },
});
const challenge = () => ({
  x402Version: 2, resource: { url: `${ORIGIN}/api/token-risk` }, accepts: [{
    scheme: 'exact', network: 'eip155:8453', amount: '250000', asset: BASE_USDC,
    payTo: '0x1111111111111111111111111111111111111111', maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  }],
});
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const reply = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const mock = (body: unknown, status = 200, headers = {}) =>
  createKushBitxPilot(async () => reply(body, status, headers));
const fails = (code: string) => (error: unknown) => {
  assert.ok(error instanceof PilotError);
  assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /sensitive-upstream-value/);
  return true;
};

describe('KushBitx installed SDK adapter', () => {
  it('previews a matching token and strips unapproved response fields', async () => {
    const result = await mock({ ...preview(), secret: 'omit', token: { ...preview().token, secret: 'omit' } })
      .previewToken({ address: BASE_USDC });
    assert.deepEqual(result, preview());
  });

  for (const body of [{}, { ...preview(), market: [] }, { ...preview(), token: { ...preview().token, address: '0x' + '1'.repeat(40) } },
    { ...preview(), source: { provider: 'mock', observedAt: 'yesterday' } }]) {
    it('rejects malformed or mismatched token preview', async () => {
      await assert.rejects(mock(body).previewToken({ address: BASE_USDC }), fails('MALFORMED_RESPONSE'));
    });
  }

  for (const kind of ['approve', 'block'] as const) {
    it(`evaluates ${kind} and preserves only the five evidence fields`, async () => {
      const result = await mock({ ...decision(kind), secret: 'omit' }).evaluateSpend(spendFixture(kind));
      assert.deepEqual(result, decision(kind));
      if (kind === 'block') assert.ok(result.reasonCodes.includes('PER_TRANSACTION_LIMIT'));
    });
  }
  for (const body of [{}, { ...decision(), decision: 'ALLOW' }, { ...decision(), reasonCodes: 'PER_TRANSACTION_LIMIT' },
    { ...decision(), requestId: 'wrong-request' }, { ...decision(), checkedAt: 'invalid' },
    { ...decision(), decisionId: undefined }]) {
    it('rejects malformed or uncorrelated SpendGuard data', async () => {
      await assert.rejects(mock(body).evaluateSpend(spendFixture('approve')), fails('MALFORMED_RESPONSE'));
    });
  }
  it('continues only on a complete APPROVE result; all other outcomes stop', () => {
    assert.equal(mayContinueSpend(decision()), true);
    for (const value of [decision('block'), { ...decision(), decision: 'HUMAN_APPROVAL' },
      { ...decision(), decision: 'ALLOW' }, { decision: 'APPROVE' }, null, {}, 'APPROVE']) {
      assert.equal(mayContinueSpend(value), false);
    }
  });
  it('returns HUMAN_APPROVAL for review without granting continuation', async () => {
    const result = await mock({ ...decision(), decision: 'HUMAN_APPROVAL' }).evaluateSpend(spendFixture('approve'));
    assert.equal(result.decision, 'HUMAN_APPROVAL');
    assert.equal(mayContinueSpend(result), false);
  });

  it('stops after exactly one unsigned HTTP 402 request', async () => {
    let requests = 0;
    const client = createKushBitxPilot(async (url, init) => {
      requests++;
      assert.equal(url, `${ORIGIN}/api/token-risk`);
      assert.equal(init?.method, 'POST');
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'manual');
      assert.deepEqual([...new Headers(init?.headers)], [['content-type', 'application/json']]);
      assert.equal(typeof init?.body, 'string');
      assert.deepEqual(JSON.parse(init?.body as string), { chain: 'base', address: BASE_USDC });
      return reply({ error: 'Payment required', secret: 'omit' }, 402, { 'PAYMENT-REQUIRED': encoded(challenge()) });
    });
    const result = await client.getPaymentChallenge({ service: 'token-risk', address: BASE_USDC });
    assert.equal(requests, 1);
    assert.deepEqual(result, { service: 'token-risk', http_status: 402, payment_required: true,
      execution_performed: false, payment_signed: false, challenge: challenge() });
    assert.deepEqual(Object.keys(client).sort(), ['evaluateSpend', 'getPaymentChallenge', 'previewToken']);
  });
  for (const status of [200, 202, 301, 307, 400, 401, 429, 500]) {
    it(`rejects challenge HTTP ${status} without retries`, async () => {
      let requests = 0;
      const client = createKushBitxPilot(async () => { requests++; return reply({ error: 'sensitive-upstream-value' }, status); });
      await assert.rejects(client.getPaymentChallenge({ service: 'token-risk', address: BASE_USDC }),
        fails(status >= 400 ? 'UPSTREAM_HTTP' : 'UNEXPECTED_STATUS'));
      assert.equal(requests, 1);
    });
  }
  for (const header of [undefined, 'not base64', encoded({}), encoded({ ...challenge(), x402Version: 1 }),
    encoded({ ...challenge(), accepts: [] }), encoded({ ...challenge(), resource: { url: 'https://example.com' } }),
    encoded({ ...challenge(), accepts: [{ ...challenge().accepts[0], amount: '1' }] }),
    encoded({ ...challenge(), accepts: [{ ...challenge().accepts[0], network: 'eip155:1' }] })]) {
    it('rejects missing or malformed x402 challenge terms', async () => {
      await assert.rejects(mock({}, 402, header ? { 'PAYMENT-REQUIRED': header } : {})
        .getPaymentChallenge({ service: 'token-risk', address: BASE_USDC }), fails('MALFORMED_RESPONSE'));
    });
  }

  const calls = [
    { method: 'previewToken', input: { address: BASE_USDC } },
    { method: 'evaluateSpend', input: spendFixture('approve') },
    { method: 'getPaymentChallenge', input: { service: 'token-risk', address: BASE_USDC } },
  ] as const;
  for (const { method, input } of calls) {
    it(`${method}: sanitizes network failures`, async () => {
      const client = createKushBitxPilot(async () => { throw new Error('sensitive-upstream-value'); });
      await assert.rejects(client[method](input), fails('NETWORK'));
    });
    it(`${method}: distinguishes upstream HTTP errors`, async () => {
      await assert.rejects(mock({ error: 'sensitive-upstream-value' }, 503)[method](input), fails('UPSTREAM_HTTP'));
    });
    it(`${method}: rejects invalid JSON`, async () => {
      const client = createKushBitxPilot(async () => new Response('{broken', {
        status: method === 'getPaymentChallenge' ? 402 : 200,
      }));
      await assert.rejects(client[method](input), fails('MALFORMED_RESPONSE'));
    });
    it(`${method}: rejects oversized responses`, async () => {
      const client = createKushBitxPilot(async () => new Response('x'.repeat(65537), { status: method === 'getPaymentChallenge' ? 402 : 200 }));
      await assert.rejects(client[method](input), fails('MALFORMED_RESPONSE'));
    });
    it(`${method}: cancellation before dispatch makes no request`, async () => {
      let requests = 0;
      const client = createKushBitxPilot(async () => { requests++; return reply({}); });
      await assert.rejects(client[method](input, AbortSignal.abort()), fails('CANCELLED'));
      assert.equal(requests, 0);
    });
    it(`${method}: cancellation aborts the in-flight fetch`, async () => {
      const controller = new AbortController();
      const client = createKushBitxPilot((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('sensitive-upstream-value')), { once: true });
        controller.abort();
      }));
      await assert.rejects(client[method](input, controller.signal), fails('CANCELLED'));
    });
    for (const forbidden of ['privateKey', 'seedPhrase', 'signer', 'paymentSignature', 'wallet', 'transaction', 'recoveryKey', 'adminKey', 'baseUrl']) {
      it(`${method}: rejects ${forbidden} before networking`, async () => {
        let requests = 0;
        const client = createKushBitxPilot(async () => { requests++; return reply({}); });
        await assert.rejects(client[method]({ ...input, [forbidden]: 'forbidden' }), fails('VALIDATION'));
        assert.equal(requests, 0);
      });
    }
  }
  for (const amount of ['0', '-1', '1e3', '01.00', '1.1234567', '', 1, 'Infinity']) {
    it(`rejects invalid amount ${String(amount)}`, async () => {
      await assert.rejects(mock({}).evaluateSpend({ ...spendFixture('approve'), amount }), fails('VALIDATION'));
    });
  }
  for (const service of ['preflight', 'transaction-preflight', 'payment-proof', 'verify-payment', 'payment', 'https://example.com', '']) {
    it(`rejects unapproved service ${service}`, async () => {
      await assert.rejects(mock({}).getPaymentChallenge({ service, address: BASE_USDC }), fails('VALIDATION'));
    });
  }
  it('rejects malformed addresses, nested unknown fields and paid evidence requests', async () => {
    for (const address of ['', '0x123', '0x' + 'g'.repeat(40), BASE_USDC + ' ']) {
      await assert.rejects(mock({}).previewToken({ address }), fails('VALIDATION'));
    }
    const fixture = spendFixture('approve');
    for (const policy of [{ ...fixture.policy, signer: 'forbidden' }, { ...fixture.policy, applyAgentProof: true },
      { ...fixture.policy, maxPerTransaction: '-1' }, { ...fixture.policy, maxRepeats: 0 }]) {
      await assert.rejects(mock({}).evaluateSpend({ ...fixture, policy }), fails('VALIDATION'));
    }
    await assert.rejects(mock({}).evaluateSpend({ ...fixture, context: { repeatCount: 0, paymentSignature: 'forbidden' } }), fails('VALIDATION'));
  });
});
