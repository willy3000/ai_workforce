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
import type { ITask } from '../database/models/task.model';
import type { AgentRunResult } from '../agents/types';
import { logger } from '../utils/logger';
import { AppError, toErrorMessage } from '../utils/errors';
import { truncate } from '../utils/text';

/**
 * The coordinator owns *executing* work: it takes a task, makes sure it has an
 * owner, runs the owning agent, and records the outcome (status, result,
 * memory, messages).
 *
 * Concurrency note: `runTask` guards against double-execution by transitioning
 * the task to `in_progress` and refusing to run a task already in that state.
 * With a single process this is sufficient; a multi-instance deployment should
 * make that transition a `findOneAndUpdate` compare-and-set — the seam is here,
 * in one method, precisely so that change is contained.
 */
export class AgentCoordinator {
  /** Run one task end to end. */
  async runTask(taskId: string | Types.ObjectId): Promise<AgentRunResult> {
    const task = await taskRepository.findByIdOrFail(taskId);

    if (task.status === 'in_progress') {
      throw new AppError(`Task ${String(taskId)} is already running`, 409, 'task_running');
    }
    if (task.status === 'done') {
      throw new AppError(`Task ${String(taskId)} is already done`, 409, 'task_done');
    }

    const agentKey = task.assignedTo ?? (await this.autoAssign(task));
    const definition = agentRegistry.getOrFail(agentKey);

    // Approval gate: a role flagged `requiresHumanApproval` never runs
    // unattended — the task parks and waits for an explicit approve call.
    if (definition.permissions.requiresHumanApproval) {
      await taskRepository.transition(
        task._id,
        'awaiting_approval',
        'orchestrator',
        `${agentKey} requires human approval before running`,
      );
      throw new AppError(
        `Agent '${agentKey}' requires human approval. Approve the task to proceed.`,
        409,
        'approval_required',
      );
    }

    await taskRepository.transition(task._id, 'in_progress', 'orchestrator', `Running ${agentKey}`);
    const attempts = await taskRepository.incrementAttempts(task._id);

    try {
      const result = await agentRuntime.run(agentKey, {
        projectId: String(task.projectId),
        taskId: String(task._id),
        workflowRunId: task.workflowRunId ? String(task.workflowRunId) : undefined,
        prompt: this.buildPrompt(task),
      });

      await this.finalize(task, agentKey, result, attempts);
      return result;
    } catch (err) {
      const message = toErrorMessage(err);
      logger.error({ err, taskId: String(task._id), agentKey }, 'Task execution failed');
      await taskRepository.transition(task._id, 'failed', agentKey, message, { error: message });
      throw err;
    }
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

    if (result.error && !result.completion) {
      const canRetry = attempts < task.maxAttempts;
      await taskRepository.transition(
        task._id,
        canRetry ? 'ready' : 'failed',
        agentKey,
        result.error,
        { error: result.error, result: output },
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
