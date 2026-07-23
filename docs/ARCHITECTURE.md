# Architecture

This document explains the structure, the database schema, the agent communication flow, and — most importantly — **why** each major decision was made.

---

## 1. Design principles

Five constraints shaped everything else.

**1. The platform must know nothing about any specific codebase.**
Every project-specific fact is *detected* at onboarding and stored as data. There is no branch anywhere in the code that says "if this is a React project". This is what makes it reusable across languages and stacks, and it is why the profile is a data structure injected into prompts rather than logic.

**2. Never send a repository to the model.**
Retrieval, not stuffing. Each task gets the project profile, the binding decisions, the top-N relevant memories, and a *shortlist of file paths* — then the agent fetches file contents on demand through tools. A 400-file repository costs the same prompt as a 40-file one.

**3. Model output is untrusted input.**
Permissions, path sandboxing and command allowlists are enforced in code, at a single choke point, before any effect reaches the filesystem or the network. Prompt instructions are guidance; the guard is the control.

**4. State lives in the database, not in a process.**
Workflow runs, tasks and inter-agent messages are persisted after every step. A run survives a restart, can be inspected mid-flight by a human, and can be resumed after an approval gate. An in-memory orchestrator cannot do any of that.

**5. Every layer is a registry.**
Agents, tools and workflows are all "define an object, register it". Adding a role, a capability or a process is additive — no existing layer changes.

---

## 2. Folder structure

```
backend/src/
├── config/env.ts               Zod-validated environment. Process refuses to boot if invalid.
│
├── agents/                     WHO does the work
│   ├── types.ts                AgentDefinition + AgentPermissions + the always-denied secret globs
│   ├── definitions/            One file per role. Prompts + tools + permissions, in code review.
│   ├── registry.ts             Roster
│   └── agent-runtime.ts        THE agentic loop (shared by every role)
│
├── tools/                      WHAT agents can do
│   ├── types.ts                Tool interface + ToolContext (capabilities passed explicitly)
│   ├── permission-guard.ts     THE authorization choke point
│   ├── bundles.ts              Named tool sets (leaf module — breaks an import cycle)
│   ├── registry.ts             Name → implementation, and JSON-schema rendering
│   └── *.tool.ts               repository-reader, code-search, file-editor, terminal, git,
│                               memory, collaboration
│
├── memory/                     WHAT the organization knows
│   ├── project-memory.ts       Write side: seed from onboarding, record changes/issues
│   ├── knowledge-retrieval.ts  Read side: rank knowledge + files against a task
│   └── context-builder.ts      Prompt assembly (system vs user split = cache strategy)
│
├── orchestrator/               WHO gets which work
│   ├── task-router.ts          Deterministic task → agent routing, with an explanation
│   └── agent-coordinator.ts    Executes a task, records the outcome, feeds memory
│
├── workflows/                  HOW multi-agent processes run
│   ├── types.ts                Declarative step model + template renderer
│   ├── engine.ts               Execution, dependencies, skip logic, approval gates, resume
│   └── *.workflow.ts           feature-development, bug-fixing, code-review
│
├── integrations/               THE OUTSIDE WORLD
│   ├── filesystem/workspace.ts Sandboxed FS: walk, read, write, search
│   ├── terminal/executor.ts    shell:false command execution with allowlist + scrubbed env
│   └── github/                 git-manager (local git) + github-client (Octokit/PRs)
│
├── services/
│   ├── llm/                    Provider-agnostic types + the Claude implementation
│   └── onboarding/             detectors · file-indexer · onboarding.service
│
├── database/
│   ├── models/                 Mongoose schemas
│   └── repositories/           The only code that touches models
│
├── api/                        routes · controllers · middleware
├── bootstrap/                  Boot-time cross-registry validation
├── app.ts / server.ts
└── utils/                      logger · errors · path-safety · text
```

### Why this split

The dependency direction is strictly inward: `api → orchestrator/workflows → agents → tools → integrations`, with `database` and `utils` as leaves. Nothing in `agents/` imports Express; nothing in `tools/` imports Mongoose models directly. That is what makes the agent layer testable without a server and the whole platform embeddable as a library later.

---

## 3. Database schema

Seven collections. MongoDB is a good fit here specifically because agent output is semi-structured and evolves: task artifacts, tool payloads and knowledge entries do not have a stable column shape.

### Why Mongoose over the native driver

Chosen deliberately, and it is a real trade-off.

**Mongoose gives us:**
- **Schema validation at the boundary.** Agent-generated data (task results, knowledge entries, artifacts) is written by an LLM-driven loop. Mongoose rejects a malformed enum value or missing required field at write time rather than storing it and failing on read three steps later.
- **Declarative indexes next to the schema**, including the weighted text index that powers retrieval — the retrieval strategy is legible in the model file.
- **Typed documents** that line up with the `I*` interfaces, so `lean<IProject>()` gives real compile-time safety in the repository layer.
- **Middleware/discriminator hooks** for the audit-trail behaviour we already rely on.

