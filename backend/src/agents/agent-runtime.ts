import { Types } from 'mongoose';
import { agentRegistry } from './registry';
import { SUCCESSFUL_OUTCOMES, type AgentDefinition, type AgentRunInput, type AgentRunResult } from './types';
import { toolRegistry } from '../tools/registry';
import { validateToolInput } from '../tools/validate-input';
import type { ToolContext } from '../tools/types';
import { contextBuilder } from '../memory/context-builder';
import { effectiveProviderName, resolveProvider } from '../services/llm/provider-registry';
import type { LlmMessage, ToolResultBlock } from '../services/llm/types';
import { Workspace } from '../integrations/filesystem/workspace';
import { describePackages, detectPackages } from '../services/workspace-packages';
import { discoverRepos } from '../integrations/github/workspace-repos';
import {
  agentRepository,
  codeRepositoryRepository,
  projectRepository,
  taskRepository,
  workflowRunRepository,
} from '../database/repositories';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { redactSecrets } from '../security/secret-paths';
import { AppError, PermissionDeniedError, ToolExecutionError, toErrorMessage } from '../utils/errors';
import { truncate } from '../utils/text';

/**
 * The agent runtime: one generic loop that every role runs through.
 *
 * ## Why a hand-written loop rather than the SDK's tool runner
 * The runner is the right default for a plain custom-tool agent. This platform
 * needs three things at each turn that sit outside its per-turn hooks:
 *   1. every tool call is permission-checked and persisted as a task artifact
 *      *before* the result is returned to the model;
 *   2. a denied or failed tool call must come back to the model as a recoverable
 *      `is_error` result (so the agent adapts) while still being recorded as a
 *      policy event for the operator;
 *   3. the loop is a step inside a resumable, database-backed workflow, so
 *      iteration state has to be observable from outside the process.
 * Owning the loop is ~80 lines and buys all three.
 *
 * ## Stop reasons handled
 * - `tool_use`   → execute tools, feed results back, continue.
 * - `end_turn`   → done.
 * - `pause_turn` → re-send with the assistant turn appended (server-side tool pause).
 * - `refusal`    → surface as an error; do not retry the same prompt.
 * - `max_tokens` → surface truncation explicitly rather than pretending success.
 *
 * ## Outcome, not just output (audit finding E2)
 * Every run now ends with an explicit `outcome`. The caller must not infer
 * success from "no exception was thrown": a refusal, a truncated response and an
 * iteration-limit stop all produce output, and all three previously became a
 * `completed` workflow step. `AgentRunResult.outcome` is the field callers
 * branch on, and `succeeded` is true only for an agent that reported completion.
 *
 * ## Cancellation (audit finding E1)
 * The run carries an `AbortSignal`. It is checked before every tool dispatch and
 * between iterations, and handed to the provider and to any spawned process, so
 * a cancelled run stops paying for tokens and stops touching the checkout rather
 * than merely being relabelled in the database.
 */
