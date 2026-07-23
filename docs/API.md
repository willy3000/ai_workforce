# API Reference

Base URL: `http://localhost:4000/api`

**Authentication.** If `PLATFORM_API_KEY` is set, every request except `/health*` must send `x-api-key: <value>`. When unset (local development), auth is disabled.

**Errors.** All errors share one envelope:

```json
{ "error": { "code": "validation_error", "message": "...", "details": [...], "requestId": "..." } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `validation_error` | 400 | Request body failed schema validation (`details` lists the fields) |
| `unauthorized` | 401 | Missing or invalid `x-api-key` |
| `permission_denied` | 403 | An agent attempted an action outside its permission scope |
| `not_found` | 404 | Resource does not exist |
| `conflict` | 409 | Duplicate project, task already running, approval required, project not ready |
| `provider_error` | 502 | Claude API failure |
| `internal_error` | 500 | Unexpected — check logs by `requestId` |

Every response carries an `x-request-id` header that appears in the server logs.

---

## Health

### `GET /health`
Liveness. Always 200 while the process is up.

```json
{ "status": "ok", "uptimeSeconds": 412, "version": "0.1.0" }
```

### `GET /health/ready`
Readiness — 200 when the platform can actually do work, 503 otherwise. Reports configuration state without echoing any credential.

```json
{
  "status": "ready",
  "checks": { "database": true, "claudeApiKey": true, "githubToken": true },
  "registry": {
    "agents": ["project-manager", "engineering-manager", "backend-engineer",
               "frontend-engineer", "qa-engineer", "documentation-engineer"],
    "workflows": ["feature-development", "bug-fixing", "code-review"],
    "tools": ["read_file", "code_search", "..."]
  },
  "config": { "model": "claude-opus-4-8", "effort": "high", "requireHumanApproval": false }
}
```

---

## Projects

### `POST /projects/connect`
Clone/attach a repository, index it, detect the stack, and seed project memory. This is the onboarding entry point.

| Field | Type | Required | Notes |
|---|---|---|---|
| `repositoryUrl` | string | one of | `https://github.com/owner/repo` or `owner/repo` |
| `localPath` | string | one of | Absolute path — works without a GitHub token |
| `name` | string | no | Defaults to `owner/repo` or the directory name |
| `branch` | string | no | Defaults to the repository's default branch |
| `description` | string | no | |
| `customInstructions` | string | no | Injected into every agent prompt for this project |

```bash
curl -X POST localhost:4000/api/projects/connect -H 'content-type: application/json' -d '{
  "repositoryUrl": "https://github.com/acme/storefront",
  "branch": "main"
}'
```

**201** → `{ "project": { "_id", "name", "status": "ready", "profile": { ... } } }`

`status` is `ready` on success, `failed` with an `error` field otherwise.

### `GET /projects`
`{ "projects": [...], "count": n }`

### `GET /projects/:id`
Project plus a repository summary (branch, head commit, indexed file count).

### `GET /projects/:id/memory`
Everything the organization knows about this codebase.

```json
{
  "counts": { "knowledge": { "architecture": 3, "convention": 1, "change": 7 },
              "tasks": { "done": 12, "failed": 1 }, "decisions": 4 },
  "decisions": [ { "id", "title", "decision", "rationale", "status", "decidedBy", "createdAt" } ],
  "knowledge": [ { "id", "kind", "title", "content", "tags", "paths", "source", "confidence" } ]
}
```

### `GET /projects/:id/status`
Live snapshot: the project, task counts by status, recent tasks, and recent agent messages.

### `POST /projects/:id/reanalyze`
Re-index and re-detect without re-cloning. Run this after agents have changed the codebase.

### `PATCH /projects/:id/instructions`
```json
{ "customInstructions": "Never use floating point for currency." }
```

### `DELETE /projects/:id?confirm=true`
Deletes the workspace, all project memory, and the record. `confirm=true` is required (**204**).

---

## Tasks

### `POST /tasks`
Create a task. If `assignedTo` is omitted, the router picks an owner and returns its reasoning.