**The cost:** a hydration layer we do not always need. Mitigated by using `.lean()` on every read path — we get plain objects at near-driver speed and keep validation on writes, which is where it matters.

**When to switch:** if a future analytics workload needs raw aggregation throughput, that would live in a separate read path against the native driver. The repository layer is the seam that makes it possible without touching agents.

### Collections

**`projects`** — the tenant boundary. Holds the detected `profile` (languages, frameworks, architecture, database, testing, deployment, conventions, build/test commands) plus operator `customInstructions`. The profile is injected into every agent's system prompt.

**`repositories`** — the VCS side: provider, URL, branches, head commit, clone path, and `fileIndex[]`. Each index entry is `{path, language, bytes, lines, summary, symbols[], important, hash}`. This index is the backbone of retrieval; it is projected separately on read because it can be thousands of entries.

**`agents`** — a *mirror* of the code-defined roster plus usage stats and optional per-project overrides. Definitions stay in code: prompts and permissions are behaviour and belong in version control and code review, not in a mutable row.

**`tasks`** — unit of work. `status` (9 states), `priority`, `assignedTo` (agent key), `dependsOn[]`, `acceptanceCriteria[]`, `result`, `artifacts[]`, `history[]`, `attempts`. Every status transition appends to `history` with actor and note — an autonomous system is only debuggable if you can reconstruct what happened.

**`messages`** — the inter-agent bus. `{projectId, taskId, from, to, intent, message, payload, readAt}`.

**`knowledge`** — long-term memory. `{kind, title, content, tags[], paths[], source, confidence, supersededBy}` with a **weighted text index** (`title` ×10, `tags` ×5, `content` ×1).

**`decisions`** — ADRs. Separate from `knowledge` because they are append-only, carry rationale + alternatives, and are injected into context *unconditionally* — a later agent must not silently contradict them.

**`workflow_runs`** — the durable state machine: per-step status, task id, output, usage, plus a `context` map threading step outputs into later prompts.

### Index strategy

| Collection | Index | Why |
|---|---|---|
| `knowledge` | text: title/content/tags (weighted) | Ranked retrieval without a vector store |
| `knowledge` | `{projectId, kind, updatedAt}` | Category browse + recency |
| `tasks` | `{projectId, status, priority}` | The runnable-task query |
| `messages` | `{to, readAt}` | Unread inbox per agent |
| `projects` | `{name}` unique | Prevents duplicate connections |
| `agents` | `{key, projectId}` unique | One global + one override per project |

---

## 4. Agent communication flow

Agents never call each other directly. Three distinct channels, each with a different purpose:

### Channel 1 — Workflow context threading (synchronous, engine-mediated)

The primary path. Each step's output is stored in `workflow_runs.context[stepId]` and interpolated into later prompts via `{{steps.<id>}}`.

```
Engineering Manager output ──► run.context.design ──► "{{steps.design}}" in the backend prompt
```

This is how the technical plan reaches the engineers. It is synchronous, ordered, and durable.

### Channel 2 — The message bus (asynchronous, persisted)

For anything off the happy path: clarifications, handoffs, review results, escalations. An agent calls `send_message(to, intent, message)`; it lands in `messages`; the recipient sees it in their **next** prompt (`ContextBuilder` pulls unread messages addressed to them and marks them read).

```
frontend-engineer ──send_message(to: backend-engineer, intent: handoff)──► messages
                                                                              │
                                     next backend-engineer run ◄──────────────┘
                                     ("# Messages addressed to you")
```

Agents do not block waiting for a reply — a blocking request/response between two LLM agents deadlocks the moment one of them decides not to answer. `intent: "escalation"` addressed to `human` is the defined path for "I need a decision I am not authorised to make", and it surfaces in `GET /agents/messages`.

### Channel 3 — Long-term memory (cross-run, retrieval-based)

The slow channel, and the one that compounds. An agent writes a durable fact with `remember(kind, title, content)` or `record_decision(...)`; months later a different agent working on a different task retrieves it because it matched the task text. This is what makes the organization accumulate institutional knowledge rather than restarting cold every run.

### Full flow for one workflow step

```
WorkflowEngine
  ├─ renders prompt template with prior step outputs
  ├─ creates a Task (so the step is inspectable exactly like a manual task)
  └─ AgentRuntime.run(agentKey)
       ├─ ContextBuilder.buildSystemPrompt   ← agent instructions + project profile   [CACHED]
       ├─ ContextBuilder.buildUserMessage    ← decisions + memory + file shortlist
       │                                       + dependency results + inbox + instruction
       └─ loop (max N iterations):
            ├─ Claude ──► stop_reason
            │    ├─ tool_use   → execute each tool
            │    │                 ├─ PermissionGuard check  ─┐ denial → is_error result
            │    │                 ├─ execute                 │ (agent adapts, run continues)
            │    │                 └─ record artifact ────────┘
            │    │                → all results in ONE user message → continue
            │    ├─ end_turn   → done
            │    ├─ pause_turn → re-send with assistant turn appended
            │    ├─ refusal    → stop, surface to operator (do not retry verbatim)
            │    └─ max_tokens → stop, report truncation honestly
            └─ report_completion → structured verdict {completed|blocked|needs_review}
  ├─ persists step output → run.context[stepId]
  ├─ transitions the Task, records the change in project memory
  └─ next step
```