export class AgentRuntime {
  async run(agentKey: string, input: AgentRunInput): Promise<AgentRunResult> {
    const definition = agentRegistry.getOrFail(agentKey);
    const projectId = new Types.ObjectId(input.projectId);
    const project = await projectRepository.findByIdOrFail(projectId);
    const repository = await codeRepositoryRepository.findByProject(projectId);

    const task = input.taskId ? await taskRepository.findByIdOrFail(input.taskId) : undefined;

    // Provider precedence: per-run override → agent definition → platform default.
    const providerName = effectiveProviderName(input.provider ?? definition.provider);

    const runLogger = logger.child({
      agent: agentKey,
      provider: providerName,
      projectId: input.projectId,
      taskId: input.taskId,
      workflowRunId: input.workflowRunId,
    });

    const workspacePath = project.workspacePath ?? Workspace.pathForProject(String(projectId));
    const workspace = new Workspace(workspacePath);
    if (!(await workspace.exists())) {
      throw new AppError(
        `Workspace for project '${project.name}' is missing at ${workspacePath}. Re-run onboarding.`,
        409,
        'workspace_missing',
      );
    }

    // Cross-object ownership check (audit finding S8): a caller could pass any
    // `taskId`, including one belonging to a different project, and the runtime
    // would happily attach this run's artifacts to it.
    if (task && String(task.projectId) !== String(projectId)) {
      throw new AppError(
        `Task ${String(task._id)} belongs to a different project and cannot be run against ` +
          `'${project.name}'.`,
        403,
        'cross_project_reference',
      );
    }

    // Detected per run, not stored at onboarding: existing projects work without
    // a reanalysis, and a package created by an earlier step is seen by later ones.
    const packages = await detectPackages(workspacePath).catch((err) => {
      runLogger.warn({ err }, 'Package detection failed; treating checkout as a single package');
      return [];
    });

    // Git is bound to the repositories *inside* the checkout. Pointing a git
    // client at the checkout itself sent it walking up into the platform's own
    // repository when the checkout was not a repository.
    const repos = await discoverRepos(workspacePath).catch((err) => {
      runLogger.warn({ err }, 'Repository discovery failed; git tools will be unavailable');
      return [];
    });
    const rootRepo = repos.find((r) => r.root === '');
    const runBranch = input.workflowRunId
      ? (await workflowRunRepository.findById(input.workflowRunId))?.changeSet?.branch
      : undefined;

    const context: ToolContext = {
      projectId,
      taskId: task?._id,
      workflowRunId: input.workflowRunId ? new Types.ObjectId(input.workflowRunId) : undefined,
      agentKey,
      permissions: definition.permissions,
      project,
      repository: repository ?? undefined,
      workspace,
      packages,
      repos,
      git: rootRepo?.git,
      runBranch,
      logger: runLogger,
      signal: input.signal,
      recordArtifact: async (artifact) => {
        if (!task) return;
        await taskRepository.addArtifact(task._id, {
          ...artifact,
          // Artifacts are shown to operators and replayed into later prompts, so
          // they get the same redaction as any other agent-visible text (S11).
          content: redactSecrets(artifact.content),
          createdAt: new Date(),
        });
      },
      // Verification and commit evidence attaches to the run, not the task: it
      // describes the change as a whole, which is what a reviewer approves (E8).
      // Absent for ad-hoc agent calls, which have no run to attribute it to.
      recordCheck: input.workflowRunId
        ? (check) => workflowRunRepository.recordCheck(input.workflowRunId as string, check)
        : undefined,
      recordCommit: input.workflowRunId
        ? (commit) => workflowRunRepository.recordCommit(input.workflowRunId as string, commit)
        : undefined,
    };

    const system = contextBuilder.buildSystemPrompt(definition, project);
    // Without this the agent guesses root-level paths (`src/...`) in a repo whose
    // code lives under package directories, and every write is denied.
    const layout = describePackages(packages, definition.permissions.packageKinds);
    const user = await contextBuilder.buildUserMessage({
      projectId,
      agentKey,
      prompt: input.prompt,
      task,
      additionalContext: [layout, input.additionalContext].filter(Boolean).join('\n\n') || undefined,
    });

    return this.loop({ definition, system, user, context, input, runLogger, providerName });
  }

