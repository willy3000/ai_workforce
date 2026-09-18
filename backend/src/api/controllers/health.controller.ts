import type { Request, Response } from 'express';
import { isDatabaseHealthy } from '../../database/connection';
import { agentRegistry } from '../../agents/registry';
import { workflowRegistry } from '../../workflows';
import { toolRegistry } from '../../tools/registry';
import { env } from '../../config/env';
import { executionRegistry } from '../../runtime/execution-registry';
import {
  configuredProviders,
  effectiveProviderName,
  isProviderConfigured,
  providerModel,
} from '../../services/llm/provider-registry';

export const healthController = {
  /** Liveness: the process is up. */
  async health(_req: Request, res: Response): Promise<void> {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version: process.env.npm_package_version ?? '0.1.0',
    });
  },

  /**
   * Readiness: the platform can actually do work.
   *
   * Two audiences, two shapes (audit finding S10). An orchestrator's probe needs
   * only a status code and a boolean, and this endpoint is unauthenticated so it
   * can be probed before a key is configured. The detailed view — registry
   * contents, model names, workspace path, provider configuration — is an
   * operator diagnostic, and previously any anonymous caller could read it. It
   * now requires the same authentication as the rest of the API.
   */
  async ready(req: Request, res: Response): Promise<void> {
    const database = isDatabaseHealthy();
    const claudeConfigured = isProviderConfigured('claude');
    const geminiConfigured = isProviderConfigured('gemini');
    const ollamaConfigured = isProviderConfigured('ollama');
    const githubConfigured = Boolean(env.GITHUB_TOKEN) && env.GITHUB_TOKEN !== 'PASTE_TOKEN_HERE';

    // Ready means "can actually run an agent": a database plus at least one
    // usable model provider. Which one is a configuration choice, not a
    // readiness condition. Ollama has no key so it's always "configured" here;
    // it can still fail at call time if the server isn't reachable.
    const ready = database && (claudeConfigured || geminiConfigured || ollamaConfigured);

    // Unauthenticated callers get liveness-grade detail only.
    if (!req.actor) {
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
      return;
    }

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database,
        claudeApiKey: claudeConfigured,
        geminiApiKey: geminiConfigured,
        ollamaAvailable: ollamaConfigured,
        githubToken: githubConfigured, // optional: local-path projects work without it
      },
      providers: {
        default: env.LLM_PROVIDER,
        effective: effectiveProviderName(),
        configured: configuredProviders(),
        models: { claude: env.CLAUDE_MODEL, gemini: env.GEMINI_MODEL, ollama: env.OLLAMA_MODEL },
        ollamaBaseUrl: env.OLLAMA_BASE_URL,
        geminiQuota: { requestsPerMinute: env.GEMINI_RPM_LIMIT, tokensPerMinute: env.GEMINI_TPM_LIMIT },
      },
      registry: {
        agents: agentRegistry.keys(),
        workflows: workflowRegistry.keys(),
        tools: toolRegistry.names(),
      },
      config: {
        model: providerModel(effectiveProviderName()),
        effort: env.CLAUDE_EFFORT,
        agentMaxIterations: env.AGENT_MAX_ITERATIONS,
        requireHumanApproval: env.REQUIRE_HUMAN_APPROVAL,
        workspaceRoot: env.WORKSPACE_ROOT_ABS,
      },
      // Surfaced so the UI can show an honest posture banner rather than
      // implying controls that are not in force.
      security: {
        authenticated: req.actor.kind === 'operator',
        commandsSandboxed: Boolean(env.TERMINAL_SANDBOX_COMMAND),
        localImportEnabled: env.ALLOW_LOCAL_PATH_IMPORT,
        allowedGitHosts: env.GIT_ALLOWED_HOSTS,
      },
      limits: {
        maxConcurrentRuns: env.MAX_CONCURRENT_RUNS,
        runDeadlineMs: env.RUN_DEADLINE_MS,
        activeRuns: executionRegistry.activeCount,
      },
    });
  },
};
