import type { Request, Response } from 'express';
import { z } from 'zod';
import { agentRegistry } from '../../agents/registry';
import { agentRuntime } from '../../agents/agent-runtime';
import {
  agentRepository,
  messageRepository,
  projectRepository,
  taskRepository,
} from '../../database/repositories';
import { toolRegistry } from '../../tools/registry';
import { agentCoordinator } from '../../orchestrator/agent-coordinator';
import { taskRouter } from '../../orchestrator/task-router';
import { executionRegistry } from '../../runtime/execution-registry';
import { auditActor } from '../middleware/auth';
import { NotFoundError, toErrorMessage } from '../../utils/errors';
import { truncate } from '../../utils/text';

const RunAgentSchema = z.object({
  agentKey: z.string().min(1),
  projectId: z.string().min(1),
  prompt: z.string().min(1).max(20_000),
  taskId: z.string().optional(),
  additionalContext: z.string().max(50_000).optional(),
  maxIterations: z.number().int().min(1).max(40).optional(),
  /** Override the LLM provider for this call, e.g. to compare answers. */
  provider: z.enum(['claude', 'gemini', 'ollama']).optional(),
});

export const agentController = {
  /** GET /api/agents — the roster, with capabilities, tools and permissions. */
  async list(_req: Request, res: Response): Promise<void> {
    const stats = await agentRepository.list();
    const statsByKey = new Map(stats.map((s) => [s.key, s.stats]));

    res.json({
      agents: agentRegistry.all().map((agent) => ({
        key: agent.key,
        name: agent.name,
        role: agent.role,
        description: agent.description,
        capabilities: agent.capabilities,
        tools: agent.tools,
        model: agent.model ?? '(platform default)',
        effort: agent.effort ?? '(platform default)',
        permissions: {
          canWrite: agent.permissions.writePaths.length > 0,
          writePaths: agent.permissions.writePaths,
          deniedPaths: agent.permissions.denyPaths,
          canRunCommands: agent.permissions.allowTerminal,
          allowedCommands: agent.permissions.allowedCommands,
          canWriteGit: agent.permissions.allowGitWrite,
          requiresHumanApproval: agent.permissions.requiresHumanApproval,
          maxToolCalls: agent.permissions.maxToolCalls,
        },
        stats: statsByKey.get(agent.key) ?? { runs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
      })),
    });
  },

  async get(req: Request, res: Response): Promise<void> {
    const agent = agentRegistry.get(req.params.key);
    if (!agent) throw new NotFoundError('Agent', req.params.key);
    res.json({
      agent: {
        ...agent,
        toolDefinitions: toolRegistry.toLlmDefinitions(agent.tools),
      },
    });
  },

  /**
   * POST /api/agents/run — invoke one agent directly (ad-hoc, no workflow).
   *
   * Audit finding E6/S7: this path bypassed the approval gate entirely. The
   * workflow engine checked `requiresHumanApproval`, the coordinator checked it,
   * and this endpoint did not — so a role the platform had decided must never
   * run unattended could be invoked unattended through the Org screen. It now
   * goes through the same single authorization policy as every other entry
   * point.
   *
   * It also now leaves a durable execution record. Previously an ad-hoc run with
   * no `taskId` wrote nothing but agent-wide token counters, so the work was
   * invisible in the timeline and unattributable afterwards.
   */
  async run(req: Request, res: Response): Promise<void> {
    const input = RunAgentSchema.parse(req.body);
    if (!agentRegistry.has(input.agentKey)) throw new NotFoundError('Agent', input.agentKey);

    // Direct invocation is never pre-approved: there is no approval receipt to
    // present, which is exactly why gated roles must refuse it.
    agentCoordinator.assertExecutionAllowed(input.agentKey, false);

    const project = await projectRepository.findByIdOrFail(input.projectId);

    // Every direct invocation gets a task, so it appears on the board, carries
    // its artifacts, and can be audited like any other work.
    const task = await taskRepository.create({
      projectId: project._id,
      title: `[Direct] ${truncate(input.prompt, 120)}`,
      description: input.prompt,
      type: 'analysis',
      status: 'in_progress',
      priority: 'medium',
      assignedTo: input.agentKey,
      createdBy: auditActor(req),
    });

    try {
      const result = await executionRegistry.withProjectLock(String(project._id), () =>
        agentRuntime.run(input.agentKey, {
          projectId: input.projectId,
          taskId: String(task._id),
          prompt: input.prompt,
          additionalContext: input.additionalContext,
          maxIterations: input.maxIterations,
          provider: input.provider,
        }),
      );

      await taskRepository.transition(
        task._id,
        result.succeeded ? 'done' : result.outcome === 'blocked' ? 'blocked' : 'failed',
        input.agentKey,
        `Direct invocation ended: ${result.outcome}`,
        { result: result.output, ...(result.error ? { error: result.error } : {}) },
      );
      res.json({ result, taskId: String(task._id) });
    } catch (err) {
      await taskRepository
        .transition(task._id, 'failed', input.agentKey, toErrorMessage(err), {
          error: toErrorMessage(err),
        })
        .catch(() => undefined);
      throw err;
    }
  },

  /** GET /api/agents/messages?projectId= — read the inter-agent message bus. */
  async messages(req: Request, res: Response): Promise<void> {
    const { projectId, to, from, taskId } = req.query;
    const messages = await messageRepository.list({
      projectId: typeof projectId === 'string' ? projectId : undefined,
      to: typeof to === 'string' ? to : undefined,
      from: typeof from === 'string' ? from : undefined,
      taskId: typeof taskId === 'string' ? taskId : undefined,
    });
    res.json({ messages, count: messages.length });
  },

  /** POST /api/agents/messages — inject a human message into the bus. */
  async sendMessage(req: Request, res: Response): Promise<void> {
    const schema = z.object({
      projectId: z.string().min(1),
      to: z.string().min(1),
      message: z.string().min(1).max(20_000),
      taskId: z.string().optional(),
      intent: z
        .enum(['instruction', 'question', 'clarification', 'review_request', 'status', 'handoff', 'escalation'])
        .default('instruction'),
    });
    const input = schema.parse(req.body);
    await agentCoordinator.sendMessage({ ...input, from: 'human' });
    res.status(201).json({ ok: true });
  },

  /** POST /api/agents/route — dry-run the router without creating a task. */
  async route(req: Request, res: Response): Promise<void> {
    const schema = z.object({
      title: z.string().min(1),
      description: z.string().default(''),
      type: z
        .enum([
          'analysis', 'planning', 'architecture', 'backend', 'frontend',
          'testing', 'review', 'documentation', 'bugfix', 'devops',
        ])
        .default('analysis'),
    });
    const input = schema.parse(req.body);
    res.json({ routing: taskRouter.route(input), candidates: taskRouter.candidates(input) });
  },
};
