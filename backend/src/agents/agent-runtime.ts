import { Types } from 'mongoose';
import { agentRegistry } from './registry';
import type { AgentDefinition, AgentRunInput, AgentRunResult } from './types';
import { toolRegistry } from '../tools/registry';
import type { ToolContext } from '../tools/types';
import { contextBuilder } from '../memory/context-builder';
import { effectiveProviderName, resolveProvider } from '../services/llm/provider-registry';
import type { LlmMessage, ToolResultBlock } from '../services/llm/types';
import { Workspace } from '../integrations/filesystem/workspace';
import { GitManager } from '../integrations/github/git-manager';
import {
  agentRepository,
  codeRepositoryRepository,
  projectRepository,
  taskRepository,
} from '../database/repositories';
import { env } from '../config/env';
import { logger } from '../utils/logger';
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

    const context: ToolContext = {
      projectId,
      taskId: task?._id,
      workflowRunId: input.workflowRunId ? new Types.ObjectId(input.workflowRunId) : undefined,
      agentKey,
      permissions: definition.permissions,
      project,
      repository: repository ?? undefined,
      workspace,
      git: repository ? new GitManager(workspacePath) : undefined,
      logger: runLogger,
      recordArtifact: async (artifact) => {
        if (!task) return;
        await taskRepository.addArtifact(task._id, { ...artifact, createdAt: new Date() });
      },
    };

    const system = contextBuilder.buildSystemPrompt(definition, project);
    const user = await contextBuilder.buildUserMessage({
      projectId,
      agentKey,
      prompt: input.prompt,
      task,
      additionalContext: input.additionalContext,
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

    const result: AgentRunResult = {
      agentKey: definition.key,
      provider: providerName,
      output: '',
      stopReason: 'end_turn',
      iterations: 0,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      thinking: [],
    };

    let lastText = '';

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      result.iterations = iteration;

      const response = await provider.complete({
        system,
        messages,
        tools,
        model: definition.model,
        effort: definition.effort,
        showThinking: definition.auditThinking,
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
        result.error =
          `The model declined this request (${response.refusal?.category ?? 'policy'}). ` +
          'Rephrase the task or escalate to a human — retrying verbatim will not help.';
        runLogger.warn({ refusal: response.refusal }, 'Agent run refused');
        break;
      }

      if (response.stopReason === 'max_tokens') {
        result.output = lastText;
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
        break;
      }

      // --- Tool-use turn ----------------------------------------------------
      messages.push({ role: 'assistant', content: response.content as never });

      const toolResults: ToolResultBlock[] = [];
      for (const call of response.toolUses) {
        if (result.usage.toolCalls >= definition.permissions.maxToolCalls) {
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

        const executed = await this.executeTool(call, context, runLogger);
        result.usage.toolCalls += 1;
        result.toolCalls.push({
          name: call.name,
          input: call.input,
          ok: !executed.is_error,
          summary: truncate(executed.content, 400),
        });

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
      messages.push({ role: 'user', content: toolResults as never });

      // The agent declared it is done: stop rather than paying for another turn.
      if (result.completion) {
        result.output = lastText;
        break;
      }

      if (iteration === maxIterations) {
        result.output = lastText;
        result.error = `Reached the ${maxIterations}-iteration limit without a completion report.`;
        runLogger.warn({ iterations: iteration }, 'Agent hit iteration limit');
      }
    }

    if (!result.output) result.output = lastText;

    await agentRepository.recordRun(definition.key, result.usage).catch((err) => {
      runLogger.warn({ err }, 'Failed to record agent stats (non-fatal)');
    });

    runLogger.info(
      {
        iterations: result.iterations,
        toolCalls: result.usage.toolCalls,
        stopReason: result.stopReason,
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
   * Every failure mode — unknown tool, permission denial, tool error, unexpected
   * exception — becomes an `is_error` tool result rather than an exception. The
   * model is a participant in error recovery: told "you may not write there, hand
   * it to the backend engineer", it does exactly that.
   */
  private async executeTool(
    call: { id: string; name: string; input: Record<string, unknown> },
    context: ToolContext,
    runLogger: typeof logger,
  ): Promise<ToolResultBlock> {
    const tool = toolRegistry.get(call.name);
    if (!tool) {
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `Unknown tool '${call.name}'.`,
        is_error: true,
      };
    }

    const startedAt = Date.now();
    try {
      const output = await (tool.execute as (i: unknown, c: ToolContext) => Promise<{ output: string; isError?: boolean }>)(
        call.input,
        context,
      );
      runLogger.debug(
        { tool: call.name, durationMs: Date.now() - startedAt },
        'Tool executed',
      );
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: output.output || '(no output)',
        is_error: output.isError ?? false,
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
