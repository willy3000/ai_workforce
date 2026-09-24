import { defineTool, type ToolContext, type ToolResult } from './types';
import { PilotError, type KushBitxPilot } from '../integrations/kushbitx/client';

const address = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };
const amount = { type: 'string', maxLength: 24, pattern: '^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,6})?$' };
const identifier = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_.:-]+$' };

async function execute(
  method: keyof KushBitxPilot, input: unknown, context: ToolContext,
): Promise<ToolResult> {
  if (!context.kushbitx) {
    return { isError: true, output: JSON.stringify({ error: 'UNAVAILABLE', message: 'KushBitx capability was not granted.' }) };
  }
  try {
    const data = await context.kushbitx[method](input, context.signal);
    return { output: JSON.stringify(data), data };
  } catch (error) {
    const failure = error instanceof PilotError ? error : new PilotError('NETWORK', 'KushBitx request failed.');
    return { isError: true, output: JSON.stringify({ error: failure.code, message: failure.message,
      ...(failure.status === undefined ? {} : { status: failure.status }) }) };
  }
}

export const kushbitxPreviewTokenTool = defineTool({
  name: 'kushbitx_preview_token',
  description: 'Free Base token market preview. Market data is not a safety verdict. No wallet or payment.',
  mutating: false,
  inputSchema: { type: 'object', properties: { address }, required: ['address'], additionalProperties: false },
  execute: (input, context) => execute('previewToken', input, context),
});

export const kushbitxEvaluateSpendTool = defineTool({
  name: 'kushbitx_evaluate_spend',
  description: 'Free stateless Base USDC policy evaluation. Returns advisory data only. The execution layer must stop on every decision except APPROVE. Does not authorize or execute a payment or persist a policy.',
  mutating: false,
  inputSchema: {
    type: 'object', additionalProperties: false,
    required: ['agentId', 'requestId', 'chain', 'asset', 'recipient', 'amount', 'policy', 'context'],
    properties: {
      agentId: identifier, requestId: identifier, chain: { type: 'string', enum: ['base'] },
      asset: { type: 'string', enum: ['USDC'] }, recipient: address, amount,
      policy: {
        type: 'object', additionalProperties: false,
        required: ['maxPerTransaction', 'remainingDailyBudget', 'requireHumanAbove', 'maxRepeats',
          'allowedRecipients', 'blockUnknownRecipients', 'applyAgentProof'],
        properties: {
          maxPerTransaction: amount, remainingDailyBudget: amount, requireHumanAbove: amount,
          maxRepeats: { type: 'integer', minimum: 1, maximum: 1000 },
          allowedRecipients: { type: 'array', items: address, maxItems: 100 },
          blockUnknownRecipients: { type: 'boolean' }, applyAgentProof: { type: 'boolean', enum: [false] },
        },
      },
      context: { type: 'object', additionalProperties: false, required: ['repeatCount'],
        properties: { repeatCount: { type: 'integer', minimum: 0, maximum: 1000 } } },
    },
  },
  execute: (input, context) => execute('evaluateSpend', input, context),
});

export const kushbitxGetPaymentChallengeTool = defineTool({
  name: 'kushbitx_get_payment_challenge',
  description: 'Inspect the unsigned token-risk x402 challenge and stop at HTTP 402. No signing, payment, recovery, Preflight or Payment Proof. Non-402 responses fail.',
  mutating: false,
  inputSchema: { type: 'object', additionalProperties: false, required: ['service', 'address'],
    properties: { service: { type: 'string', enum: ['token-risk'] }, address } },
  execute: (input, context) => execute('getPaymentChallenge', input, context),
});

export const kushbitxPilotTools = [
  kushbitxPreviewTokenTool, kushbitxEvaluateSpendTool, kushbitxGetPaymentChallengeTool,
];
