# Graph Report - .  (2026-09-21)

## Corpus Check
- 168 files · ~122,283 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1312 nodes · 3109 edges · 63 communities (55 shown, 8 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 47 edges (avg confidence: 0.82)
- Token cost: 124,808 input · 0 output

## Community Hubs (Navigation)
- Operator Console Dashboard
- Workflow Run Model
- Knowledge & Decision Memory
- Project Persistence
- Agent Runtime Core
- Task Model
- Project & Login Pages
- LLM Providers (Claude/Gemini)
- Pipeline & Task Board UI
- Express App & Middleware
- Agent Role Definitions
- API Controllers & Auth
- Code Search & Git Tools
- Repository Model & Discovery
- GitManager Operations
- Frontend Dependencies
- Missions Page & Shell
- Frontend TS Config
- Session & API Proxy Routes
- Agent & Message Models
- Backend TS Config
- Frontend API Client
- Platform Settings Service
- Workspace File Access
- Backend Runtime Deps
- Backend Dev Deps
- Deployment & Security Config
- Terminal Executor & Verification
- Agent Loop & Provider Registry
- Run Detail & Change Set UI
- Command Execution Env
- Execution Hardening Decisions
- Execution Registry & Cancellation
- Path Safety
- NPM Scripts
- Gemini Quota Limiter
- Workspace Package Detection
- Platform Overview & API
- Architecture Principles
- Multi-Agent UI Design
- Collaboration Tools
- Secret Path Redaction
- Permission Guard
- Backend Package Metadata
- Environment Config
- File Editor Tools
- Tool Input Validation
- Build TS Config
- Agent Roster & Feature Workflow
- CI Pipeline & Audit
- Safety Model
- Workflow Engine Concepts
- Next.js Auth Proxy
- pino-http
- Next Config
- Next Env Types
- Dependency Direction
- Bug Fixing Workflow
- Code Review Workflow

## God Nodes (most connected - your core abstractions)
1. `GitManager` - 38 edges
2. `Env` - 27 edges
3. `Logger` - 26 edges
4. `IWorkflowRun` - 25 edges
5. `Workspace` - 24 edges
6. `usePoll()` - 24 edges
7. `WorkflowEngine` - 23 edges
8. `ITask` - 21 edges
9. `WorkflowRunModel` - 21 edges
10. `WorkflowRunRepository` - 21 edges

## Surprising Connections (you probably didn't know these)
- `Safety Model (scoped writes, no shell, sandbox, approval gates)` --semantically_similar_to--> `Principle: Model Output Is Untrusted Input`  [INFERRED] [semantically similar]
  README.md → docs/ARCHITECTURE.md
- `AgentState Ten-State Model` --semantically_similar_to--> `AgentOutcome / StepOutcome / WorkflowOutcome`  [INFERRED] [semantically similar]
  skills/multi-agent-ui-design-SKILL.md → REMEDIATION.md
- `Production Hardening Path` --semantically_similar_to--> `Execution Defects E1-E8`  [INFERRED] [semantically similar]
  docs/ARCHITECTURE.md → SAAS_PRODUCT_AUDIT.md
- `Error Envelope (validation_error, permission_denied, ...)` --references--> `PermissionGuard`  [INFERRED]
  docs/API.md → README.md
- `PermissionGuard` --implements--> `Permissions in Definition: Read Broadly, Write Narrowly`  [INFERRED]
  README.md → docs/ARCHITECTURE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Feature Development Six-Role Agent Pipeline** — readme_project_manager_agent, readme_engineering_manager_agent, readme_backend_engineer_agent, readme_frontend_engineer_agent, readme_qa_engineer_agent, readme_documentation_engineer_agent [EXTRACTED 1.00]
- **Three Agent Communication Channels** — docs_architecture_workflow_context_threading, docs_architecture_message_bus, docs_architecture_long_term_memory [EXTRACTED 1.00]
- **Execution Correctness Remediations E1-E8** — remediation_durable_cancellation, remediation_outcome_enums, remediation_claim_for_execution, remediation_recover_orphaned_runs, remediation_with_project_lock, remediation_assert_execution_allowed, remediation_base_commit_pinning [EXTRACTED 1.00]

## Communities (63 total, 8 thin omitted)

### Community 0 - "Operator Console Dashboard"
Cohesion: 0.05
Nodes (54): LoginForm(), compact(), RosterCard(), RosterPage(), ACTIVE_RUN, Alert, ALERT_COLOR, buildAlerts() (+46 more)

### Community 1 - "Workflow Run Model"
Cohesion: 0.08
Nodes (20): ChangeSetSchema, IChangeSet, IWorkflowRun, StepOutcome, StepSchema, WorkflowOutcome, WorkflowRunModel, WorkflowRunSchema (+12 more)

### Community 2 - "Knowledge & Decision Memory"
Cohesion: 0.06
Nodes (24): DecisionModel, DecisionSchema, IDecision, IKnowledge, KnowledgeKind, KnowledgeModel, KnowledgeSchema, IProjectProfile (+16 more)

### Community 3 - "Project Persistence"
Cohesion: 0.06
Nodes (31): IProject, ProfileSchema, ProjectModel, ProjectSchema, ProjectStatus, ProjectRepository, GitHubClient, ANCILLARY_LANGUAGES (+23 more)

### Community 4 - "Agent Runtime Core"
Cohesion: 0.10
Nodes (25): AgentRuntime, AgentOutcome, RunAgentSchema, ConnectSchema, Env, IWorkflowStepState, CLAIMABLE_STATUSES, TERMINAL_STATUSES (+17 more)

### Community 5 - "Task Model"
Cohesion: 0.08
Nodes (20): AgentRunResult, ArtifactSchema, HistorySchema, ITask, ITaskArtifact, ITaskHistoryEntry, PRIORITY_RANK, priorityRankOf() (+12 more)

### Community 6 - "Project & Login Pages"
Cohesion: 0.10
Nodes (37): ProjectPage(), StandingOrders(), Tab, ProjectsPage(), SettingsForm(), SettingsPage(), ConnectProject(), MemoryExplorer() (+29 more)

### Community 7 - "LLM Providers (Claude/Gemini)"
Cohesion: 0.10
Nodes (23): ClaudeProvider, GeminiPart, GeminiProvider, GeminiResponse, SUPPORTED_SCHEMA_KEYS, OllamaChatResponse, OllamaMessage, OllamaProvider (+15 more)

### Community 8 - "Pipeline & Task Board UI"
Cohesion: 0.08
Nodes (36): PipelinePage(), StepDetail(), INTENT_STYLE, MessageFeed(), TaskBoard(), TaskDrawer(), Disclosure(), EmptyState() (+28 more)

### Community 9 - "Express App & Middleware"
Cohesion: 0.09
Nodes (21): errorHandler(), notFoundHandler(), httpLogger, requestId(), router, corsOptions(), createApp(), recoverOrphanedRuns() (+13 more)

### Community 10 - "Agent Role Definitions"
Cohesion: 0.12
Nodes (21): backendEngineer, documentationEngineer, engineeringManager, frontendEngineer, projectManager, qaEngineer, AgentRegistry, AgentDefinition (+13 more)

### Community 11 - "API Controllers & Auth"
Cohesion: 0.08
Nodes (26): agentController, healthController, projectController, CreateTaskSchema, taskController, StartSchema, workflowController, Actor (+18 more)

### Community 12 - "Code Search & Git Tools"
Cohesion: 0.08
Nodes (27): repoFor(), ToolBundleName, codeSearchTool, FindFilesInput, findFilesTool, SearchInput, CommitInput, commitTool (+19 more)

### Community 13 - "Repository Model & Discovery"
Cohesion: 0.13
Nodes (26): AgentPermissions, FileIndexEntrySchema, IRepository, RepositoryProvider, RepositorySchema, IRunRepoState, CloneOptions, RepoStatus (+18 more)

### Community 14 - "GitManager Operations"
Cohesion: 0.13
Nodes (3): GitManager, fixture(), patch()

### Community 15 - "Frontend Dependencies"
Cohesion: 0.06
Nodes (32): dependencies, motion, next, react, react-dom, devDependencies, tailwindcss, @tailwindcss/postcss (+24 more)

### Community 16 - "Missions Page & Shell"
Cohesion: 0.08
Nodes (17): metadata, Filter, FILTERS, LIVE, MissionsPage(), MissionStrip(), Connection, connectionOf() (+9 more)

### Community 17 - "Frontend TS Config"
Cohesion: 0.07
Nodes (27): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+19 more)

