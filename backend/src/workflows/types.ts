import type { TaskType } from '../database/models/task.model';

/**
 * Workflow definition model.
 *
 * A workflow is declarative data, not code: a list of steps, each naming the
 * agent that runs it and a prompt template. Everything imperative (retries,
 * approval gates, persistence, context threading) lives once in the engine.
 *
 * Consequence: adding "hotfix", "security-audit" or "dependency-upgrade" is a
 * new data file, and the engine, API and UI pick it up unchanged.
 */
export interface WorkflowStep {
  /** Stable id — referenced by `dependsOn` and used to key step outputs. */
  id: string;
  name: string;
  agentKey: string;
  /** Task type recorded for the task this step creates. */
  taskType: TaskType;
  /**
   * Prompt template. `{{request}}` is the original human request;
   * `{{steps.<id>}}` interpolates a previous step's output.
   */
  prompt: string;
  /** Step ids whose output must exist first. */
  dependsOn?: string[];
  /** Acceptance criteria attached to the created task. */
  acceptanceCriteria?: string[];
  /** Hold in `awaiting_approval` before running (outward-facing / risky steps). */
  requiresApproval?: boolean;
  /**
   * Skip predicate evaluated against accumulated step outputs — e.g. skip the
   * frontend step when the technical plan says no UI work is needed.
   */
  skipWhen?: (context: Record<string, string>) => boolean;
  /** Continue the workflow even if this step fails. */
  optional?: boolean;
}

export interface WorkflowDefinition {
  key: string;
  name: string;
  description: string;
  /** What kind of human request this workflow serves. */
  trigger: string;
  steps: WorkflowStep[];
}

export interface StartWorkflowInput {
  projectId: string;
  workflow: string;
  request: string;
  startedBy?: string;
  /** Run steps immediately (default) or just materialise the plan. */
  autoRun?: boolean;
}

/** Render a prompt template against the original request and prior step outputs. */
export function renderTemplate(
  template: string,
  request: string,
  context: Record<string, string>,
): string {
  return template
    .replace(/\{\{request\}\}/g, request)
    .replace(/\{\{steps\.([\w-]+)\}\}/g, (_match, stepId: string) => {
      const value = context[stepId];
      return value ? value : `(no output recorded for step '${stepId}')`;
    });
}