| Field | Type | Default | Notes |
|---|---|---|---|
| `projectId` | string | — | Required |
| `title` | string | — | Required, 3–300 chars |
| `description` | string | `""` | |
| `type` | enum | `analysis` | `analysis`·`planning`·`architecture`·`backend`·`frontend`·`testing`·`review`·`documentation`·`bugfix`·`devops` |
| `priority` | enum | `medium` | `low`·`medium`·`high`·`critical` |
| `assignedTo` | string | auto | Agent key |
| `acceptanceCriteria` | string[] | `[]` | Checkable conditions |
| `dependsOn` | string[] | `[]` | Task ids |
| `run` | boolean | `false` | Execute the agent immediately |

```bash
curl -X POST localhost:4000/api/tasks -H 'content-type: application/json' -d '{
  "projectId": "6789abc...",
  "title": "Add rate limiting to the login endpoint",
  "description": "Limit to 5 attempts per IP per minute, return 429 with Retry-After.",
  "type": "backend",
  "acceptanceCriteria": ["6th attempt within a minute returns 429", "Retry-After header is present"],
  "run": true
}'
```

**201** → `{ "task": {...}, "routing": { "agentKey", "confidence", "reason", "alternatives" }, "result": {...} }`

### `GET /tasks?projectId=&status=&assignedTo=&workflowRunId=`
`{ "tasks": [...], "count": n }`

### `GET /tasks/:id`
The task (with full `history[]` and `artifacts[]`) plus its message thread.

### `POST /tasks/:id/run`
Execute the owning agent now. Returns the updated task and the run result:

```json
{
  "result": {
    "agentKey": "backend-engineer",
    "output": "...",
    "stopReason": "end_turn",
    "iterations": 6,
    "toolCalls": [ { "name": "read_file", "ok": true, "summary": "..." } ],
    "usage": { "inputTokens": 48210, "outputTokens": 3105, "toolCalls": 14 },
    "completion": { "status": "completed", "summary": "..." }
  }
}
```

**409 `approval_required`** if the owning agent is flagged `requiresHumanApproval`.

### `POST /tasks/:id/approve`
Release a task parked in `awaiting_approval`. Body: `{ "approvedBy": "alice" }` (optional).

### `POST /tasks/:id/status`
Operator override. `{ "status": "cancelled", "note": "superseded" }`

### `POST /tasks/run-ready`
Drain the runnable backlog (tasks whose dependencies are all `done`). Sequential by design.

```json
{ "projectId": "6789abc...", "limit": 5 }
```

---

## Agents

### `GET /agents`
The roster with capabilities, tools, **the full permission profile**, and accumulated usage stats.

```json
{
  "agents": [{
    "key": "frontend-engineer",
    "name": "Frontend Engineer",
    "role": "Client-side implementation",
    "capabilities": ["frontend", "ui", "components", "..."],
    "tools": ["read_file", "edit_file", "run_command", "..."],
    "model": "(platform default)",
    "effort": "xhigh",
    "permissions": {
      "canWrite": true,
      "writePaths": ["src/components/**", "src/pages/**", "..."],
      "deniedPaths": [".env", "**/*.pem", "server/**", "Dockerfile", "..."],
      "canRunCommands": true,
      "allowedCommands": ["npm", "npx", "tsc", "..."],
      "canWriteGit": true,
      "requiresHumanApproval": false,
      "maxToolCalls": 60
    },
    "stats": { "runs": 14, "toolCalls": 302, "inputTokens": 1204000, "outputTokens": 88000 }
  }]
}
```

### `GET /agents/:key`
One agent, including the exact JSON-schema tool definitions sent to the model.

### `POST /agents/run`
Invoke a single agent directly, outside any workflow. Useful for ad-hoc questions about a codebase.

```bash
curl -X POST localhost:4000/api/agents/run -H 'content-type: application/json' -d '{
  "agentKey": "engineering-manager",
  "projectId": "6789abc...",
  "prompt": "How is authentication implemented in this codebase, and what would it take to add SSO?"
}'
```