### Community 18 - "Session & API Proxy Routes"
Cohesion: 0.17
Nodes (24): attempts, DELETE(), POST(), tooManyAttempts(), BODYLESS_STATUSES, DELETE(), forward(), FORWARDED_RESPONSE_HEADERS (+16 more)

### Community 19 - "Agent & Message Models"
Cohesion: 0.14
Nodes (12): AgentModel, AgentSchema, IAgent, IAgentPermissions, PermissionsSchema, IMessage, MessageIntent, MessageModel (+4 more)

### Community 20 - "Backend TS Config"
Cohesion: 0.08
Nodes (24): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noImplicitOverride (+16 more)

### Community 21 - "Frontend API Client"
Cohesion: 0.11
Nodes (20): ApiError, ApiUnauthenticatedError, del(), get(), post(), request(), AgentOutcome, AgentPermissionsView (+12 more)

### Community 22 - "Platform Settings Service"
Cohesion: 0.17
Nodes (12): settingsController, IPlatformSettings, PlatformSettingsModel, PlatformSettingsSchema, mongoSettingsStore, SettingsService, SettingsStore, defaults (+4 more)

### Community 23 - "Workspace File Access"
Cohesion: 0.16
Nodes (10): BINARY_EXTENSIONS, compileSearchRegex(), Workspace, extractSymbols(), FileIndexer, IMPORTANT_PATTERNS, languageForExtension(), MANIFEST_FILES (+2 more)

