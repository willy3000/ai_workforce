import { Types } from 'mongoose';
import { renderTemplate, type StartWorkflowInput, type WorkflowDefinition, type WorkflowStep } from './types';
import { workflowRegistry } from './index';
import { agentRuntime } from '../agents/agent-runtime';
import { agentRegistry } from '../agents/registry';
import {
  projectRepository,
  taskRepository,
  workflowRunRepository,
} from '../database/repositories';
import type { IWorkflowRun, IWorkflowStepState } from '../database/models/workflow-run.model';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { AppError, NotFoundError, toErrorMessage } from '../utils/errors';
import { truncate } from '../utils/text';

/**
 * The autonomous workflow engine.
 *
 * Responsibilities kept deliberately in one place so workflow *definitions* stay
 * declarative:
 *   - materialise a run + one task per step (so every step is inspectable and
 *     addressable exactly like a manually created task);
 *   - resolve dependencies and skip predicates;
 *   - thread each step's output into the next step's prompt;
 *   - enforce approval gates;
 *   - persist state after every step, so a crashed or paused run resumes.
 *
 * Execution is sequential. Steps in these workflows share one git working tree,
 * and two agents editing it concurrently would corrupt each other's work.
 * Parallelism is available across projects, not within a run.
 */
export class WorkflowEngine {
  /** Create the run and (by default) execute it. */
  async start(input: StartWorkflowInput): Promise<IWorkflowRun> {
    const definition = workflowRegistry.get(input.workflow);
    if (!definition) {
      throw new NotFoundError(
        `Workflow '${input.workflow}'. Available: ${workflowRegistry.keys().join(', ')}`,
      );
    }

    const project = await projectRepository.findByIdOrFail(input.projectId);
    if (project.status !== 'ready') {
      throw new AppError(
        `Project '${project.name}' is not ready (status: ${project.status}). Complete onboarding first.`,
        409,
        'project_not_ready',
      );
    }

    const run = await workflowRunRepository.create({
      projectId: project._id,
      workflow: definition.key,
      request: input.request,
      status: 'pending',
      startedBy: input.startedBy ?? 'human',
      steps: definition.steps.map<IWorkflowStepState>((step) => ({
        id: step.id,
        name: step.name,
        agentKey: step.agentKey,
        status: 'pending',
      })),
      context: {},
    });

    logger.info(
      { runId: run._id.toString(), workflow: definition.key, project: project.name },
      'Workflow run created',
    );

    if (input.autoRun === false) return run;
    return this.execute(run._id, definition);
  }

  /** Resume a run that is pending, running, or was approved after a gate. */
  async resume(runId: string | Types.ObjectId): Promise<IWorkflowRun> {
    const run = await workflowRunRepository.findByIdOrFail(runId);
    const definition = workflowRegistry.get(run.workflow);
    if (!definition) throw new NotFoundError('Workflow', run.workflow);
    if (run.status === 'completed' || run.status === 'cancelled') {
      throw new AppError(`Run is already ${run.status}`, 409, 'run_finished');
    }
    return this.execute(run._id, definition);
  }

  /**
   * Approve a gated step and continue the run.
   * Approval is per-step: approving the PR step does not approve future ones.
   */
  async approveStep(
    runId: string | Types.ObjectId,
    stepId: string,
    approvedBy = 'human',
  ): Promise<IWorkflowRun> {
    const run = await workflowRunRepository.findByIdOrFail(runId);
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) throw new NotFoundError('Workflow step', stepId);
    if (step.status !== 'awaiting_approval') {
      throw new AppError(`Step '${stepId}' is not awaiting approval (status: ${step.status})`, 409, 'not_awaiting_approval');
    }

