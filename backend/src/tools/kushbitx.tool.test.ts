import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toolRegistry } from './registry';
import { kushbitxPilotTools } from './kushbitx.tool';
import { bundle } from './bundles';
import type { ToolContext } from './types';
import { agentRegistry } from '../agents/registry';
import { createKushBitxPilot } from '../integrations/kushbitx/client';
import { BASE_USDC } from '../integrations/kushbitx/schemas';
import { validateToolInput } from './validate-input';

describe('AgentProof registry and capability boundary', () => {
  it('registers exactly three non-mutating KushBitx tools', () => {
    assert.deepEqual(toolRegistry.names().filter((name) => name.startsWith('kushbitx_')), [...bundle('agentproof')].sort());
    assert.equal(kushbitxPilotTools.length, 3);
    for (const tool of kushbitxPilotTools) {
      assert.equal(toolRegistry.get(tool.name), tool);
      assert.equal(tool.mutating, false);
      assert.equal(tool.inputSchema.additionalProperties, false);
      const schema = JSON.stringify(tool.inputSchema);
      assert.doesNotMatch(schema, /privateKey|seedPhrase|signer|paymentSignature|submitPaidCheck|broadcast|recovery|adminKey|policyId/);
      assert.equal(validateToolInput(tool.inputSchema, { privateKey: 'forbidden' }).ok, false);
    }
  });
  it('gives only the advisor the pilot bundle and denies executable capabilities', () => {
    const advisor = agentRegistry.getOrFail('payment-safety-advisor');
    assert.deepEqual(advisor.tools, [...bundle('agentproof'), 'report_completion']);
    assert.deepEqual(advisor.permissions.readPaths, []);
    assert.deepEqual(advisor.permissions.writePaths, []);
    assert.equal(advisor.permissions.allowTerminal, false);
    assert.equal(advisor.permissions.allowGitWrite, false);
    assert.deepEqual(agentRegistry.all().filter((agent) => agent.tools.some((name) => name.startsWith('kushbitx_'))).map((agent) => agent.key), [advisor.key]);
  });
  it('fails closed when the explicit capability is missing', async () => {
    for (const tool of kushbitxPilotTools) {
      const result = await tool.execute({}, {} as ToolContext);
      assert.equal(result.isError, true);
      assert.equal((JSON.parse(result.output) as { error: string }).error, 'UNAVAILABLE');
    }
  });
  it('returns structured errors without leaking upstream messages', async () => {
    const ctx = { kushbitx: createKushBitxPilot(async () => { throw new Error('sensitive-upstream-value'); }) } as ToolContext;
    const result = await kushbitxPilotTools[0].execute({ address: BASE_USDC }, ctx);
    assert.equal(result.isError, true);
    assert.equal((JSON.parse(result.output) as { error: string }).error, 'NETWORK');
    assert.doesNotMatch(result.output, /sensitive-upstream-value/);
  });
});
