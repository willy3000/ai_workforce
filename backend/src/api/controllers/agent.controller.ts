import type { Request, Response } from 'express';
import { z } from 'zod';
import { agentRegistry } from '../../agents/registry';
import { agentRuntime } from '../../agents/agent-runtime';
import { agentRepository, messageRepository } from '../../database/repositories';
import { toolRegistry } from '../../tools/registry';
import { agentCoordinator } from '../../orchestrator/agent-coordinator';
import { taskRouter } from '../../orchestrator/task-router';
import { NotFoundError } from '../../utils/errors';

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
    const agent = agentRegistry.get(req.params.key!);
    if (!agent) throw new NotFoundError('Agent', req.params.key);
    res.json({
      agent: {
        ...agent,
        toolDefinitions: toolRegistry.toLlmDefinitions(agent.tools),
      },
    });
  },

  /** POST /api/agents/run — invoke one agent directly (ad-hoc, no workflow). */
  async run(req: Request, res: Response): Promise<void> {
    const input = RunAgentSchema.parse(req.body);
    if (!agentRegistry.has(input.agentKey)) throw new NotFoundError('Agent', input.agentKey);

    const result = await agentRuntime.run(input.agentKey, {
      projectId: input.projectId,
      taskId: input.taskId,
      prompt: input.prompt,
      additionalContext: input.additionalContext,
      maxIterations: input.maxIterations,
      provider: input.provider,
    });
    res.json({ result });
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