### Community 24 - "Backend Runtime Deps"
Cohesion: 0.10
Nodes (21): @anthropic-ai/sdk, dependencies, @anthropic-ai/sdk, cors, dotenv, express, helmet, mongoose (+13 more)

### Community 25 - "Backend Dev Deps"
Cohesion: 0.11
Nodes (19): devDependencies, eslint, @eslint/js, pino-pretty, tsx, @types/cors, @types/express, @types/node (+11 more)

### Community 26 - "Deployment & Security Config"
Cohesion: 0.15
Nodes (17): Docker Compose Deployment, backend Service (aiec-backend), console Service (Next.js frontend), mongo Service (MongoDB 7, auth enabled), argv Command Interface, shell:false, MongoDB Collections (projects, repositories, agents, tasks, messages, knowledge, decisions, workflow_runs), Mongoose over Native Driver, Admission Limits (rate limiting, MAX_CONCURRENT_RUNS, RUN_DEADLINE_MS) (+9 more)

### Community 27 - "Terminal Executor & Verification"
Cohesion: 0.21
Nodes (10): DEFAULT_IGNORES, TerminalExecutor, wrapInSandbox(), RunCommandInput, runCommandTool, exists(), looksLikeVerification(), prepareVerification() (+2 more)

### Community 28 - "Agent Loop & Provider Registry"
Cohesion: 0.23
Nodes (11): AgentRunInput, SUCCESSFUL_OUTCOMES, isDatabaseHealthy(), configuredProviders(), effectiveProviderName(), isProviderConfigured(), isProviderName(), providerModel() (+3 more)

### Community 29 - "Run Detail & Change Set UI"
Cohesion: 0.17
Nodes (9): runVisualState(), formatElapsed(), LIVE_STATUSES, RunHeader(), RunPage(), TERMINAL_STATUSES, ChangeSetPanel(), useElapsed() (+1 more)

### Community 30 - "Command Execution Env"
Cohesion: 0.15
Nodes (11): WalkEntry, WalkOptions, CommandResult, INHERITED_ENV_KEYS, resolveWindowsCommand(), RunOptions, files, lookup (+3 more)

### Community 31 - "Execution Hardening Decisions"
Cohesion: 0.16
Nodes (15): POST /agents/run (direct agent invocation), AgentRuntime Hand-written Agent Loop, Production Hardening Path, Sequential Steps (shared git working tree), assertExecutionAllowed Shared Policy, Immutable baseCommit + Pre-commit Staged Diff, claimForExecution Atomic Claim + Run Lease, Durable Cancellation with AbortSignal (+7 more)

### Community 33 - "Path Safety"
Cohesion: 0.35
Nodes (9): canonicalRelative(), isInside(), matchesAnyGlob(), matchesGlob(), PathEscapeError, resolveInside(), stripLeadingSlash(), toPosix() (+1 more)

### Community 34 - "NPM Scripts"
Cohesion: 0.18
Nodes (11): scripts, build, dev, lint, lint:fix, seed:agents, start, test (+3 more)

### Community 35 - "Gemini Quota Limiter"
Cohesion: 0.25
Nodes (3): GeminiQuotaLimiter, GeminiQuotaReservation, Reservation

### Community 36 - "Workspace Package Detection"
Cohesion: 0.29
Nodes (10): BACKEND_MARKERS, classify(), classifyPackageJson(), describePackages(), detectPackages(), FRONTEND_MARKERS, MANIFESTS, packageFor() (+2 more)

### Community 37 - "Platform Overview & API"
Cohesion: 0.24
Nodes (11): API Reference, GET /health/ready Readiness, POST /projects/connect, Tasks Endpoints (/tasks, run, approve, run-ready), Principle: Platform Knows Nothing About Any Codebase, Deterministic Task Routing (task-router), README: AI Engineering Company, Reusable Multi-Agent Engineering Platform (+3 more)

### Community 38 - "Architecture Principles"
Cohesion: 0.18
Nodes (11): Agent Messages Endpoints (/agents/messages), Architecture Document, bundles.ts Leaf Module (breaks import cycle), ContextBuilder (cached system prompt / user message split), Channel 3: Long-term Memory (remember, record_decision), Channel 2: Inter-agent Message Bus, Principle: Every Layer Is a Registry, Principle: Retrieval, Not Stuffing (+3 more)

