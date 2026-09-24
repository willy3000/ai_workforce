import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createKushBitxPilot, PilotError } from '../integrations/kushbitx/client';
import { BASE_USDC } from '../integrations/kushbitx/schemas';
import { spendFixture } from '../integrations/kushbitx/fixtures';

// One operation per command; no all/paid/retry/reset options. This script does
// not import application configuration or read .env / wallet credentials.
const actions = ['preview', 'approve-once', 'block-once', 'challenge'] as const;
type Action = typeof actions[number];
const evidence = path.resolve(__dirname, '../../../evidence/kushbitx-agentproof');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !actions.includes(args[0] as Action)) {
    throw new Error('Choose exactly one: preview, approve-once, block-once, challenge. Run npm run test:agentproof first.');
  }
  const action = args[0] as Action;
  await fs.mkdir(evidence, { recursive: true });
  // Exclusive, durable marker BEFORE networking: crashes and ambiguous network
  // failures consume the attempt too. Committed markers prevent clone reruns.
  const marker = path.join(evidence, `${action}.attempt.json`);
  const handle = await fs.open(marker, 'wx');
  await handle.writeFile(JSON.stringify({ action, attemptedAt: new Date().toISOString(), maxAttempts: 1 }, null, 2) + '\n');
  await handle.sync();
  await handle.close();

  const client = createKushBitxPilot();
  let result: unknown;
  try {
    if (action === 'preview') result = await client.previewToken({ address: BASE_USDC });
    else if (action === 'challenge') result = await client.getPaymentChallenge({ service: 'token-risk', address: BASE_USDC });
    else {
      const kind = action === 'approve-once' ? 'approve' : 'block';
      result = await client.evaluateSpend(spendFixture(kind));
      // Adapter returns only the five maintainer-approved response fields.
      const spend = result as Awaited<ReturnType<typeof client.evaluateSpend>>;
      await fs.writeFile(path.join(evidence, `${kind}.json`), JSON.stringify(spend, null, 2) + '\n', { flag: 'wx' });
      assert.equal(spend.decision, kind === 'approve' ? 'APPROVE' : 'BLOCK');
      if (kind === 'block') assert.ok(spend.reasonCodes.includes('PER_TRANSACTION_LIMIT'));
    }
    if (action === 'preview' || action === 'challenge') {
      await fs.writeFile(path.join(evidence, `${action}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    const failure = error instanceof PilotError
      ? { error: error.code, message: error.message, status: error.status }
      : { error: 'VALIDATION_OR_EVIDENCE_FAILURE', message: 'Live validation did not complete successfully; do not retry the fixture.' };
    await fs.writeFile(path.join(evidence, `${action}.failure.json`), JSON.stringify(failure, null, 2) + '\n', { flag: 'wx' });
    throw new Error(failure.message);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error && 'code' in error && error.code === 'EEXIST'
    ? 'Attempt already recorded. No request sent. Do not delete attempt markers or repeat the maintainer fixtures.'
    : error instanceof Error ? error.message : 'Pilot verification failed.';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