    await workflowRunRepository.updateStep(run._id, stepId, { status: 'pending' });
    await workflowRunRepository.setContextValue(run._id, `__approved_${stepId}`, approvedBy);
    if (step.taskId) {
      await taskRepository.transition(step.taskId, 'ready', approvedBy, 'Approved by human');
    }
    logger.info({ runId: String(runId), stepId, approvedBy }, 'Workflow step approved');
    return this.resume(run._id);
  }

  async cancel(runId: string | Types.ObjectId, reason = 'Cancelled by operator'): Promise<void> {
    await workflowRunRepository.setStatus(runId, 'cancelled', {
      error: reason,
      completedAt: new Date(),
    });
  }

  // --- Execution ------------------------------------------------------------

  private async execute(
    runId: Types.ObjectId,
    definition: WorkflowDefinition,
  ): Promise<IWorkflowRun> {
    await workflowRunRepository.setStatus(runId, 'running', { startedAt: new Date() });

    for (const step of definition.steps) {
      const run = await workflowRunRepository.findByIdOrFail(runId);
      const state = run.steps.find((s) => s.id === step.id);
      if (!state) continue;

      if (state.status === 'completed' || state.status === 'skipped') continue;
      if (state.status === 'awaiting_approval') {
        // Still gated — leave the run parked and return control to the operator.
        await workflowRunRepository.setStatus(runId, 'awaiting_approval');
        return workflowRunRepository.findByIdOrFail(runId);
      }

      // Dependencies not satisfied (an earlier optional step failed): skip.
      const unmet = (step.dependsOn ?? []).filter((dep) => {
        const depState = run.steps.find((s) => s.id === dep);
        return depState && depState.status !== 'completed' && depState.status !== 'skipped';
      });
      if (unmet.length) {
        await this.skip(runId, step, `Dependencies not satisfied: ${unmet.join(', ')}`);
        continue;
      }

      if (step.skipWhen?.(run.context)) {
        await this.skip(runId, step, 'Skip condition met based on earlier step output');
        continue;
      }

      const gated = step.requiresApproval || this.agentRequiresApproval(step) || env.REQUIRE_HUMAN_APPROVAL;
      if (gated && !run.context[`__approved_${step.id}`]) {
        await this.gate(runId, step);
        await workflowRunRepository.setStatus(runId, 'awaiting_approval');
        logger.info({ runId: String(runId), stepId: step.id }, 'Workflow paused for approval');
        return workflowRunRepository.findByIdOrFail(runId);
      }

      const outcome = await this.runStep(run, step, definition);
      if (!outcome.ok && !step.optional) {
        await workflowRunRepository.setStatus(runId, 'failed', {
          error: `Step '${step.id}' failed: ${outcome.error}`,
          completedAt: new Date(),
        });
        return workflowRunRepository.findByIdOrFail(runId);
      }
    }

    const finished = await workflowRunRepository.findByIdOrFail(runId);
    await workflowRunRepository.setStatus(runId, 'completed', {
      completedAt: new Date(),
      summary: this.summarize(finished),
    });
    logger.info({ runId: String(runId), workflow: definition.key }, 'Workflow run completed');
    return workflowRunRepository.findByIdOrFail(runId);
  }

  /** Execute a single step: create its task, run the agent, persist the output. */
  private async runStep(
    run: IWorkflowRun,
    step: WorkflowStep,
    definition: WorkflowDefinition,
  ): Promise<{ ok: boolean; error?: string }> {
    const stepLogger = logger.child({
      runId: run._id.toString(),
      workflow: definition.key,
      stepId: step.id,
      agent: step.agentKey,
    });

    const prompt = renderTemplate(step.prompt, run.request, run.context);

    const task = await taskRepository.create({
      projectId: run.projectId,
      workflowRunId: run._id,
      title: `[${definition.name}] ${step.name}`,
      description: truncate(prompt, 4000),
      type: step.taskType,
      status: 'in_progress',
      priority: 'high',
      assignedTo: step.agentKey,
      createdBy: 'workflow-engine',
      acceptanceCriteria: step.acceptanceCriteria ?? [],
    });

    await workflowRunRepository.updateStep(run._id, step.id, {
      status: 'running',
      taskId: task._id,
      startedAt: new Date(),
    });

    try {
      const result = await agentRuntime.run(step.agentKey, {
        projectId: String(run.projectId),
        taskId: String(task._id),
        workflowRunId: String(run._id),
        prompt,
      });

      const output = result.output || result.completion?.summary || '';
      const blocked = result.completion?.status === 'blocked';

      await taskRepository.transition(
        task._id,
        blocked ? 'blocked' : 'done',
        step.agentKey,
        blocked ? 'Agent reported blocked' : 'Step completed',
        { result: output },
      );

      await workflowRunRepository.updateStep(run._id, step.id, {
        status: blocked ? 'failed' : 'completed',
        output: truncate(output, 20_000),
        completedAt: new Date(),
        error: blocked ? output : undefined,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          toolCalls: result.usage.toolCalls,
        },
      });

      // Thread the output forward for `{{steps.<id>}}` interpolation.
      await workflowRunRepository.setContextValue(run._id, step.id, truncate(output, 12_000));

      stepLogger.info(
        { blocked, toolCalls: result.usage.toolCalls, iterations: result.iterations },
        'Workflow step finished',
      );
      return blocked ? { ok: false, error: output } : { ok: true };
    } catch (err) {
      const message = toErrorMessage(err);
      stepLogger.error({ err }, 'Workflow step failed');
      await taskRepository.transition(task._id, 'failed', step.agentKey, message, { error: message });
      await workflowRunRepository.updateStep(run._id, step.id, {
        status: 'failed',
        error: message,
        completedAt: new Date(),
      });
      await workflowRunRepository.setContextValue(run._id, step.id, `(step failed: ${message})`);
      return { ok: false, error: message };
    }
  }

  private async skip(runId: Types.ObjectId, step: WorkflowStep, reason: string): Promise<void> {
    await workflowRunRepository.updateStep(runId, step.id, {
      status: 'skipped',
      output: reason,
      completedAt: new Date(),
    });
    await workflowRunRepository.setContextValue(runId, step.id, `(skipped: ${reason})`);
    logger.info({ runId: String(runId), stepId: step.id, reason }, 'Workflow step skipped');
  }

  private async gate(runId: Types.ObjectId, step: WorkflowStep): Promise<void> {
    await workflowRunRepository.updateStep(runId, step.id, { status: 'awaiting_approval' });
  }

  private agentRequiresApproval(step: WorkflowStep): boolean {
    return agentRegistry.get(step.agentKey)?.permissions.requiresHumanApproval ?? false;
  }

  private summarize(run: IWorkflowRun): string {
    return run.steps
      .map((s) => `- ${s.name} (${s.agentKey}): ${s.status}`)
      .join('\n');
  }
}

export const workflowEngine = new WorkflowEngine();