### Community 39 - "Multi-Agent UI Design"
Cohesion: 0.25
Nodes (11): Full-viewport HUD Workspace Interface (agents as actors), AgentOutcome / StepOutcome / WorkflowOutcome, usePoll / useAction Frontend Hooks, Multi-Agent UI Design Skill, Accessibility (reduced motion, not color alone), AgentState Ten-State Model, Agents as Actors / Living Computational Environment, Data Flow Visualization (packets by payload kind) (+3 more)

### Community 40 - "Collaboration Tools"
Cohesion: 0.24
Nodes (9): TaskPriority, TaskType, CreateTaskInput, createTaskTool, reportCompletionTool, ReportInput, SendMessageInput, sendMessageTool (+1 more)

### Community 41 - "Secret Path Redaction"
Cohesion: 0.27
Nodes (6): isSecretPath(), REDACTION_PATTERNS, redactSecrets(), SECRET_GLOBS, TEMPLATE_GLOBS, withoutSecretPaths()

### Community 43 - "Backend Package Metadata"
Cohesion: 0.25
Nodes (7): description, engines, node, main, name, private, version

### Community 44 - "Environment Config"
Cohesion: 0.39
Nodes (4): assertProductionSafety(), EnvSchema, load(), resolveWorkspaceRoot()

### Community 45 - "File Editor Tools"
Cohesion: 0.29
Nodes (6): DeleteFileInput, deleteFileTool, EditFileInput, editFileTool, WriteFileInput, writeFileTool

### Community 46 - "Tool Input Validation"
Cohesion: 0.32
Nodes (7): checkValue(), describe(), JsonSchema, PropertySchema, validateToolInput(), ValidationFailure, ValidationSuccess

### Community 47 - "Build TS Config"
Cohesion: 0.25
Nodes (7): exclude, extends, dist, node_modules, src/**/*.test.ts, src/**/__tests__/**, ./tsconfig.json

### Community 48 - "Agent Roster & Feature Workflow"
Cohesion: 0.29
Nodes (8): Permissions in Definition: Read Broadly, Write Narrowly, Backend Engineer Agent, Documentation Engineer Agent, Engineering Manager Agent, Feature Development Workflow, Frontend Engineer Agent, Project Manager Agent, QA Engineer Agent

### Community 49 - "CI Pipeline & Audit"
Cohesion: 0.29
Nodes (7): CI Workflow (ci.yml), CI Dependency Audit Job (weekly, prod deps), CI Backend Job (lint, typecheck, test, build), CI Frontend Job (typecheck, build), Remediation Pass Report, Release Assurance Gap (no tests, no CI), S12 Dependency Advisories (Next.js RCE)

### Community 50 - "Safety Model"
Cohesion: 0.47
Nodes (6): Error Envelope (validation_error, permission_denied, ...), Principle: Model Output Is Untrusted Input, PermissionGuard, Safety Model (scoped writes, no shell, sandbox, approval gates), canonicalRelative() Path Collapsing, S4 PermissionGuard Uncollapsed Path Bypass

### Community 51 - "Workflow Engine Concepts"
Cohesion: 0.40
Nodes (5): POST /workflows/run and run lifecycle (approve/resume/cancel), Channel 1: Workflow Context Threading, WorkflowEngine, Workflows Are Data (WorkflowStep), REQUIRE_HUMAN_APPROVAL Approval Gates

### Community 52 - "Next.js Auth Proxy"
Cohesion: 0.67
Nodes (3): config, proxy(), PUBLIC_PATHS

## Knowledge Gaps
- **288 isolated node(s):** `name`, `version`, `private`, `description`, `main` (+283 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `fixture()` connect `GitManager Operations` to `Agent Runtime Core`?**
  _High betweenness centrality (0.127) - this node is a cross-community bridge._
- **Why does `patch()` connect `GitManager Operations` to `Frontend API Client`?**
  _High betweenness centrality (0.126) - this node is a cross-community bridge._
- **Why does `GeminiQuotaLimiter` connect `Gemini Quota Limiter` to `LLM Providers (Claude/Gemini)`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _288 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Operator Console Dashboard` be split into smaller, more focused modules?**
  _Cohesion score 0.05333333333333334 - nodes in this community are weakly interconnected._
- **Should `Workflow Run Model` be split into smaller, more focused modules?**
  _Cohesion score 0.07667900581702802 - nodes in this community are weakly interconnected._
- **Should `Knowledge & Decision Memory` be split into smaller, more focused modules?**
  _Cohesion score 0.062146892655367235 - nodes in this community are weakly interconnected._