import type { AgentDefinition } from './types';
import { paymentSafetyAdvisor } from './definitions/payment-safety-advisor';
import { projectManager } from './definitions/project-manager';
import { engineeringManager } from './definitions/engineering-manager';
import { backendEngineer } from './definitions/backend-engineer';
import { frontendEngineer } from './definitions/frontend-engineer';
import { qaEngineer } from './definitions/qa-engineer';
import { documentationEngineer } from './definitions/documentation-engineer';

/**
 * The agent roster.
 *
 * Definitions live in code. Adding a role to the organization means adding one
 * file here — the runtime, tools, router and workflows are all generic over
 * `AgentDefinition`, so no other layer changes.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  register(definition: AgentDefinition): void {
    if (this.agents.has(definition.key)) {
      throw new Error(`Agent '${definition.key}' is already registered`);
    }
    // Note: tool names are cross-checked against the tool registry once at boot
    // (`bootstrap/validate-registries.ts`), not here — importing the tool
    // registry from this module would create a load-order cycle, since some
    // tools validate their arguments against this registry.
    this.agents.set(definition.key, definition);
  }

  get(key: string): AgentDefinition | undefined {
    return this.agents.get(key);
  }

  getOrFail(key: string): AgentDefinition {
    const agent = this.agents.get(key);
    if (!agent) {
      throw new Error(`Unknown agent '${key}'. Registered: ${this.keys().join(', ')}`);
    }
    return agent;
  }

  has(key: string): boolean {
    return this.agents.has(key);
  }

  keys(): string[] {
    return [...this.agents.keys()];
  }

  all(): AgentDefinition[] {
    return [...this.agents.values()];
  }
}

export const agentRegistry = new AgentRegistry();

for (const definition of [
  paymentSafetyAdvisor,
  projectManager,
  engineeringManager,
  backendEngineer,
  frontendEngineer,
  qaEngineer,
  documentationEngineer,
]) {
  agentRegistry.register(definition);
}
