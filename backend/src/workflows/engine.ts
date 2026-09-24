import crypto from 'node:crypto';
import { Types } from 'mongoose';
import {
  normalizeWorkflowContext,
  renderTemplate,
  type StartWorkflowInput,
  type WorkflowDefinition,
  type WorkflowStep,
} from './types';
import { workflowRegistry } from './index';
import { agentRuntime } from '../agents/agent-runtime';
import { agentRegistry } from '../agents/registry';
import {
  codeRepositoryRepository,
  projectRepository,
  taskRepository,
  workflowRunRepository,
} from '../database/repositories';
import type {
  IWorkflowRun,
  IWorkflowStepState,
  StepOutcome,
  WorkflowOutcome,
} from '../database/models/workflow-run.model';
import type { AgentOutcome, AgentRunResult } from '../agents/types';
import { executionRegistry, RunCancelledError } from '../runtime/execution-registry';
import { closeRunBranch, openRunBranch } from './run-branch';
import { Workspace } from '../integrations/filesystem/workspace';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { AppError, NotFoundError, toErrorMessage } from '../utils/errors';
import { truncate } from '../utils/text';
import { latestChecks } from '../tools/verification';

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
 *   - persist state after every step, so a crashed or paused run resumes;
 *   - assemble the run's change set from observed effects.
 *
 * Execution is sequential within a run. Steps share one git working tree, and
 * two agents editing it concurrently would corrupt each other's work.
 *
 * ## What changed after the audit
 *
 * **E4 — runs no longer execute inside the HTTP request.** `start()` creates the
 * run, returns it immediately with status `queued`, and hands execution to a
 * detached task. The client gets a run id in milliseconds instead of holding a
 * connection open for the length of a six-agent workflow and hoping no proxy
 * times out first.
 *
 * **E3 — one owner per run.** Execution begins by claiming a durable lease
 * (`claimForExecution`). A second resume, a retry, or a second replica loses the
 * compare-and-set and returns the run untouched rather than executing it twice
 * against the same checkout.
 *
 * **E1 — cancellation stops work.** Cancellation is recorded durably *and*
 * signalled to the in-process abort controller. The loop checks before every
 * step and every durable write, and the final status write is conditional so a
 * late-finishing step cannot resurrect a cancelled run.
 *
 * **E2 — outcomes are typed.** A step's `status` says whether the engine got
 * past it; its `outcome` says what actually happened. A refusal, a truncation,
 * an iteration-limit stop and a `needs_review` verdict are four distinct
 * outcomes, and none of them is `completed`.
 */
export class WorkflowEngine {
  /** Identifies this process in run leases. */
  private readonly workerId = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

