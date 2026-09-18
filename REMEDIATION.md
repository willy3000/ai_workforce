# Remediation pass — against `SAAS_PRODUCT_AUDIT.md`

Date: 18 September 2026 · Baseline revision: `f923340`

Written for: engineers working on this repository, and anyone deciding whether
it is safe to deploy.

This records what the remediation pass changed, what it deliberately did not,
and where the audit's findings still hold. It is written to be read next to the
audit, not instead of it.

**The headline:** the platform is materially safer and its execution is
materially more correct, but it is still **not a multi-tenant SaaS**. There are
no user accounts, no workspaces and no per-customer authorization. Section 4
below is the list of things that must exist before this is exposed to more than
one trusted operator.

---

## 1. Security

| ID | Finding | Status | What changed |
|---|---|---|---|
| S1 | Gateway attaches the platform key to any caller; backend permits an unset key in production | **Fixed** | `env.ts` refuses to boot in production without `PLATFORM_API_KEY`; `auth.ts` fails closed; the gateway requires an operator session (`lib/session.ts`) before attaching the key, with an origin check on every mutation |
| S2 | Allowlisted commands can still run arbitrary code | **Reduced, not closed** | Process-tree kill, abort-on-cancel, no-path executables. Real isolation requires `TERMINAL_SANDBOX_COMMAND`; production refuses to boot without it unless `ALLOW_UNSANDBOXED_COMMANDS=true` makes the risk an explicit choice |
| S3 | `GEMINI_API_KEY` missing from the child-env deny list | **Fixed** | Replaced the deny list with an **allowlist** (`INHERITED_ENV_KEYS`). Credentials added in future are excluded by default rather than by remembering |
| S4 | Permission guard matches uncollapsed paths (`frontend/../backend`) | **Fixed** | `canonicalRelative()` collapses first; the guard returns the canonical path and every tool acts on that return value. Regression test reproduces the audit's exact proof-of-concept |
| S5 | Indexer reads `.env` and feeds it into prompts | **Fixed** | One policy in `security/secret-paths.ts`, enforced at the walk, at `readFile`, at `writeFile`, in the permission guard and in retrieval. `.env.example` is deliberately still readable |
| S6 | `parseUrl` accepts arbitrary hosts; clone uses the raw URL with the token | **Fixed** | `GitHubClient.resolve()` validates against `GIT_ALLOWED_HOSTS` and **rebuilds** the URL from validated parts. Local-path import is gated by `ALLOW_LOCAL_PATH_IMPORT` / `LOCAL_IMPORT_ROOTS` |
| S7 | Runtime resolves any registry tool; schemas unvalidated; direct calls bypass approval | **Fixed** | Role membership checked before dispatch, arguments validated against the tool's own schema (`tools/validate-input.ts`), and `/api/agents/run` now goes through the shared `assertExecutionAllowed` policy |
| S8 | No cross-object authorization; identity strings spoofable | **Partly fixed** | `taskId` is checked against `projectId`; audit actors derive from the authenticated request via `auditActor()`. **Tenant ownership still does not exist** — see §4 |
| S9 | No admission limits; regex search runs in the API process | **Fixed** | Two-tier rate limiting, `MAX_CONCURRENT_RUNS`, `RUN_DEADLINE_MS`, and bounded search (pattern length, subject length, backtracking screen, wall-clock deadline) |
| S10 | Reflective CORS; public readiness detail | **Fixed** | Exact-origin allowlist with `none` as the documented default; readiness detail requires authentication |
| S11 | Tokens in clone URLs and logs | **Fixed** | `redactSecrets()` applied to command output, artifacts and file reads; a broader pattern set than the previous logger redaction |
| S12 | Dependency advisories, including critical Next.js RCE | **Fixed** | Next.js 16.2.10 → 16.3.5; both packages now report **0 vulnerabilities** at `--omit=dev` |

## 2. Execution correctness

