import { agentRegistry } from '../agents/registry';
import { agentRepository } from '../database/repositories';
import { connectDatabase, disconnectDatabase } from '../database/connection';
import { logger } from '../utils/logger';

/**
 * Mirror the code-defined agent roster into MongoDB.
 *
 * Definitions remain authoritative in code; this projection exists so operators
 * can list agents, see accumulated usage stats, and attach per-project overrides
 * without the API having to load the code registry on every request.
 * Runs automatically at boot and is idempotent.
 */
export async function syncAgentRoster(): Promise<void> {
  for (const agent of agentRegistry.all()) {
    await agentRepository.upsertGlobal({
      key: agent.key,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      capabilities: agent.capabilities,
      tools: agent.tools,
      permissions: agent.permissions,
      model: agent.model,
      effort: agent.effort,
      enabled: true,
    });
  }
  logger.info({ agents: agentRegistry.keys() }, 'Agent roster synced');
}

// Allow running standalone: `npm run seed:agents`
if (require.main === module) {
  void (async () => {
    await connectDatabase();
    await syncAgentRoster();
    await disconnectDatabase();
    process.exit(0);
  })().catch((err) => {
    logger.fatal({ err }, 'Agent seed failed');
    process.exit(1);
  });
}
