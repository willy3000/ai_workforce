import { z } from 'zod';

export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const ORIGIN = 'https://kushbitx.com';
export const Address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const Identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const Amount = z.string().max(24).regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/);
const Timestamp = z.string().datetime({ offset: true });
const Text = z.string().min(1).max(200).refine((value) =>
  [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));

export const PreviewInput = z.object({ address: Address }).strict();
export const SpendInput = z.object({
  agentId: Identifier,
  requestId: Identifier,
  chain: z.literal('base'),
  asset: z.literal('USDC'),
  recipient: Address,
  amount: Amount.refine((value) => /[1-9]/.test(value)),
  policy: z.object({
    maxPerTransaction: Amount,
    remainingDailyBudget: Amount,
    requireHumanAbove: Amount,
    maxRepeats: z.number().int().min(1).max(1000),
    allowedRecipients: z.array(Address).max(100),
    blockUnknownRecipients: z.boolean(),
    applyAgentProof: z.literal(false),
  }).strict(),
  context: z.object({ repeatCount: z.number().int().min(0).max(1000) }).strict(),
}).strict();
export const ChallengeInput = z.object({
  service: z.literal('token-risk'),
  address: Address,
}).strict();

// Response objects strip unapproved fields at every nesting level.
export const SpendResult = z.object({
  requestId: Identifier,
  decision: z.enum(['APPROVE', 'BLOCK', 'HUMAN_APPROVAL']),
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)).max(50),
  decisionId: Identifier,
  checkedAt: Timestamp,
});
const Metric = z.number().finite().nullable();
export const PreviewResult = z.object({
  token: z.object({ address: Address, name: Text, symbol: Text }),
  market: z.object({
    priceUsd: Metric,
    liquidityUsd: Metric,
    volume24hUsd: Metric,
    priceChange24hPct: Metric,
    dex: Text.nullable(),
    pair: Text.nullable(),
  }),
  source: z.object({
    provider: Text,
    observedAt: Timestamp,
    stale: z.boolean().optional(),
    limited: z.boolean().optional(),
    ageSeconds: z.number().finite().nonnegative().optional(),
  }),
});

export const ChallengeTerms = z.object({
  x402Version: z.literal(2),
  resource: z.object({ url: z.literal(`${ORIGIN}/api/token-risk`) }),
  accepts: z.array(z.object({
    scheme: z.literal('exact'),
    network: z.literal('eip155:8453'),
    amount: z.literal('250000'),
    asset: Address.refine((value) => value.toLowerCase() === BASE_USDC.toLowerCase()),
    payTo: Address,
    maxTimeoutSeconds: z.number().int().min(1).max(300),
    extra: z.object({ name: z.literal('USD Coin'), version: z.literal('2') }),
  })).length(1),
});

/** Necessary condition for later trusted review; never an execution authorization. */
export function mayContinueSpend(value: unknown): boolean {
  const result = SpendResult.safeParse(value);
  return result.success && result.data.decision === 'APPROVE';
}
