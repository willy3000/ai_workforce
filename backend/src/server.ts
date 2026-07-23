import type { Server } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { connectDatabase, disconnectDatabase, ensureIndexes } from './database/connection';
import { Workspace } from './integrations/filesystem/workspace';
import { syncAgentRoster } from './scripts/seed-agents';
import { validateRegistries } from './bootstrap/validate-registries';
import { agentRegistry } from './agents/registry';
import { workflowRegistry } from './workflows';
import { toolRegistry } from './tools/registry';

/**
 * Bootstrap.
 *
 * Order matters: database first (everything depends on it), then indexes, then
 * the workspace root, then the agent roster mirror. The HTTP listener starts
 * last so the platform never accepts a request it cannot serve.
 */
async function bootstrap(): Promise<void> {
  // Fail fast on a mis-wired agent/tool/workflow definition, before anything
  // can touch a repository.
  validateRegistries();

  await connectDatabase();
  await ensureIndexes();
  await Workspace.ensureRoot();
  await syncAgentRoster();

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        model: env.CLAUDE_MODEL,
        agents: agentRegistry.keys().length,
        workflows: workflowRegistry.keys().length,
        tools: toolRegistry.names().length,
      },
      `AI Engineering Company listening on http://localhost:${env.PORT}`,
    );
  });

  // Agent runs are long; give in-flight work time to finish before exiting.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    const forced = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 30_000);
    forced.unref();

    server.close(async () => {
      await disconnectDatabase();
      clearTimeout(forced);
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting');
    process.exit(1);
  });
}

void bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
