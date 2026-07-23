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
 */
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
  AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().default(12),

  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-pro'),

  // Local Ollama server — no key required. See services/llm/ollama-client.ts.
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen3.6'),

  GITHUB_TOKEN: z.string().optional().default(''),
  GIT_AUTHOR_NAME: z.string().default('AI Engineering Company'),
  GIT_AUTHOR_EMAIL: z.string().default('bots@ai-engineering-company.local'),

  WORKSPACE_ROOT: z.string().default('./workspaces'),
  MAX_FILE_BYTES: z.coerce.number().int().positive().default(524_288),
  TERMINAL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  TERMINAL_MAX_OUTPUT: z.coerce.number().int().positive().default(65_536),

  REQUIRE_HUMAN_APPROVAL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PLATFORM_API_KEY: z.string().optional().default(''),
});

export type Env = z.infer<typeof EnvSchema> & { WORKSPACE_ROOT_ABS: string };

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Intentionally not using the logger: it depends on config.
    // eslint-disable-next-line no-console
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
    // eslint-disable-next-line no-console
    console.warn(
      'No paid LLM provider configured — falling back to Ollama for every call.\n' +
        '  Set CLAUDE_API_KEY and/or GEMINI_API_KEY in backend/.env to use them instead.\n' +
        '  Select the default with LLM_PROVIDER=claude|gemini|ollama\n',
    );
  }

  return {
    ...value,
    WORKSPACE_ROOT_ABS: path.resolve(process.cwd(), value.WORKSPACE_ROOT),
  };
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';
