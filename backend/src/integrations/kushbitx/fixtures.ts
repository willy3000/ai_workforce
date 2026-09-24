/** Maintainer-approved public canaries. IDs and amounts must not be changed. */
const shared = {
  agentId: 'ai-workforce-canary', chain: 'base', asset: 'USDC',
  recipient: '0x1111111111111111111111111111111111111111',
  policy: {
    maxPerTransaction: '5.00', remainingDailyBudget: '20.00', requireHumanAbove: '2.00',
    maxRepeats: 1, allowedRecipients: ['0x1111111111111111111111111111111111111111'],
    blockUnknownRecipients: true, applyAgentProof: false,
  },
  context: { repeatCount: 0 },
};

export function spendFixture(kind: 'approve' | 'block') {
  return structuredClone({ ...shared,
    requestId: kind === 'approve' ? 'aw-allow-20260923' : 'aw-block-20260923',
    amount: kind === 'approve' ? '1.00' : '6.00',
  });
}