  /**
   * Create the run and, unless told otherwise, start executing it in the
   * background.
   *
   * Returns as soon as the run is durable. The returned document is the
   * operator's handle: the UI navigates to it and polls, rather than waiting on
   * this call.
   */
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
      status: input.autoRun === false ? 'pending' : 'queued',
      startedBy: input.startedBy ?? 'human',
      steps: definition.steps.map<IWorkflowStepState>((step) => ({
        id: step.id,
        name: step.name,
        agentKey: step.agentKey,
        status: 'pending',
        attempt: 0,
      })),
      context: {},
      changeSet: {},
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    });

    logger.info(
      { runId: run._id.toString(), workflow: definition.key, project: project.name },
      'Workflow run created',
    );

    if (input.autoRun === false) return run;

    // Detached on purpose: the caller gets the queued run now. Failures are
    // recorded on the run document, which is the only place an operator looks.
    void this.executeInBackground(run._id, definition);
    return run;
  }

  /** Resume a run that is pending, queued, interrupted, or approved after a gate. */
  async resume(runId: string | Types.ObjectId): Promise<IWorkflowRun> {
    const run = await workflowRunRepository.findByIdOrFail(runId);
    const definition = workflowRegistry.get(run.workflow);
    if (!definition) throw new NotFoundError('Workflow', run.workflow);

    if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') {
      throw new AppError(`Run is already ${run.status}`, 409, 'run_finished');
    }
    if (executionRegistry.isActive(String(run._id))) {
      throw new AppError(
        'This run is already executing. Watch its timeline rather than resuming it again.',
        409,
        'run_already_executing',
      );
    }

    await workflowRunRepository.setStatusIfNotTerminal(run._id, 'queued');
    void this.executeInBackground(run._id, definition);
    return workflowRunRepository.findByIdOrFail(run._id);
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
      throw new AppError(
        `Step '${stepId}' is not awaiting approval (status: ${step.status})`,
        409,
        'not_awaiting_approval',
      );
    }

    await workflowRunRepository.updateStep(run._id, stepId, { status: 'pending' });
    // The approval receipt records who approved what, and is scoped to this step
    // on this run — it is never a blanket grant (audit finding E6).
    await workflowRunRepository.setContextValue(run._id, `__approved_${stepId}`, approvedBy);
    if (step.taskId) {
      await taskRepository.transition(step.taskId, 'ready', approvedBy, 'Approved by human');
    }
    logger.info({ runId: String(runId), stepId, approvedBy }, 'Workflow step approved');
    return this.resume(run._id);
  }

  /**
   * Stop a run.
   *
   * Two-phase, because the honest answer differs depending on where the work is:
   *
   *  1. The intent is recorded durably as `cancelling`. This survives the worker
   *     being in another process or this API restarting.
   *  2. If the run is executing *here*, its abort signal fires and the worker
   *     confirms the stop by writing `cancelled`.
   *
   * A run that is not executing anywhere is marked `cancelled` straight away.
   * The status the operator sees therefore means what it says — the previous
   * implementation wrote `cancelled` unconditionally while the agent kept
   * running, then let the finishing run overwrite it with `completed`.
   */
  async cancel(
    runId: string | Types.ObjectId,
    reason = 'Cancelled by operator',
    requestedBy = 'human',
  ): Promise<{ status: 'cancelled' | 'cancelling'; message: string }> {
    const id = String(runId);
    const run = await workflowRunRepository.requestCancellation(id, requestedBy, reason);
    if (!run) {
      const existing = await workflowRunRepository.findByIdOrFail(id);
      throw new AppError(
        `Run is already ${existing.status} and cannot be cancelled.`,
        409,
        'run_finished',
      );
    }

    const signalled = executionRegistry.cancel(id, reason);
    if (signalled) {
      return {
        status: 'cancelling',
        message:
          'Stopping. The in-flight model call and any running command are being aborted; ' +
          'changes already written to the checkout are kept and listed on the run.',
      };
    }

    // Nothing is executing here, so there is nothing to wait for.
    await workflowRunRepository.setStatusIfNotTerminal(id, 'cancelled', {
      outcome: 'cancelled',
      completedAt: new Date(),
      error: reason,
    });
    return { status: 'cancelled', message: 'Run cancelled. No work was in flight.' };
  }

  // --- Execution ------------------------------------------------------------

  /**
   * Background entry point. Never throws: a failure here has no caller to catch
   * it, so everything is recorded on the run instead.
   */
  private async executeInBackground(
    runId: Types.ObjectId,
    definition: WorkflowDefinition,
  ): Promise<void> {
    try {
      await this.execute(runId, definition);
    } catch (err) {
      logger.error({ err, runId: String(runId) }, 'Workflow run failed outside step handling');
      await workflowRunRepository
        .setStatusIfNotTerminal(runId, 'failed', {
          outcome: 'failed',
          error: toErrorMessage(err),
          completedAt: new Date(),
        })
        .catch(() => undefined);
    }
  }

  private async execute(
    runId: Types.ObjectId,
    definition: WorkflowDefinition,
  ): Promise<IWorkflowRun> {
    const id = String(runId);

    // Durable ownership first: whoever wins this compare-and-set executes, and
    // everyone else returns the run as-is (audit finding E3).
    const claimed = await workflowRunRepository.claimForExecution(runId, this.workerId);
    if (!claimed) {
      logger.info({ runId: id, worker: this.workerId }, 'Run claimed by another worker; standing down');
      return workflowRunRepository.findByIdOrFail(runId);
    }

    let signal: AbortSignal;
    try {
      signal = executionRegistry.begin(id, String(claimed.projectId));
    } catch (err) {
      // At capacity: release the lease so another worker (or a later retry) can
      // pick the run up, and leave it queued rather than failing it.
      await workflowRunRepository.releaseLease(runId, this.workerId);
      await workflowRunRepository.setStatusIfNotTerminal(runId, 'queued');
      throw err;
    }

    try {
      // Serialize on the checkout: one project, one writer (audit finding E5).
      return await executionRegistry.withProjectLock(String(claimed.projectId), () =>
        this.withRunBranch(runId, () => this.runSteps(runId, definition, signal)),
      );
    } finally {
      executionRegistry.end(id);
      await workflowRunRepository.releaseLease(runId, this.workerId).catch(() => undefined);
    }
  }

  private async runSteps(
    runId: Types.ObjectId,
    definition: WorkflowDefinition,
    signal: AbortSignal,
  ): Promise<IWorkflowRun> {
    const id = String(runId);
    for (const step of definition.steps) {
      // Cancellation is checked at the top of every step: the boundary where
      // stopping costs nothing and leaves the checkout in a describable state.
      if (await this.shouldStop(id, signal)) {
        return this.finishCancelled(runId);
      }
      await workflowRunRepository.renewLease(runId, this.workerId);

      const run = await workflowRunRepository.findByIdOrFail(runId);
      const context = normalizeWorkflowContext(run.context);
      const state = run.steps.find((s) => s.id === step.id);
      if (!state) continue;

      if (state.status === 'completed' || state.status === 'skipped') continue;
      if (state.status === 'awaiting_approval') {
        // Still gated — leave the run parked and return control to the operator.
        await workflowRunRepository.setStatusIfNotTerminal(runId, 'awaiting_approval');
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

      if (step.skipWhen?.(context)) {
        await this.skip(runId, step, 'Skip condition met based on earlier step output');
        continue;
      }

      const gated = step.requiresApproval || this.agentRequiresApproval(step) || env.REQUIRE_HUMAN_APPROVAL;
      if (gated && !context[`__approved_${step.id}`]) {
        await this.gate(runId, step);
        await workflowRunRepository.setStatusIfNotTerminal(runId, 'awaiting_approval');
        logger.info({ runId: id, stepId: step.id }, 'Workflow paused for approval');
        return workflowRunRepository.findByIdOrFail(runId);
      }

      const outcome = await this.runStepWithRecovery(run, step, definition, signal);

      if (outcome.stepOutcome === 'cancelled') {
        return this.finishCancelled(runId);
      }
      if (!outcome.ok && !step.optional) {
        await workflowRunRepository.setStatusIfNotTerminal(runId, 'failed', {
          outcome: outcome.stepOutcome === 'blocked' ? 'blocked' : 'failed',
          error: `Step '${step.id}' ${outcome.stepOutcome}: ${outcome.error}`,
          completedAt: new Date(),
          summary: await this.summarize(runId),
        });
        return workflowRunRepository.findByIdOrFail(runId);
      }
    }

    if (await this.shouldStop(id, signal)) return this.finishCancelled(runId);

    const finished = await workflowRunRepository.findByIdOrFail(runId);
    const runOutcome = this.deriveRunOutcome(finished);

    await workflowRunRepository.setStatusIfNotTerminal(runId, 'completed', {
      outcome: runOutcome,
      completedAt: new Date(),
      summary: this.renderSummary(finished, runOutcome),
    });
    logger.info({ runId: id, workflow: definition.key, outcome: runOutcome }, 'Workflow run completed');
    return workflowRunRepository.findByIdOrFail(runId);
  }

  /** Recoverable feedback starts another working pass on the same branch. */
  private async runStepWithRecovery(
    run: IWorkflowRun, step: WorkflowStep, definition: WorkflowDefinition, signal: AbortSignal,
  ): Promise<{ ok: boolean; stepOutcome: StepOutcome; error?: string }> {
    let current = run;
    for (;;) {
      if (await this.shouldStop(String(run._id), signal)) {
        return { ok: false, stepOutcome: 'cancelled', error: 'Run cancelled' };
      }
      const outcome = await this.runStep(current, step, definition, signal);
      if (outcome.ok || !['needs_review', 'blocked', 'truncated', 'iteration_limit', 'error'].includes(outcome.stepOutcome)) return outcome;
      // Review-only workflows must remain reviews, not automatic rewrites.
      if (definition.key === 'code-review') return outcome;
      current = await workflowRunRepository.findByIdOrFail(run._id);
      const attempt = current.steps.find((s) => s.id === step.id)?.attempt ?? 1;
      if (attempt >= 1 + env.WORKFLOW_REPAIR_ATTEMPTS) return outcome;
      await workflowRunRepository.renewLease(run._id, this.workerId);
      logger.info({ runId: String(run._id), stepId: step.id, attempt }, 'Repairing step feedback automatically');
    }
  }

  /** Execute a single step: create its task, run the agent, persist the output. */
  private async runStep(
    run: IWorkflowRun,
    step: WorkflowStep,
    definition: WorkflowDefinition,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; stepOutcome: StepOutcome; error?: string }> {
    const stepLogger = logger.child({
      runId: run._id.toString(),
      workflow: definition.key,
      stepId: step.id,
      agent: step.agentKey,
    });

    const prompt = renderTemplate(step.prompt, run.request, normalizeWorkflowContext(run.context));
    const previousAttempt = run.steps.find((s) => s.id === step.id)?.attempt ?? 0;
    const attempt = previousAttempt + 1;

    const task = await taskRepository.create({
      projectId: run.projectId,
      workflowRunId: run._id,
      title: `[${definition.name}] ${step.name}${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
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
      attempt,
    });

    try {
      const result = await agentRuntime.run(step.agentKey, {
        projectId: String(run.projectId),
        taskId: String(task._id),
        workflowRunId: String(run._id),
        prompt,
        additionalContext: previousAttempt > 0
          ? `This is an autonomous repair pass on the SAME checkout and branch. Inspect the existing work, fix the outstanding issue and rerun applicable verification. Do not merely repeat the review or request permission. Preserve unrelated operator work.\nPrevious feedback:\n${truncate(run.steps.find((s) => s.id === step.id)?.error ?? run.steps.find((s) => s.id === step.id)?.output ?? '', 12000)}\nLatest verification:\n${latestChecks(run.changeSet?.checks ?? []).map((c) => `${c.command}: ${c.passed ? 'passed' : `exit ${c.exitCode}`}`).join('\n')}`
          : undefined,
        signal,
      });

      // Usage is banked immediately, so a later crash cannot erase the record of
      // money already spent (audit: usage lost on mid-run failure).
      await workflowRunRepository.addUsage(run._id, result.usage);
      if (result.changedPaths?.length) {
        await workflowRunRepository.recordChangedPaths(run._id, result.changedPaths);
      }

      let stepOutcome = toStepOutcome(result.outcome);
      const output = result.output || result.completion?.summary || '';
      let ok = result.succeeded;
      if (ok && step.agentKey === 'qa-engineer' && ['review', 'testing'].includes(step.taskType)) {
        const verified = await workflowRunRepository.findByIdOrFail(run._id);
        const failing = latestChecks(verified.changeSet?.checks ?? []).filter((check) => !check.passed);
        if (failing.length) {
          ok = false;
          stepOutcome = 'needs_review';
          result.error = `Verification still fails: ${failing.map((check) => check.command).join('; ')}. Repair and rerun these checks.\n${output}`;
        }
      }

      await taskRepository.transition(
        task._id,
        taskStatusFor(stepOutcome),
        step.agentKey,
        describeOutcome(stepOutcome, result),
        { result: output, ...(ok ? {} : { error: result.error }) },
      );

      await workflowRunRepository.updateStep(run._id, step.id, {
        status: ok ? 'completed' : stepOutcome === 'cancelled' ? 'failed' : 'failed',
        outcome: stepOutcome,
        output: truncate(output, 20_000),
        completedAt: new Date(),
        error: ok ? undefined : (result.error ?? output),
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          toolCalls: result.usage.toolCalls,
        },
      });

      // Thread the output forward for `{{steps.<id>}}` interpolation. A failed
      // step threads its failure, so the next agent is told what went wrong
      // rather than silently receiving an empty context slot.
      await workflowRunRepository.setContextValue(
        run._id,
        step.id,
        ok ? truncate(output, 12_000) : `(step ${stepOutcome}: ${truncate(result.error ?? output, 2_000)})`,
      );

      stepLogger.info(
        { outcome: stepOutcome, toolCalls: result.usage.toolCalls, iterations: result.iterations },
        'Workflow step finished',
      );
      return { ok, stepOutcome, error: ok ? undefined : (result.error ?? output) };
    } catch (err) {
      if (err instanceof RunCancelledError || signal.aborted) {
        await taskRepository
          .transition(task._id, 'cancelled', step.agentKey, 'Run cancelled')
          .catch(() => undefined);
        await workflowRunRepository.updateStep(run._id, step.id, {
          status: 'failed',
          outcome: 'cancelled',
          error: 'Run cancelled',
          completedAt: new Date(),
        });
        return { ok: false, stepOutcome: 'cancelled', error: 'Run cancelled' };
      }

      const message = toErrorMessage(err);
      stepLogger.error({ err }, 'Workflow step failed');
      await taskRepository
        .transition(task._id, 'failed', step.agentKey, message, { error: message })
        .catch(() => undefined);
      await workflowRunRepository.updateStep(run._id, step.id, {
        status: 'failed',
        outcome: 'error',
        error: message,
        completedAt: new Date(),
      });
      await workflowRunRepository.setContextValue(run._id, step.id, `(step failed: ${message})`);
      return { ok: false, stepOutcome: 'error', error: message };
    }
  }

  // --- Change set -----------------------------------------------------------

  /**
   * Run `fn` with the run's work isolated on a platform-owned branch.
   *
   * Opens the `aiec/...` branch in every repository in the checkout (pinning
   * each base commit — audit finding E8), runs the steps, then commits,
   * publishes and restores. Closing runs whether the steps finished, failed,
   * paused for approval or threw, because a checkout left on a run branch would
   * become the starting point of the next, unrelated run.
   */
  private async withRunBranch<T>(runId: Types.ObjectId, fn: () => Promise<T>): Promise<T> {
    const run = await workflowRunRepository.findByIdOrFail(runId);
    const project = await projectRepository.findByIdOrFail(run.projectId);
    const workspacePath = project.workspacePath ?? Workspace.pathForProject(String(run.projectId));

    let opened = false;
    try {
      const branch = await openRunBranch(run, workspacePath);
      if (branch) {
        opened = true;
        const first = branch.repos[0];
        await workflowRunRepository.patchChangeSet(runId, {
          branch: branch.branch,
          repos: branch.repos,
          baseCommit: run.changeSet?.baseCommit ?? first?.baselineCommit ?? first?.baseCommit,
        });
      }
    } catch (err) {
      logger.error({ err, runId: String(runId) }, 'Could not prepare the delivery branch');
      throw err;
    }

    try {
      return await fn();
    } finally {
      if (opened) await this.closeBranch(runId, workspacePath);
    }
  }

  private async closeBranch(runId: Types.ObjectId, workspacePath: string): Promise<void> {
    try {
      const run = await workflowRunRepository.findByIdOrFail(runId);
      const repository = await codeRepositoryRepository.findByProject(run.projectId);
      const closed = await closeRunBranch(run, workspacePath, repository, { publish: env.PUBLISH_RUN_BRANCHES });

      for (const commit of closed.commits) await workflowRunRepository.recordCommit(runId, commit);
      await workflowRunRepository.recordChangedPaths(runId, closed.changedPaths);
      await workflowRunRepository.patchChangeSet(runId, {
        repos: closed.repos,
        headCommit: closed.repos.find((r) => r.changedPaths?.length)?.headCommit ?? closed.repos[0]?.headCommit,
      });

      // The summary was rendered before publishing; re-render it so it states
      // where the branch went.
      const finished = await workflowRunRepository.findByIdOrFail(runId);
      if (['completed', 'failed', 'cancelled'].includes(finished.status)) {
        const publicationFailed = closed.repos.some((repo) => repo.publishError);
        const outcome = finished.status === 'completed' && publicationFailed
          ? 'needs_review' : finished.outcome ?? this.deriveRunOutcome(finished);
        await workflowRunRepository.setStatus(runId, finished.status, {
          outcome,
          summary: this.renderSummary(finished, outcome),
        });
      }
    } catch (err) {
      logger.error({ err, runId: String(runId) }, 'Closing run branch failed');
      const finished = await workflowRunRepository.findByIdOrFail(runId);
      if (finished.status === 'completed') {
        await workflowRunRepository.setStatus(runId, 'completed', {
          outcome: 'needs_review', error: `Branch delivery did not finish: ${toErrorMessage(err)}`,
          summary: `${this.renderSummary(finished, 'needs_review')}\nBranch delivery did not finish: ${toErrorMessage(err)}`,
        });
      }
    }
  }

  // --- Helpers --------------------------------------------------------------

  /** True when the operator asked to stop, checked both in memory and durably. */
  private async shouldStop(runId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return true;
    // The durable check catches a cancellation issued to a different replica.
    return workflowRunRepository.isCancellationRequested(runId);
  }

  private async finishCancelled(runId: Types.ObjectId): Promise<IWorkflowRun> {
    const run = await workflowRunRepository.findByIdOrFail(runId);
    await workflowRunRepository.setStatusIfNotTerminal(runId, 'cancelled', {
      outcome: 'cancelled',
      completedAt: new Date(),
      error: run.error ?? 'Cancelled by operator',
      summary: this.renderSummary(run, 'cancelled'),
    });
    logger.info({ runId: String(runId) }, 'Workflow run cancelled');
    return workflowRunRepository.findByIdOrFail(runId);
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

  /**
   * What the run as a whole achieved.
   *
   * Reaching the last step is necessary but not sufficient: if any step needed
   * review, the run needs review. This is the distinction audit finding E2 asked
   * for, and the one the pricing argument rests on — "completed" must mean the
   * change is ready, not that the loop terminated.
   */
  private deriveRunOutcome(run: IWorkflowRun): WorkflowOutcome {
    const outcomes = run.steps.map((s) => s.outcome).filter(Boolean) as StepOutcome[];
    if (outcomes.includes('cancelled')) return 'cancelled';
    if (outcomes.includes('blocked')) return 'blocked';
    if (outcomes.some((o) => ['error', 'refused', 'truncated', 'iteration_limit'].includes(o))) {
      // Optional steps failing does not fail the run, but it does mean a human
      // should look before trusting the result.
      return 'needs_review';
    }
    if (outcomes.includes('needs_review')) return 'needs_review';

    // No verification evidence means nobody has demonstrated the change works.
    const checks = latestChecks(run.changeSet?.checks ?? []);
    if (checks.length && checks.some((c) => !c.passed)) return 'needs_review';
    return 'delivered';
  }

  private async summarize(runId: Types.ObjectId): Promise<string> {
    const run = await workflowRunRepository.findByIdOrFail(runId);
    return this.renderSummary(run, this.deriveRunOutcome(run));
  }

  /**
   * An operator-facing summary that leads with the outcome and the evidence.
   *
   * The audit's UX finding was that run output is dominated by model prose. This
   * puts the four things a reviewer actually needs — verdict, what changed, what
   * was verified, what to do next — above it.
   */
  private renderSummary(run: IWorkflowRun, outcome: WorkflowOutcome): string {
    const changeSet = run.changeSet ?? {};
    const checks = latestChecks(changeSet.checks ?? []);
    const passed = checks.filter((c) => c.passed).length;

    const lines: string[] = [
      `Outcome: ${OUTCOME_LABELS[outcome]}`,
      changeSet.changedPaths?.length
        ? `Changed ${changeSet.changedPaths.length} file(s): ${changeSet.changedPaths.slice(0, 10).join(', ')}` +
          (changeSet.changedPaths.length > 10 ? ` and ${changeSet.changedPaths.length - 10} more` : '')
        : 'No files were changed.',
      checks.length
        ? `Verification: ${passed}/${checks.length} check(s) passed — ${checks
            .map((c) => `${c.command} (${c.passed ? 'pass' : `exit ${c.exitCode}`})`)
            .join('; ')}`
        : 'Verification: no test or lint command was run.',
      changeSet.baseCommit
        ? `Commits: ${changeSet.baseCommit.slice(0, 8)}..${(changeSet.headCommit ?? changeSet.baseCommit).slice(0, 8)}` +
          ` on ${changeSet.branch ?? 'unknown branch'}`
        : '',
      changeSet.pullRequest ? `Pull request: #${changeSet.pullRequest.number} ${changeSet.pullRequest.url}` : '',
      ...(changeSet.repos ?? []).map((repo) =>
        repo.published
          ? `Published ${changeSet.branch} to ${repo.published.target} — git checkout ${changeSet.branch}`
          : repo.publishError
            ? `Not published (${repo.root || 'root'}): ${repo.publishError}`
            : '',
      ),
      '',
      'Steps:',
      ...run.steps.map(
        (s) => `- ${s.name} (${s.agentKey}): ${s.status}${s.outcome ? ` — ${s.outcome}` : ''}`,
      ),
    ];
    return lines.filter((line) => line !== '').join('\n');
  }
}

const OUTCOME_LABELS: Record<WorkflowOutcome, string> = {
  delivered: 'Delivered — every step completed and recorded checks passed',
  needs_review: 'Needs review — finished, but a human should confirm before publishing',
  blocked: 'Blocked — an agent could not proceed',
  failed: 'Failed — a required step did not complete',
  cancelled: 'Cancelled — stopped before finishing',
};

/** Agent-level outcome → step-level outcome. Kept total so no case is dropped. */
function toStepOutcome(outcome: AgentOutcome): StepOutcome {
  switch (outcome) {
    case 'completed':
      return 'completed';
    case 'needs_review':
      return 'needs_review';
    case 'blocked':
      return 'blocked';
    case 'refused':
      return 'refused';
    case 'truncated':
      return 'truncated';
    case 'iteration_limit':
      return 'iteration_limit';
    case 'cancelled':
      return 'cancelled';
    case 'no_completion_report':
    default:
      return 'error';
  }
}

function taskStatusFor(outcome: StepOutcome) {
  switch (outcome) {
    case 'completed':
      return 'done' as const;
    case 'needs_review':
      return 'awaiting_review' as const;
    case 'blocked':
      return 'blocked' as const;
    case 'cancelled':
      return 'cancelled' as const;
    default:
      return 'failed' as const;
  }
}

function describeOutcome(outcome: StepOutcome, result: AgentRunResult): string {
  switch (outcome) {
    case 'completed':
      return 'Step completed';
    case 'needs_review':
      return 'Agent asked for human review';
    case 'blocked':
      return 'Agent reported blocked';
    case 'refused':
      return 'Model declined the request';
    case 'truncated':
      return 'Response was truncated at the token limit';
    case 'iteration_limit':
      return 'Agent ran out of iterations without reporting completion';
    case 'cancelled':
      return 'Run cancelled';
    default:
      return result.error ?? 'Agent ended without a completion report';
  }
}

export const workflowEngine = new WorkflowEngine();
