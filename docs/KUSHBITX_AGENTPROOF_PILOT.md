# KushBitx AgentProof free technical pilot

This integration implements the accepted [free pilot](https://github.com/kushBitxHQ/kushbitx-sdk/issues/4)
using exactly `@kushbitx/sdk@0.1.0`. It has no compensation, reimbursement,
paid-test budget, wallet requirement, or payment execution path.

## Architecture

`backend/src/integrations/kushbitx/client.ts` wraps the installed public SDK.
Only three methods leave the adapter. An injected transport fixes the origin,
endpoint, method, body and unsigned headers, refuses redirects and retries,
limits responses to 64 KiB, and carries cancellation and a 15-second timeout.
No API key or environment variable is needed. The model cannot configure URLs,
headers, fetch implementations, SDK options, or arbitrary JSON.

`backend/src/tools/kushbitx.tool.ts` implements the three non-mutating `Tool`
objects, registered in `backend/src/tools/registry.ts`. The `agentproof` bundle
is opt-in. The runtime supplies its narrow capability through `ToolContext`;
calling a tool without that capability fails closed. Strict Zod validation in
the adapter supplements the existing runtime JSON-schema validator, which does
not recursively validate nested objects. Unknown input fields are rejected.

The registered `payment-safety-advisor` role receives that bundle plus
`report_completion`. It has no file read/write, terminal, Git, wallet or signer
capability. Existing engineering roles gain no KushBitx tool access. Runtime
role membership remains the authorization boundary for tool dispatch.

The compiler uses NodeNext resolution while preserving the backend's CommonJS
output. This preserves native dynamic import for the ESM-only SDK. The local
SDK declaration deliberately describes only the three supported methods, with
unknown response types. No compiler or lint rule is weakened.

## Tool surface

| Tool | Input | Result |
| --- | --- | --- |
| `kushbitx_preview_token` | Base token `address` | Validated token identity, selected market metrics and source freshness |
| `kushbitx_evaluate_spend` | Strict Base/USDC proposal, inline advisory policy and repeat count | `requestId`, `decision`, `reasonCodes`, `decisionId`, `checkedAt` |
| `kushbitx_get_payment_challenge` | `service: "token-risk"`, Base token `address` | HTTP 402, selected x402 terms, `payment_required: true`, `execution_performed: false`, `payment_signed: false` |

Amounts are positive decimal strings with at most six fractional digits; policy
budgets may be zero. `applyAgentProof` must be `false`. Identifiers, collections
and strings are bounded. Response fields are selected at every nesting level;
arbitrary upstream objects, errors, headers and extensions are never returned.
HTTP failures, invalid input, malformed responses, unexpected status, network
failure, timeout and cancellation produce distinct structured error codes.

Unsigned challenge discovery uses only `POST https://kushbitx.com/api/token-risk`.
The authoritative `PAYMENT-REQUIRED` header must contain valid x402 v2 terms for
that exact resource, exact-payment scheme, Base, USDC, and 250000 atomic units
(0.25 USDC). These terms are inspected only. No signed request follows the 402.

## Enforcement model

SpendGuard provides policy evaluation. The application/execution layer is
responsible for enforcement. Only `decision === "APPROVE"` may continue toward
a later trusted execution review. Every other decision stops before side effects.

`mayContinueSpend` is a fail-closed application helper: malformed results,
unknown decisions, `BLOCK`, and `HUMAN_APPROVAL` all return false. The model-facing
tool returns evaluation data only. An APPROVE result is neither a payment
authorization nor a network-level block/allow mechanism. A future execution
layer must obtain trusted policy, independently bind the decision to the exact
intent, verify freshness, and enforce human approvals. It must not trust a
model-supplied policy or a model's assertion that it received APPROVE.

This pilot has no later payment execution layer: even APPROVE performs no
transaction, signature, transfer, settlement or broadcast.

## Explicit exclusions

No signer, wallet, private key, seed phrase, payment signature, paid completion,
recovery, transaction broadcasting, Transaction Preflight, Payment Proof,
protected SpendGuard policy creation/mutation/admin operation, or funding is
accepted or exposed. Inline policy evaluation does not persist or mutate a
SpendGuard policy. Only the token-risk service is accepted for challenge discovery.

## Setup and local verification

From the repository root (Node.js 22+ recommended):

```sh
cd backend
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
npm run test:agentproof
```

Focused tests use the actual installed SDK with injected mocked HTTP responses.
They make no live calls and need no application credentials. Coverage includes
APPROVE/BLOCK/HUMAN_APPROVAL, reason codes, invalid input and responses, HTTP and
network failures, redirects/non-402 statuses, cancellation, response size,
the registry and advisor permission boundary, and unsigned single-request behavior.

## Live validation

Run local verification first. The commands are deliberately separate:

```sh
npm run pilot:live -- preview
npm run pilot:live -- approve-once
npm run pilot:live -- block-once
npm run pilot:live -- challenge
```

The two SpendGuard fixtures in `fixtures.ts` preserve the maintainer's exact IDs,
amounts and shared fields. Each command claims an exclusive durable attempt file
before networking. Failure or a crash consumes the attempt. There is no retry,
reset, alternate fixture ID, paid mode or all-in-one live command. Committed
attempt markers make rerunning these commands from this delivered checkout fail
before sending any request. Do not delete them or run the fixed canaries from a
fresh checkout; additional validation requires a separately agreed contract.
These local markers are not a cross-machine rate limiter.

## Evidence and limitations

See `evidence/kushbitx-agentproof/verification.md` for actual check outcomes and
live execution status. `focused-tests.tap` is deterministic mocked test output
(durations vary). Successful SpendGuard evidence contains exactly the five
approved response fields; no decision IDs or timestamps are synthesized. Other
live artifacts contain validated selected preview/challenge fields or sanitized
failures. Attempt timestamps are local execution metadata, not API timestamps.

Preview is market information, not a token safety assessment. Provider outages
can return stale or identity-only data; source freshness is retained. The
adapter intentionally fails closed on unrecognized upstream contracts. Prices
or x402 protocol changes require review and fixture updates before use.

SDK/API findings: version 0.1.0 ships no TypeScript declarations, has no native
per-call abort or timeout parameter, collapses JSON parse errors to an empty
object, and throws errors without structured HTTP status. The wrapper addresses
these locally. The published OpenAPI describes responses without full schemas;
its strict SpendGuard policy schema omits `applyAgentProof`, despite that field
being explicitly required by the accepted maintainer fixture. This integration
uses the maintainer contract without silently changing its payload.
