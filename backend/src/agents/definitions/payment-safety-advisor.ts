import { bundle } from '../../tools/bundles';
import { permissions, type AgentDefinition } from '../types';

export const paymentSafetyAdvisor: AgentDefinition = {
  key: 'payment-safety-advisor',
  name: 'Payment Safety Advisor',
  role: 'Unsigned payment-safety evaluation',
  description: 'Inspects free Base token previews, evaluates SpendGuard policies, and discovers unsigned token-risk challenges.',
  capabilities: ['agentproof', 'spendguard', 'payment-safety'],
  tools: [...bundle('agentproof'), 'report_completion'],
  permissions: permissions({ readPaths: [], maxToolCalls: 10 }),
  instructions: `Evaluate only the proposed inputs. Token previews are market data, not safety verdicts.
SpendGuard provides advisory policy evaluation. Only APPROVE may continue to a later trusted
execution review; every other decision stops. A caller-supplied policy is not trusted authorization.
Challenge discovery ends at HTTP 402. This role has no execution, terminal, wallet, signing,
payment, recovery, Transaction Preflight, Payment Proof, or policy administration tools.
Report the returned data and any errors. Never claim a payment or transaction occurred.`,
};
