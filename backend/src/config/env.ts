import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Environment schema.
 *
 * Design decision: the process refuses to boot on an invalid environment.
 * A multi-agent platform that can write to repositories must never start in a
 * half-configured state (e.g. missing workspace root, missing DB) and discover
 * it mid-workflow, when an agent already has a half-applied change on disk.
 *
 * The same principle now covers *security* configuration, not just operational
 * configuration: `assertProductionSafety` below refuses to boot a production
 * process that is missing an API key, has no CORS allowlist, or would run agent
 * commands unsandboxed. The audit's S1 finding was that an unset
 * `PLATFORM_API_KEY` silently disabled authentication in production — the worst
 * possible failure mode, because nothing about it is visible until someone finds
 * the open API.
 */

/** `true`/`false` string flag → boolean, so .env files stay readable. */
function boolFlag(fallback: boolean) {
  return z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true');
}

/** Comma-separated list → trimmed, non-empty string array. */
function csvList(fallback: string[]) {
  return z
    .string()
    .default(fallback.join(','))
    .transform((v) =>
      v
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    );
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  MONGODB_URI: z.string().min(1),

  // Which provider agents use by default. Individual agents and individual API
  // calls can override it; see services/llm/provider-registry.ts.
  LLM_PROVIDER: z.enum(['claude', 'gemini', 'ollama']).default('claude'),

  // At least one provider key must be present — validated after parsing, since
  // either one alone is a valid configuration.
  CLAUDE_API_KEY: z.string().default(''),
  CLAUDE_MODEL: z.string().default('claude-opus-4-8'),
  CLAUDE_FAST_MODEL: z.string().default('claude-haiku-4-5'),
  CLAUDE_EFFORT: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .default('high'),
  CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().default(16000),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().default(24),
  WORKFLOW_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),

  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-pro'),
  GEMINI_RPM_LIMIT: z.coerce.number().int().positive().default(30),
  GEMINI_TPM_LIMIT: z.coerce.number().int().positive().default(16_000),

  // Local Ollama server — no key required. See services/llm/ollama-client.ts.
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen3.6'),

  GITHUB_TOKEN: z.string().optional().default(''),
  GIT_AUTHOR_NAME: z.string().default('AI Engineering Company'),
  GIT_AUTHOR_EMAIL: z.string().default('bots@ai-engineering-company.local'),

  // Relative paths are anchored to the backend directory, regardless of the
  // directory from which the API process was launched.
  WORKSPACE_ROOT: z.string().default('./workspaces'),
  MAX_FILE_BYTES: z.coerce.number().int().positive().default(524_288),
  TERMINAL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  TERMINAL_MAX_OUTPUT: z.coerce.number().int().positive().default(65_536),

  REQUIRE_HUMAN_APPROVAL: boolFlag(false),
  PLATFORM_API_KEY: z.string().optional().default(''),
  /**
   * When a run ends, push its `aiec/...` branch into the project's own
   * repositories (the original folder for a local import, `origin` for GitHub),
   * so the work can be checked out and tested there. Only a branch ref is
   * written; the target's working tree and checked-out branch are never touched.
   */
  PUBLISH_RUN_BRANCHES: boolFlag(true),

  // --- Access control ------------------------------------------------------
  /**
   * Exact origins allowed to call the API with credentials. Reflective CORS
   * (`origin: true`) echoes whatever Origin the caller sends, which is not an
   * allowlist at all (audit finding S10).
   */
  CORS_ALLOWED_ORIGINS: csvList([]),
  /** Requests per window per client, applied before any expensive work (S9). */
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(240),
  /** Separate, much tighter budget for endpoints that start model work. */
  RATE_LIMIT_MAX_RUNS: z.coerce.number().int().positive().default(20),

  // --- Execution limits ----------------------------------------------------
  /** Concurrently executing workflow runs across the whole process. */
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(3),
  /** Concurrent runs for any single project. Above 1 needs isolated checkouts. */
  MAX_CONCURRENT_RUNS_PER_PROJECT: z.coerce.number().int().positive().default(1),
  /** Wall-clock ceiling for one workflow run, after which it is cancelled (E1). */
  RUN_DEADLINE_MS: z.coerce.number().int().positive().default(3_600_000),
  /** A run whose lease is older than this is treated as crashed and recovered (E4). */
  RUN_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),

  // --- Repository import ---------------------------------------------------
  /** Hosts a repository may be cloned from. First entry is the default (S6). */
  GIT_ALLOWED_HOSTS: csvList(['github.com']),
  /**
   * Server-local directory import. Convenient for air-gapped evaluation and
   * completely inappropriate for a hosted deployment, where it lets any caller
   * copy arbitrary server directories into a workspace an agent can read.
   */
  ALLOW_LOCAL_PATH_IMPORT: boolFlag(true),
  /** When local import is enabled, restrict it to directories under these roots. */
  LOCAL_IMPORT_ROOTS: csvList([]),
  /** Refuse to index a checkout larger than this (bounds document growth + cost). */
  MAX_REPOSITORY_BYTES: z.coerce.number().int().positive().default(1_073_741_824),
  /** Cap on persisted file-index entries, so a repository document stays well under 16 MiB. */
  MAX_INDEXED_FILES: z.coerce.number().int().positive().default(20_000),

  // --- Command isolation ---------------------------------------------------
  /**
   * argv template that every agent command is executed through, e.g.
   * `docker run --rm --network none -v {cwd}:/w -w /w node:22-alpine`.
   * Empty means commands run directly in the API host (see S2).
   */
  TERMINAL_SANDBOX_COMMAND: z.string().default(''),
  /** Explicit acknowledgement required to run unsandboxed commands in production. */
  ALLOW_UNSANDBOXED_COMMANDS: boolFlag(false),
});

