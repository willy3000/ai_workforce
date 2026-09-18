import { Types } from 'mongoose';
import { agentRuntime } from '../agents/agent-runtime';
import { agentRegistry } from '../agents/registry';
import { taskRouter } from './task-router';
import {
  messageRepository,
  projectRepository,
  taskRepository,
} from '../database/repositories';
import { projectMemory } from '../memory/project-memory';
import { executionRegistry } from '../runtime/execution-registry';
import type { ITask } from '../database/models/task.model';
import type { AgentRunResult } from '../agents/types';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { AppError, toErrorMessage } from '../utils/errors';
import { truncate } from '../utils/text';

/**
 * The coordinator owns *executing* work: it takes a task, makes sure it has an
 * owner, runs the owning agent, and records the outcome (status, result,
 * memory, messages).
 *
 * ## Concurrency (audit finding E3)
 * `runTask` used to read the task, check `status !== 'in_progress'`, and then
 * write `in_progress` — three operations separated by awaits. Two concurrent
 * callers both passed the check and both ran the same agent against the same
 * checkout. It now claims the task with a single atomic compare-and-set, and
 * holds the project's checkout lock for the duration so a task and a workflow
 * run cannot edit the same working tree at once (E5).
 *
 * ## Authorization (audit finding E6)
 * The approval gate lives in `assertExecutionAllowed`, which is shared with the
 * direct-agent entry point. Previously only this method consulted it, so
 * `POST /api/agents/run` bypassed the `requiresHumanApproval` flag entirely —
 * the control existed but one of the two doors did not check it.
 */
export class AgentCoordinator {
  /**
   * The single execution-authorization policy, shared by every entry point.
   *
   * Returns the approval requirement rather than throwing, so callers can offer
   * a useful next action ("approve this task") instead of a bare 409.
   */
  assertExecutionAllowed(agentKey: string, approved: boolean): void {
    const definition = agentRegistry.getOrFail(agentKey);
    const requiresApproval = definition.permissions.requiresHumanApproval || env.REQUIRE_HUMAN_APPROVAL;
    if (requiresApproval && !approved) {
      throw new AppError(
        `Agent '${agentKey}' requires human approval before it runs. ` +
          'Create a task for this work and approve it, rather than invoking the agent directly.',
        409,
        'approval_required',
      );
    }
  }

  /** Run one task end to end. */
  async runTask(taskId: string | Types.ObjectId): Promise<AgentRunResult> {
    const existing = await taskRepository.findByIdOrFail(taskId);

    if (existing.status === 'in_progress') {
      throw new AppError(`Task ${String(taskId)} is already running`, 409, 'task_running');
    }
    if (existing.status === 'done' || existing.status === 'cancelled') {
      throw new AppError(`Task ${String(taskId)} is already ${existing.status}`, 409, 'task_finished');
    }

    // A dependency that does not exist is not a satisfied dependency (E7).
    const missing = await taskRepository.findMissingDependencies(existing);
    if (missing.length) {
      throw new AppError(
        `Task ${String(taskId)} depends on ${missing.length} task(s) that no longer exist ` +
          `(${missing.join(', ')}). Remove the stale dependencies or recreate them.`,
        409,
        'missing_dependencies',
      );
    }

    const agentKey = existing.assignedTo ?? (await this.autoAssign(existing));

    // Approval gate: a role flagged `requiresHumanApproval` never runs
    // unattended — the task parks and waits for an explicit approve call. An
    // operator-approved task arrives here as `ready`, which is the receipt.
    const approved = existing.status === 'ready' && existing.history.some((h) => h.note === 'Approved by human');
    try {
      this.assertExecutionAllowed(agentKey, approved);
    } catch (err) {
      await taskRepository
        .transition(
          existing._id,
          'awaiting_approval',
          'orchestrator',
          `${agentKey} requires human approval before running`,
        )
        .catch(() => undefined);
      throw err;
    }

    // Atomic claim: exactly one caller wins, everyone else gets `null`.
    const task = await taskRepository.claimForExecution(existing._id, 'orchestrator');
    if (!task) {
      throw new AppError(
        `Task ${String(taskId)} was claimed by another execution. Refresh to see its progress.`,
        409,
        'task_running',
      );
    }

    return executionRegistry.withProjectLock(String(task.projectId), async () => {
      try {
        const result = await agentRuntime.run(agentKey, {
          projectId: String(task.projectId),
          taskId: String(task._id),
          workflowRunId: task.workflowRunId ? String(task.workflowRunId) : undefined,
          prompt: this.buildPrompt(task),
          signal: task.workflowRunId
            ? executionRegistry.signalFor(String(task.workflowRunId))
            : undefined,
        });

        await this.finalize(task, agentKey, result, task.attempts);
        return result;
      } catch (err) {
        const message = toErrorMessage(err);
        logger.error({ err, taskId: String(task._id), agentKey }, 'Task execution failed');
        await taskRepository
          .transition(task._id, 'failed', agentKey, message, { error: message })
          .catch(() => undefined);
        throw err;
      }
    });
  }

