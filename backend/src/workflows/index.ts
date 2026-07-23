import type { WorkflowDefinition } from './types';
import { featureDevelopmentWorkflow } from './feature-development.workflow';
import { bugFixingWorkflow } from './bug-fixing.workflow';
import { codeReviewWorkflow } from './code-review.workflow';

/**
 * Workflow catalogue. Registering a new workflow is a one-line addition here
 * plus a definition file — the engine and API require no changes.
 */
export class WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowDefinition>();

  register(definition: WorkflowDefinition): void {
    if (this.workflows.has(definition.key)) {
      throw new Error(`Workflow '${definition.key}' is already registered`);
    }
    this.workflows.set(definition.key, definition);
  }

  get(key: string): WorkflowDefinition | undefined {
    return this.workflows.get(key);
  }

  keys(): string[] {
    return [...this.workflows.keys()];
  }

  all(): WorkflowDefinition[] {
    return [...this.workflows.values()];
  }
}

export const workflowRegistry = new WorkflowRegistry();

for (const workflow of [featureDevelopmentWorkflow, bugFixingWorkflow, codeReviewWorkflow]) {
  workflowRegistry.register(workflow);
}

export * from './types';
export { featureDevelopmentWorkflow, bugFixingWorkflow, codeReviewWorkflow };
