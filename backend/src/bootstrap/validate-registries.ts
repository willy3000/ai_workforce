import { agentRegistry } from '../agents/registry';
import { toolRegistry } from '../tools/registry';
import { workflowRegistry } from '../workflows';
import { logger } from '../utils/logger';

/**
 * Boot-time consistency check across the three registries.
 *
 * This is the seam that catches configuration mistakes (a typo'd tool name, a
 * workflow step naming an agent that does not exist) at startup rather than
 * three steps into a workflow that has already modified a repository.
 *
 * It lives in its own module because it is the only place that legitimately
 * needs all three registries at once: agent definitions must not import the
 * tool registry (some tools validate against the agent registry), so the
 * cross-check happens here, after every module has finished loading.
 */
export function validateRegistries(): void {
  const problems: string[] = [];

  for (const agent of agentRegistry.all()) {
    for (const toolName of agent.tools) {
      if (!toolRegistry.has(toolName)) {
        problems.push(`Agent '${agent.key}' references unknown tool '${toolName}'`);
      }
    }
    if (!agent.permissions.writePaths.length && agent.tools.some((t) => t.startsWith('write_') || t === 'edit_file')) {
      problems.push(
        `Agent '${agent.key}' has editing tools but no writePaths — every write will be denied`,
      );
    }
    if (agent.permissions.allowTerminal && !agent.permissions.allowedCommands.length) {
      problems.push(`Agent '${agent.key}' allows terminal use but has an empty command allowlist`);
    }
  }

  for (const workflow of workflowRegistry.all()) {
    const stepIds = new Set(workflow.steps.map((s) => s.id));
    for (const step of workflow.steps) {
      if (!agentRegistry.has(step.agentKey)) {
        problems.push(
          `Workflow '${workflow.key}' step '${step.id}' references unknown agent '${step.agentKey}'`,
        );
      }
      for (const dep of step.dependsOn ?? []) {
        if (!stepIds.has(dep)) {
          problems.push(
            `Workflow '${workflow.key}' step '${step.id}' depends on unknown step '${dep}'`,
          );
        }
      }
    }
  }

  if (problems.length) {
    throw new Error(`Registry validation failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  logger.info(
    {
      agents: agentRegistry.keys().length,
      tools: toolRegistry.names().length,
      workflows: workflowRegistry.keys().length,
    },
    'Registries validated',
  );
}