  /** Run every task that is currently unblocked. Used by the "work the backlog" endpoint. */
  async runReadyTasks(projectId: string | Types.ObjectId, limit = 5): Promise<AgentRunResult[]> {
    const runnable = await taskRepository.findRunnable(projectId, limit);
    const results: AgentRunResult[] = [];

    // Sequential on purpose: two agents editing the same checkout concurrently
    // would race on the working tree. Parallelism belongs at the project level.
    for (const task of runnable) {
      try {
        results.push(await this.runTask(task._id));
      } catch (err) {
        logger.warn({ err, taskId: String(task._id) }, 'Skipping task after failure');
      }
    }
    return results;
  }

  /** Deliver a message into the bus (used by the API and by workflows). */
  async sendMessage(params: {
    projectId: string | Types.ObjectId;
    from: string;
    to: string;
    intent: 'instruction' | 'question' | 'clarification' | 'review_request' | 'review_result' | 'status' | 'completion' | 'handoff' | 'escalation';
    message: string;
    taskId?: string | Types.ObjectId;
  }): Promise<void> {
    await messageRepository.create({
      projectId: new Types.ObjectId(String(params.projectId)),
      taskId: params.taskId ? new Types.ObjectId(String(params.taskId)) : undefined,
      from: params.from,
      to: params.to,
      intent: params.intent,
      message: params.message,
    });
  }

  private async autoAssign(task: ITask): Promise<string> {
    const decision = taskRouter.route(task);
    await taskRepository.assign(task._id, decision.agentKey, 'task-router');
    logger.info(
      { taskId: String(task._id), agent: decision.agentKey, confidence: decision.confidence, reason: decision.reason },
      'Task routed',
    );
    return decision.agentKey;
  }

  private buildPrompt(task: ITask): string {
    return (
      `Complete the task described in your context. ` +
      (task.acceptanceCriteria.length
        ? 'Every acceptance criterion must be satisfied and you must state how you verified each one. '
        : '') +
      `When you are finished, call report_completion with an honest account of what you did.`
    );
  }

  /** Persist the outcome: status, result, artifacts summary, and memory. */
  private async finalize(
    task: ITask,
    agentKey: string,
    result: AgentRunResult,
    attempts: number,
  ): Promise<void> {
    const status = result.completion?.status;
    const output = result.output || result.completion?.summary || '(no output produced)';

    // Branch on the typed outcome, not on `.error` being set (audit finding E2).
    // A refused, truncated or iteration-capped run has output and no exception,
    // and used to land in the `done` branch below.
    if (result.outcome === 'cancelled') {
      await taskRepository
        .transition(task._id, 'cancelled', agentKey, 'Run cancelled', { result: output })
        .catch(() => undefined);
      return;
    }

    if (!result.succeeded && result.outcome !== 'blocked' && result.outcome !== 'needs_review') {
      const canRetry = attempts < task.maxAttempts;
      const reason = result.error ?? `Agent ended with outcome '${result.outcome}'`;
      await taskRepository.transition(
        task._id,
        canRetry ? 'ready' : 'failed',
        agentKey,
        reason,
        { error: reason, result: output },
      );
      return;
    }

    if (status === 'blocked') {
      await taskRepository.transition(task._id, 'blocked', agentKey, output, { result: output });
      await this.sendMessage({
        projectId: task.projectId,
        taskId: task._id,
        from: agentKey,
        to: 'human',
        intent: 'escalation',
        message: `Task "${task.title}" is blocked: ${truncate(output, 800)}`,
      });
      return;
    }

    if (status === 'needs_review') {
      await taskRepository.transition(task._id, 'awaiting_review', agentKey, output, { result: output });
      return;
    }

    await taskRepository.transition(task._id, 'done', agentKey, 'Completed', { result: output });

    // Feed the outcome back into long-term memory so later agents inherit it.
    const changedPaths = [
      ...new Set(
        (await taskRepository.findById(task._id))?.artifacts
          .filter((a) => a.type === 'file' && a.path)
          .map((a) => a.path as string) ?? [],
      ),
    ];
    if (changedPaths.length || status === 'completed') {
      await projectMemory.recordChange({
        projectId: task.projectId,
        taskId: task._id,
        agentKey,
        title: `Change: ${task.title}`,
        summary: truncate(output, 2000),
        paths: changedPaths,
      });
    }
  }

  /** Approve a task parked at an approval gate and run it. */
  async approveTask(taskId: string | Types.ObjectId, approvedBy = 'human'): Promise<void> {
    const task = await taskRepository.findByIdOrFail(taskId);
    if (task.status !== 'awaiting_approval') {
      throw new AppError(`Task is not awaiting approval (status: ${task.status})`, 409, 'not_awaiting_approval');
    }
    await taskRepository.transition(task._id, 'ready', approvedBy, 'Approved by human');
  }

  async projectStatus(projectId: string | Types.ObjectId) {
    const project = await projectRepository.findByIdOrFail(projectId);
    const [counts, tasks, messages] = await Promise.all([
      taskRepository.countByStatus(project._id),
      taskRepository.list({ projectId: project._id }, 50),
      messageRepository.list({ projectId: project._id }, 25),
    ]);
    return { project, counts, tasks, messages };
  }
}

export const agentCoordinator = new AgentCoordinator();