| ID | Finding | Status | What changed |
|---|---|---|---|
| E1 | Cancel changes a record but work continues and can overwrite it | **Fixed** | Cancellation is durable (`cancelling` → `cancelled`) *and* signalled through an `AbortSignal` that reaches the provider call and the process tree. Terminal writes are conditional, so a late-finishing step cannot resurrect a cancelled run |
| E2 | Refusal/truncation/iteration-limit/`needs_review` treated as completed | **Fixed** | `AgentOutcome` and `StepOutcome` enums; `succeeded` is true only for a reported completion. Runs carry a `WorkflowOutcome`, surfaced as a verdict banner |
| E3 | Concurrent starts race; resume has no claim | **Fixed** | `claimForExecution` on both tasks and runs (atomic compare-and-set), plus a durable run lease |
| E4 | Work lives in request memory; restart loses it | **Fixed** | Runs execute in the background and return `202` immediately; leases detect orphans; `recoverOrphanedRuns()` marks them `interrupted` at boot. **Deliberately does not auto-resume** — replay is not yet idempotent |
| E5 | One checkout shared across runs | **Fixed** | `withProjectLock` serializes all access. `MAX_CONCURRENT_RUNS_PER_PROJECT > 1` refuses to boot until checkouts are isolated |
| E6 | Approval gates differ by entry point | **Fixed** | One `assertExecutionAllowed` policy shared by the engine, the coordinator and the direct-agent endpoint |
| E7 | Dependency/scheduling inconsistencies | **Fixed** | Numeric `priorityRank` (the string sorted `medium > critical`), batched dependency reads, missing dependencies now block, limits enforced on every path |
| E8 | PR/review evidence unreliable | **Fixed** | Immutable `baseCommit` pinned at claim time; staged diff captured *before* commit (it was previously taken after, so it was always empty); commits, changed paths and check exit codes recorded by the platform from observed effects |

## 3. Interface

Rebuilt around the multi-agent UI direction rather than restyled.

- **No sidebar, header or metric-card grid.** The workspace is a full-viewport
  room the workforce occupies; everything else floats over it as HUD.
- **Agents are actors.** Six distinct silhouettes, fixed colour slots, and a
  ten-state model where every state carries colour *and* glyph *and* label *and*
  motion — so nothing is communicated by colour alone.
- **Data flow is visible.** Packets travel edges, shaped by payload kind, driven
  by real messages from the bus. Nothing is invented to look busy; an idle
  platform renders as a calm room.
- **Evidence leads.** The run page is ordered verdict → evidence → flow →
  narrative, because the agent's own prose is the part the platform cannot
  vouch for.
- Route error/loading/not-found boundaries, abort-and-backoff polling, honest
  connection status, immediate run navigation, frozen elapsed time on terminal
  states, labelled mobile navigation, and `prefers-reduced-motion` throughout.

## 4. Deliberately **not** done

These are the audit findings this pass did not address. Each is listed because
pretending otherwise would be worse than the gap itself.

1. **Tenancy (F5, S8).** There are no users, workspaces, memberships or
   per-customer authorization. `projectId` still groups data without being an
   authorization boundary. **This is the blocker for shared hosting.**
2. **Command isolation (S2).** The sandbox seam exists and production must
   acknowledge its absence, but no sandbox is shipped.
3. **Billing and metering.** Usage is now recorded durably per run, which is the
   prerequisite — but there is no ledger, no plan, no entitlement and no
   purchase path.
4. **Automatic crash resume (E4).** Recovery marks runs `interrupted` and hands
   the decision to an operator, because step side effects are not yet idempotent.
5. **Database growth.** Byte caps on the file index, cursor pagination and
   moving large blobs out of documents remain open.
6. **Integration tests.** The 59 tests cover security and execution primitives.
   There is no test that drives a real workflow against a database.
7. **Human-in-the-loop conversation (F4).** You can see an escalation; you still
   cannot reply to it in the run.

## 5. Verifying this yourself

```bash
cd backend  && npm ci && npm run verify   # lint, typecheck, 59 tests
cd frontend && npm ci && npm run verify   # typecheck, production build
```

CI runs both on every push and pull request, plus a weekly production
dependency audit (`.github/workflows/ci.yml`).

## 6. Configuration you must set before deploying

The backend now **refuses to boot** in production without these, rather than
starting in a state that looks fine and is not:

| Variable | Why it is mandatory |
|---|---|
| `PLATFORM_API_KEY` | ≥32 chars. Without it the API is open to anyone who can reach it |
| `CORS_ALLOWED_ORIGINS` | Exact origins, or `none` for the documented private-backend topology |
| `TERMINAL_SANDBOX_COMMAND` **or** `ALLOW_UNSANDBOXED_COMMANDS=true` | Forces an explicit decision about running untrusted repository code |
| `ALLOW_LOCAL_PATH_IMPORT=false` **or** `LOCAL_IMPORT_ROOTS` | Otherwise any caller can copy arbitrary server directories into an agent-readable workspace |
| `OPERATOR_PASSWORD` (console) | The gateway refuses every request in production without it |
