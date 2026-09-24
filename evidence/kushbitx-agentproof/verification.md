# KushBitx AgentProof pilot verification

## Scope

This verification covers the accepted free pilot boundary for the KushBitx AgentProof integration:

- token preview
- SpendGuard evaluation
- unsigned HTTP 402 challenge discovery
- no signing, payment, wallet exposure, Transaction Preflight, or Payment Proof

## Local verification results

Commands run from `backend`:

- `npm run lint` → exit 0
- `npm run typecheck` → exit 0
- `npm test` → exit 1
  - failing test: `src/workflows/run-branch.test.ts`
  - failure: `resumes a paused branch, preserves its earlier feature, and restores operator work`
  - error: `The following untracked working tree files would be overwritten by checkout: src/wip.js`
- `npm run build` → exit 0
- `npm run verify` → exit 1
  - same failing Git checkout test noted above
- `npm run test:agentproof` → exit 0
  - `97` tests passed
  - `0` failed

### Test totals

- `npm test`: `204` total tests, `203` passed, `1` failed
- `npm run test:agentproof`: `97` total tests, `97` passed, `0` failed

## Mocked vs live output

### Mocked output (focused AgentProof suite)

The focused KushBitx AgentProof suite passed deterministically under the repo test harness:

```text
# tests 97
# suites 2
# pass 97
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 960.3812
```

### Live output (sanitized actual results)

#### Live token preview

Command: `npm run pilot:live -- preview`

Result:

```json
{
  "error": "MALFORMED_RESPONSE",
  "message": "Invalid KushBitx response."
}
```

This was a truthful live failure; no payment or signing occurred.

#### Live APPROVE fixture

Command: `npm run pilot:live -- approve-once`

Result:

```json
{
  "requestId": "aw-allow-20260923",
  "decision": "APPROVE",
  "reasonCodes": [],
  "decisionId": "0x684b61bfe61e82ce10e82f3866dcaf2821a5eeeb6036bf6f333c4e19d55192cd",
  "checkedAt": "2026-09-24T09:50:26.107Z"
}
```

#### Live BLOCK fixture

Command: `npm run pilot:live -- block-once`

Result:

```json
{
  "requestId": "aw-block-20260923",
  "decision": "BLOCK",
  "reasonCodes": [
    "PER_TRANSACTION_LIMIT",
    "HUMAN_THRESHOLD"
  ],
  "decisionId": "0xf1d841258bc9c3270dd81cf94f975b383070b23b4683f73850d6889afb3ee2d4",
  "checkedAt": "2026-09-24T09:50:39.923Z"
}
```

The BLOCK fixture included `PER_TRANSACTION_LIMIT` as required.

#### HTTP 402 challenge discovery

Command: `npm run pilot:live -- challenge`

Result:

```json
{
  "service": "token-risk",
  "http_status": 402,
  "payment_required": true,
  "execution_performed": false,
  "payment_signed": false,
  "challenge": {
    "x402Version": 2,
    "resource": {
      "url": "https://kushbitx.com/api/token-risk"
    },
    "accepts": [
      {
        "scheme": "exact",
        "network": "eip155:8453",
        "amount": "250000",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "payTo": "0x0d68028d06af13379C872FEE032568B4Be712f22",
        "maxTimeoutSeconds": 300,
        "extra": {
          "name": "USD Coin",
          "version": "2"
        }
      }
    ]
  }
}
```

This confirms challenge handling stopped at HTTP 402 and no payment signature was produced.

## Safety boundary confirmation

- no payment was signed
- no payment was made
- no signer/wallet/private key was exposed
- Transaction Preflight was not used
- Payment Proof was not used
- challenge handling stopped at HTTP 402
- no paid completion method was called

## Live API / SDK notes

The live preview failed with a malformed upstream response (`MALFORMED_RESPONSE`). The negative result is documented as-is, without fabrication. The SpendGuard approve/block fixtures and the challenge discovery call succeeded with the sanitized fields above.

## Repository state note

The repo-wide `npm test` and `npm run verify` commands currently fail on an unrelated Git checkout regression in `src/workflows/run-branch.test.ts` due the untracked file `src/wip.js` being overwritten during a branch switch. That failure is outside the KushBitx AgentProof adapter and its focused suite. The KushBitx-specific verification was still performed and passed as configured.