| Field | Required | Notes |
|---|---|---|
| `agentKey` | yes | |
| `projectId` | yes | |
| `prompt` | yes | |
| `taskId` | no | Attach the run to an existing task |
| `additionalContext` | no | Extra context prepended to the instruction |
| `maxIterations` | no | 1–40, defaults to `AGENT_MAX_ITERATIONS` |

### `POST /agents/route`
Dry-run the router without creating anything — useful for understanding routing decisions.

```json
{ "title": "Fix broken modal layout", "description": "css overflow", "type": "bugfix" }
```
→ `{ "routing": { "agentKey": "frontend-engineer", "confidence": 0.75, "reason": "..." }, "candidates": [...] }`

### `GET /agents/messages?projectId=&to=&from=&taskId=`
Read the inter-agent message bus — the conversation between your AI employees.

### `POST /agents/messages`
Inject a human message into the bus (the agent sees it on its next run).

```json
{ "projectId": "...", "to": "backend-engineer", "intent": "instruction",
  "message": "Use the existing RateLimiter in src/lib, don't add a new dependency." }
```

---

## Workflows

### `GET /workflows`
The catalogue with each workflow's step graph, dependencies, and which steps are conditional or gated.

### `POST /workflows/run`
Start an autonomous multi-agent run. **Long-running** — a feature-development run executes up to six agents.

| Field | Required | Notes |
|---|---|---|
| `projectId` | yes | Must be `ready` |
| `workflow` | yes | `feature-development` · `bug-fixing` · `code-review` |
| `request` | yes | The human request, in plain language |
| `startedBy` | no | |
| `autoRun` | no | `false` materialises the plan without executing (dry run) |

```bash
curl -X POST localhost:4000/api/workflows/run -H 'content-type: application/json' -d '{
  "projectId": "6789abc...",
  "workflow": "feature-development",
  "request": "Add a payment feature with Stripe: subscription checkout, payment history, invoice download."
}'
```

**201** → the run document (completed, or paused at an approval gate).

### `GET /workflows/runs?projectId=`
### `GET /workflows/runs/:id`
The run plus all tasks it created. Poll this while a run executes.

```json
{
  "run": {
    "workflow": "feature-development",
    "status": "completed",
    "request": "...",
    "steps": [
      { "id": "plan", "name": "Requirements & work breakdown", "agentKey": "project-manager",
        "status": "completed", "taskId": "...", "output": "...",
        "usage": { "inputTokens": 21044, "outputTokens": 2210, "toolCalls": 9 } },
      { "id": "frontend", "status": "skipped", "output": "(skipped: Skip condition met ...)" }
    ],
    "context": { "plan": "...", "design": "..." },
    "summary": "- Requirements & work breakdown (project-manager): completed\n..."
  },
  "tasks": [ ... ]
}
```

Step statuses: `pending` · `running` · `awaiting_approval` · `completed` · `skipped` · `failed`.

### `POST /workflows/runs/:id/approve`
Release a gated step and continue the run. Approval is **per step**.

```json
{ "stepId": "backend", "approvedBy": "alice" }
```

### `POST /workflows/runs/:id/resume`
Continue a paused or failed run (completed steps are not re-run).

### `POST /workflows/runs/:id/cancel`
`{ "reason": "requirements changed" }`

---

## Typical sequences

**Onboard and ship a feature**
```
POST /projects/connect            → projectId
GET  /projects/:id/memory         → confirm the detected profile looks right
POST /workflows/run               → runId  (feature-development)
GET  /workflows/runs/:runId       → poll until completed
GET  /tasks?projectId=            → review artifacts and diffs per task
```

**Run with approval gates on** (`REQUIRE_HUMAN_APPROVAL=true`)
```
POST /workflows/run               → 201, status "awaiting_approval"
GET  /workflows/runs/:runId       → find the step whose status is awaiting_approval
POST /workflows/runs/:runId/approve {"stepId":"backend"}
                                  → runs that step, pauses at the next gate
```

**Ask the organization a question without changing anything**
```
POST /agents/run  {"agentKey":"engineering-manager", "prompt":"..."}
```