  private async loop(args: {
    definition: AgentDefinition;
    system: string;
    user: string;
    context: ToolContext;
    input: AgentRunInput;
    runLogger: typeof logger;
    providerName: string;
  }): Promise<AgentRunResult> {
    const { definition, system, user, context, input, runLogger, providerName } = args;
    const provider = resolveProvider(providerName);

    const messages: LlmMessage[] = [{ role: 'user', content: user }];
    const tools = toolRegistry.toLlmDefinitions(definition.tools);
    const maxIterations = input.maxIterations ?? env.AGENT_MAX_ITERATIONS;
    // The set of tools this role may call. The model is *shown* only these, but
    // showing is not enforcing: the runtime used to resolve any name in the
    // global registry, so a model that named `open_pull_request` got it whether
    // or not its role had it (audit finding S7).
    const allowedTools = new Set(definition.tools);
    let completionRecoveryAttempts = 0;

    const result: AgentRunResult = {
      agentKey: definition.key,
      provider: providerName,
      output: '',
      stopReason: 'end_turn',
      outcome: 'no_completion_report',
      succeeded: false,
      iterations: 0,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      thinking: [],
      changedPaths: [],
    };

    let lastText = '';

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      result.iterations = iteration;

      // Checked before paying for another provider turn, so a cancelled run
      // stops costing money at the next iteration boundary rather than at the
      // end of the workflow.
      if (input.signal?.aborted) {
        result.outcome = 'cancelled';
        result.output = lastText;
        result.error = 'Run cancelled before this iteration started.';
        runLogger.info({ iteration }, 'Agent run cancelled');
        break;
      }

      // On the final turn, offer only `report_completion`. An agent that ran out
      // of budget used to end with no report at all — its files on disk, but no
      // account of what it did or what is left — and the step was lost as
      // `iteration_limit`. Forcing the report turns that into an honest partial.
      //
      // The last *two* turns are report-only, and it is enforced at execution as
      // well as offered: models (notably local ones) will call a tool from earlier
      // in the conversation even when it is not in this turn's list, and a single
      // report-only turn was spent on exactly that. The second turn lets a model
      // that misfired see the refusal and recover.
      const reportOnly = allowedTools.has('report_completion') && iteration >= maxIterations - 1;
      const turnTools = reportOnly ? tools.filter((t) => t.name === 'report_completion') : tools;

      const response = await provider.complete({
        system,
        messages,
        tools: turnTools,
        model: definition.model,
        effort: definition.effort,
        showThinking: definition.auditThinking,
        signal: input.signal,
      });

      result.usage.inputTokens += response.usage.inputTokens;
      result.usage.outputTokens += response.usage.outputTokens;
      result.stopReason = response.stopReason;

      if (definition.auditThinking) {
        for (const block of response.content) {
          if (block.type === 'thinking' && typeof (block as { thinking?: string }).thinking === 'string') {
            const thought = (block as { thinking: string }).thinking;
            if (thought.trim()) result.thinking?.push(thought);
          }
        }
      }

      if (response.text) lastText = response.text;

      // --- Terminal stop reasons -------------------------------------------
      if (response.stopReason === 'refusal') {
        result.output = lastText;
        result.outcome = 'refused';
        result.error =
          `The model declined this request (${response.refusal?.category ?? 'policy'}). ` +
          'Rephrase the task or escalate to a human — retrying verbatim will not help.';
        runLogger.warn({ refusal: response.refusal }, 'Agent run refused');
        break;
      }

      if (response.stopReason === 'max_tokens') {
        result.output = lastText;
        result.outcome = 'truncated';
        result.error = 'Response hit the output token limit and was truncated.';
        runLogger.warn('Agent response truncated at max_tokens');
        break;
      }

      // A server-side tool paused the turn: re-send with the assistant turn
      // appended and no extra user message — the API resumes from there.
      if (response.stopReason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content as never });
        continue;
      }

      if (!response.toolUses.length) {
        result.output = lastText;
        if (completionRecoveryAttempts === 0) {
          completionRecoveryAttempts += 1;
          messages.push({ role: 'assistant', content: response.content as never });
          messages.push({
            role: 'user',
            content:
              'Your previous response ended without a completion report. Do not repeat any mutating work ' +
              'or call other tools. Call report_completion exactly once now, using the work already performed ' +
              'and the final status it deserves.',
          });
          continue;
        }
        // Ending the turn without a completion report is genuinely ambiguous:
        // the agent may have finished, or may have drifted into narrating. The
        // caller decides what that is worth; it is not silently a success.
        result.outcome = 'no_completion_report';
        break;
      }

      // --- Tool-use turn ----------------------------------------------------
      messages.push({ role: 'assistant', content: response.content as never });

      const toolResults: ToolResultBlock[] = [];
      for (const call of response.toolUses) {
        if (input.signal?.aborted) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: 'This run was cancelled by the operator. Stop immediately and do not retry.',
            is_error: true,
          });
          continue;
        }

        // Report-only turns: refuse anything but the report, without executing it.
        if (reportOnly && call.name !== 'report_completion') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content:
              `Not executed: the turn budget is spent, so '${call.name}' is unavailable. ` +
              'Call report_completion now with what is done and what remains ' +
              "(status 'needs_review' if the task is incomplete).",
            is_error: true,
          });
          continue;
        }

        // The report itself is exempt from the tool-call budget: the message
        // below tells the model to call it, so refusing it too would guarantee
        // the run ends with no account of its work.
        if (
          call.name !== 'report_completion' &&
          result.usage.toolCalls >= definition.permissions.maxToolCalls
        ) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content:
              `Tool call budget exhausted (${definition.permissions.maxToolCalls}). ` +
              'Stop calling tools and report what you have completed with report_completion.',
            is_error: true,
          });
          continue;
        }

        const executed = await this.executeTool(call, context, runLogger, allowedTools);
        result.usage.toolCalls += 1;
        result.toolCalls.push({
          name: call.name,
          input: call.input,
          ok: !executed.is_error,
          summary: truncate(executed.content, 400),
        });

        // Track what the run touched, so the change set is assembled by the
        // platform from observed effects rather than from the model's prose
        // (audit finding E8).
        if (!executed.is_error && executed.changedPath) {
          result.changedPaths?.push(executed.changedPath);
        }

        // report_completion carries the agent's structured verdict.
        if (call.name === 'report_completion' && !executed.is_error) {
          const payload = call.input as { status?: string; summary?: string; details?: string };
          result.completion = {
            status: (payload.status as 'completed' | 'blocked' | 'needs_review') ?? 'completed',
            summary: payload.summary ?? '',
          };
          if (payload.details) lastText = `${payload.summary ?? ''}\n\n${payload.details}`;
          else if (payload.summary) lastText = payload.summary;
        }

        toolResults.push(executed);
      }

      // All results for one assistant turn go back in ONE user message —
      // splitting them trains the model out of parallel tool use.
      // `changedPath` is platform bookkeeping and is stripped here: sending an
      // unrecognised field on a content block is rejected by strict providers.
      // Tell the agent when its budget is nearly spent. Without this it cannot
      // know to stop exploring and wrap up, so it reads files until the loop
      // ends mid-task. The note rides in the same user turn as the tool results.
      const remaining = maxIterations - iteration;
      const budgetNote =
        remaining > 0 && remaining <= 3 && allowedTools.has('report_completion')
          ? [
              {
                type: 'text',
                text:
                  `Budget: ${remaining} turn${remaining === 1 ? '' : 's'} left, and the last two accept only ` +
                  'report_completion. Stop exploring. Finish or commit what you have, then call ' +
                  'report_completion. If the task is not fully done, ' +
                  "report status 'needs_review' and list exactly what is complete and what remains.",
              },
            ]
          : [];

      messages.push({
        role: 'user',
        content: [
          ...toolResults.map(({ changedPath: _changedPath, ...block }) => block),
          ...budgetNote,
        ],
      });

      // The agent declared it is done: stop rather than paying for another turn.
      if (result.completion) {
        result.output = lastText;
        result.outcome =
          result.completion.status === 'blocked'
            ? 'blocked'
            : result.completion.status === 'needs_review'
              ? 'needs_review'
              : 'completed';
        break;
      }

      if (iteration === maxIterations) {
        result.output = lastText;
        result.outcome = 'iteration_limit';
        result.error = `Reached the ${maxIterations}-iteration limit without a completion report.`;
        runLogger.warn({ iterations: iteration }, 'Agent hit iteration limit');
      }
    }

    if (!result.output) result.output = lastText;
    result.changedPaths = [...new Set(result.changedPaths ?? [])];
    result.succeeded = SUCCESSFUL_OUTCOMES.includes(result.outcome);

    await agentRepository.recordRun(definition.key, result.usage).catch((err) => {
      runLogger.warn({ err }, 'Failed to record agent stats (non-fatal)');
    });

    runLogger.info(
      {
        iterations: result.iterations,
        toolCalls: result.usage.toolCalls,
        stopReason: result.stopReason,
        outcome: result.outcome,
        completion: result.completion?.status,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
      'Agent run finished',
    );

    return result;
  }

  /**
   * Execute one tool call.
   *
   * Every failure mode — unknown tool, role violation, invalid arguments,
   * permission denial, tool error, unexpected exception — becomes an `is_error`
   * tool result rather than an exception. The model is a participant in error
   * recovery: told "you may not write there, hand it to the backend engineer",
   * it does exactly that.
   *
   * ## Authorization happens here, not in the prompt (audit finding S7)
   * Three checks run before dispatch, in order:
   *
   *  1. **Role membership.** The tool must be in the calling agent's own list.
   *     Rendering only a role's tools to the model is a strong hint, not a
   *     control; nothing stopped a model from naming a tool it was never shown,
   *     and the registry would happily resolve it.
   *  2. **Argument validation.** The JSON schema was sent to the model and then
   *     trusted. TypeScript interfaces vanish at runtime, so a tool received
   *     whatever the model emitted — a missing `path`, a number where a string
   *     belonged, extra properties.
   *  3. **Permission and containment**, inside the tool, via `PermissionGuard`.
   */
  private async executeTool(
    call: { id: string; name: string; input: Record<string, unknown> },
    context: ToolContext,
    runLogger: typeof logger,
    allowedTools: Set<string>,
  ): Promise<ToolResultBlock> {
    const deny = (content: string): ToolResultBlock => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content,
      is_error: true,
    });

    const tool = toolRegistry.get(call.name);
    if (!tool) {
      return deny(`Unknown tool '${call.name}'.`);
    }
    if (!allowedTools.has(call.name)) {
      // A model asking for a capability its role does not have is a policy event
      // worth an operator's attention, not just a bad turn.
      runLogger.warn(
        { tool: call.name, agent: context.agentKey },
        'Agent attempted a tool outside its role',
      );
      return deny(
        `Tool '${call.name}' is not available to the '${context.agentKey}' role. ` +
          `Available tools: ${[...allowedTools].join(', ')}. ` +
          'Hand this off to the agent that owns the capability instead.',
      );
    }

    const validation = validateToolInput(tool.inputSchema, call.input);
    if (!validation.ok) {
      return deny(`Invalid arguments for '${call.name}': ${validation.errors.join('; ')}`);
    }

    const startedAt = Date.now();
    try {
      const output = await (
        tool.execute as (
          i: unknown,
          c: ToolContext,
        ) => Promise<{ output: string; isError?: boolean; data?: Record<string, unknown> }>
      )(validation.value, context);
      runLogger.debug(
        { tool: call.name, durationMs: Date.now() - startedAt },
        'Tool executed',
      );
      const changedPath =
        tool.mutating && typeof output.data?.path === 'string' ? (output.data.path) : undefined;
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: output.output || '(no output)',
        is_error: output.isError ?? false,
        changedPath,
      };
    } catch (err) {
      const message = toErrorMessage(err);
      if (err instanceof PermissionDeniedError) {
        // A denial is a security event worth surfacing to operators, and a
        // recoverable signal for the agent.
        runLogger.warn({ tool: call.name, input: call.input, message }, 'Permission denied');
      } else if (err instanceof ToolExecutionError) {
        runLogger.debug({ tool: call.name, message }, 'Tool execution error');
      } else {
        runLogger.error({ err, tool: call.name }, 'Unexpected tool failure');
      }
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: message,
        is_error: true,
      };
    }
  }
}

export const agentRuntime = new AgentRuntime();