export type Env = z.infer<typeof EnvSchema> & { WORKSPACE_ROOT_ABS: string };

/**
 * Resolve relative workspace paths from the backend installation, not from the
 * shell's current directory. The API is often started from the repository root
 * (`npm --prefix backend run dev`) or from `backend`; both must use the same
 * checkout tree.
 */
export function resolveWorkspaceRoot(
  configuredRoot: string,
  backendRoot = path.resolve(__dirname, '../..'),
): string {
  return path.resolve(backendRoot, configuredRoot);
}

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Intentionally not using the logger: it depends on config.
     
    console.error(`Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  const value = parsed.data;

  // The platform is useless without at least one usable model provider, so this
  // would be a boot-time failure — except Ollama needs no key and is always
  // "configured" (see services/llm/provider-registry.ts), so there is always a
  // usable fallback. Whether the Ollama server is actually reachable is a
  // runtime concern, same as a wrong Claude/Gemini key isn't caught until the
  // first call either.
  const hasClaude = value.CLAUDE_API_KEY && value.CLAUDE_API_KEY !== 'PASTE_API_KEY_HERE';
  const hasGemini = value.GEMINI_API_KEY && value.GEMINI_API_KEY !== 'PASTE_GEMINI_KEY_HERE';
  if (!hasClaude && !hasGemini) {
     
    console.warn(
      'No paid LLM provider configured — falling back to Ollama for every call.\n' +
        '  Set CLAUDE_API_KEY and/or GEMINI_API_KEY in backend/.env to use them instead.\n' +
        '  Select the default with LLM_PROVIDER=claude|gemini|ollama\n',
    );
  }

  const resolved: Env = {
    ...value,
    WORKSPACE_ROOT_ABS: resolveWorkspaceRoot(value.WORKSPACE_ROOT),
  };

  assertProductionSafety(resolved);
  return resolved;
}

/**
 * Refuse to boot a production process in an unsafe configuration.
 *
 * Every item here is a control whose absence is invisible at runtime: nothing
 * about an unauthenticated API looks broken until it is abused. Failing at boot
 * turns each into a deployment error the operator must answer, and each has an
 * explicit opt-out for the cases where an external control genuinely provides
 * the same guarantee.
 */
export function assertProductionSafety(value: Env): void {
  if (value.NODE_ENV !== 'production') return;
  const problems: string[] = [];

  if (!value.PLATFORM_API_KEY || value.PLATFORM_API_KEY.length < 32) {
    problems.push(
      'PLATFORM_API_KEY must be set to at least 32 random characters in production. ' +
        'Without it the API — which can write to repositories and open pull requests — is open ' +
        'to anyone who can reach it. Generate one with: openssl rand -hex 32',
    );
  }
  if (!value.CORS_ALLOWED_ORIGINS.length) {
    problems.push(
      'CORS_ALLOWED_ORIGINS must list the exact origins allowed to call this API in production ' +
        '(e.g. https://app.example.com). Set it to "none" if the backend is private and browsers ' +
        'never call it directly.',
    );
  }
  if (!value.TERMINAL_SANDBOX_COMMAND && !value.ALLOW_UNSANDBOXED_COMMANDS) {
    problems.push(
      'Agent commands would run directly in this API host, sharing its user, filesystem, network ' +
        'and credentials with untrusted repository code. Set TERMINAL_SANDBOX_COMMAND to an ' +
        'isolation wrapper, or set ALLOW_UNSANDBOXED_COMMANDS=true to accept that risk explicitly.',
    );
  }
  if (value.ALLOW_LOCAL_PATH_IMPORT && !value.LOCAL_IMPORT_ROOTS.length) {
    problems.push(
      'ALLOW_LOCAL_PATH_IMPORT lets any caller copy an arbitrary server directory into an ' +
        'agent-readable workspace. Set ALLOW_LOCAL_PATH_IMPORT=false for hosted deployments, or ' +
        'restrict it with LOCAL_IMPORT_ROOTS.',
    );
  }
  if (value.MAX_CONCURRENT_RUNS_PER_PROJECT > 1) {
    problems.push(
      'MAX_CONCURRENT_RUNS_PER_PROJECT > 1 requires one isolated checkout per run. The platform ' +
        'currently shares a single checkout per project, so concurrent runs would corrupt each ' +
        "other's working tree.",
    );
  }

  if (problems.length) {
     
    console.error(
      `Refusing to start in production with an unsafe configuration:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n\n')}\n`,
    );
    process.exit(1);
  }
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';
