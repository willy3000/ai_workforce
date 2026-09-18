import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { claudeProvider } from './claude-client';
import { geminiProvider } from './gemini-client';
import { ollamaProvider } from './ollama-client';
import type { LlmProvider } from './types';

/**
 * Provider selection.
 *
 * Resolution order, most specific first:
 *   1. an explicit `provider` on the API call (per-run override)
 *   2. the agent definition's `provider` (e.g. run QA on a second opinion)
 *   3. `LLM_PROVIDER` in the environment (the platform default)
 *
 * Keeping this in one function means "which model answered?" is always
 * answerable, and switching providers never requires touching an agent.
 */
export type ProviderName = 'claude' | 'gemini' | 'ollama';

const PROVIDERS: Record<ProviderName, LlmProvider> = {
  claude: claudeProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
};

export function isProviderName(value: string): value is ProviderName {
  return value === 'claude' || value === 'gemini' || value === 'ollama';
}

/** True when the provider has a key configured and can actually be called. */
export function isProviderConfigured(name: ProviderName): boolean {
  if (name === 'claude') {
    return Boolean(env.CLAUDE_API_KEY) && env.CLAUDE_API_KEY !== 'PASTE_API_KEY_HERE';
  }
  if (name === 'gemini') {
    return Boolean(env.GEMINI_API_KEY) && env.GEMINI_API_KEY !== 'PASTE_GEMINI_KEY_HERE';
  }
  // Ollama is a local/LAN server, not a keyed API — always considered
  // configured. If it's unreachable, that surfaces as a ProviderError on the
  // first call, same as any other provider's runtime failures.
  return true;
}

export function configuredProviders(): ProviderName[] {
  return (Object.keys(PROVIDERS) as ProviderName[]).filter(isProviderConfigured);
}

/**
 * Resolve a provider, falling back to any configured one if the requested
 * default has no key. The fallback is logged loudly — silently answering with a
 * different model than the operator configured would be worse than failing.
 */
export function resolveProvider(preferred?: string): LlmProvider {
  const requested = preferred ?? env.LLM_PROVIDER;

  if (!isProviderName(requested)) {
    throw new AppError(
      `Unknown LLM provider '${requested}'. Valid: ${Object.keys(PROVIDERS).join(', ')}`,
      400,
      'unknown_provider',
    );
  }

  if (isProviderConfigured(requested)) return PROVIDERS[requested];

  const alternatives = configuredProviders();
  if (!alternatives.length) {
    throw new AppError(
      `No LLM provider is configured. Set CLAUDE_API_KEY or GEMINI_API_KEY in backend/.env.`,
      503,
      'no_provider_configured',
    );
  }

  const fallback = alternatives[0];
  logger.warn(
    { requested, fallback },
    `LLM provider '${requested}' has no API key configured — falling back to '${fallback}'`,
  );
  return PROVIDERS[fallback];
}

/** Which provider a given preference would actually resolve to. For the UI. */
export function effectiveProviderName(preferred?: string): ProviderName {
  const requested = preferred ?? env.LLM_PROVIDER;
  if (isProviderName(requested) && isProviderConfigured(requested)) return requested;
  return configuredProviders()[0] ?? (requested as ProviderName);
}

export function providerModel(name: ProviderName): string {
  if (name === 'claude') return env.CLAUDE_MODEL;
  if (name === 'gemini') return env.GEMINI_MODEL;
  return env.OLLAMA_MODEL;
}