---

## 5. Key decisions, and why

### Why a hand-written agent loop instead of the SDK tool runner

The SDK's tool runner is the right default for a plain custom-tool agent. This platform needs three things per turn that sit outside its per-turn hooks:

1. every tool call is permission-checked **and persisted as a task artifact** before its result returns to the model;
2. a denied or failed call must come back as a recoverable `is_error` result *and* be logged as a policy event for the operator;
3. the loop is one step of a database-backed, resumable workflow, so iteration state must be observable from outside the process.

Owning the loop costs ~80 lines and buys all three. It is one file (`agents/agent-runtime.ts`) shared by every role.

### Why permissions are in the definition, not the call site

An agent's blast radius should be reviewable in one file. `frontend-engineer.ts` says, in the same object as its prompt, that it may write `src/components/**` and may not write `Dockerfile`. Reviewing "what can this role break?" is reading one file, not tracing call sites.

### Why the frontend agent has repo-wide *read* access but scoped *write* access

It must read the backend contract to integrate correctly — an agent that can't read the API invents one. But letting it *write* server code is how you get a UI engineer "fixing" an endpoint to match its assumptions. Read broadly, write narrowly.

### Why QA can write tests but not implementation

An agent that can "fix" the code it is reviewing will fix the test to match the bug roughly as often as it fixes the bug. Findings go back to the owning engineer as a message.

### Why routing is deterministic, not an LLM call

Routing runs on every task, must be predictable, and must be explainable ("why did the frontend agent get this?"). It is a two-stage function: explicit task-type mapping first, capability scoring only for genuinely ambiguous types — and it returns a `reason` string with every decision.

### Why the system/user prompt split is what it is

`system` holds only what is **stable across every step of a workflow** (agent instructions + project profile + operator overrides) and is sent as a single cached block. Task-specific content goes in the user message, where changing it costs nothing. From the second call onward, the expensive prefix is served from cache. Putting the profile in the user message would silently double the cost of every run.

### Why workflows are data, not code

`WorkflowStep` is `{id, agentKey, prompt, dependsOn, skipWhen, requiresApproval}`. All the imperative logic — retries, gates, persistence, context threading — lives once in the engine. Adding "hotfix" or "security-audit" is a new data file that the engine, API and any UI pick up unchanged.

### Why steps run sequentially

Steps in a run share one git working tree. Two agents editing it concurrently corrupt each other's work. Parallelism belongs across projects, not within a run. (`AgentCoordinator.runReadyTasks` is sequential for the same reason.)

### Why the tool interface is `command + args[]`, never a shell string

`shell: false` with an argv array makes command chaining structurally impossible — `;`, `&&`, backticks and `$( )` have no meaning. A blocklist of "dangerous commands" is trivially bypassable; an allowlist plus no shell is not.

### Why `bundles.ts` exists as a separate leaf module

Agent definitions need tool bundle names; some tools (`create_task`, `send_message`) validate their arguments against the agent registry. That is an import cycle: `tools/registry → collaboration.tool → agents/registry → definitions → tools/registry`, evaluated before `TOOL_BUNDLES` exists. Extracting the bundles into a zero-import leaf breaks the cycle at its narrowest point, and the agent↔tool cross-check moved to `bootstrap/validate-registries.ts`, which runs after all modules have loaded. (This was caught by a smoke test, not by the type checker — module load order is not something TypeScript checks.)

---

## 6. Production hardening path

The platform is structured so each of these is a contained change:

| Concern | Current state | Path |
|---|---|---|
| Task concurrency | Single-process status guard | `findOneAndUpdate` compare-and-set in `AgentCoordinator.runTask` — one method |
| Long HTTP requests | Workflow runs execute in-request | Move `workflowEngine.execute` behind a queue (BullMQ); the run document is already the state machine |
| Auth | Optional shared secret | Replace `api/middleware/auth.ts` with tenant auth; projects are already the tenant boundary |
| Retrieval quality | Weighted Mongo text index | Implement `KnowledgeRepository.search()` against embeddings — one method, no agent changes |
| Multi-tenant isolation | One workspace dir per project | Per-tenant container/VM for the terminal tool |
| Cost controls | Per-agent effort + tool-call caps | Add per-project token budgets in the runtime's usage accounting |
