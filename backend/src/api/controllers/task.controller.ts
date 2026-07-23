import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { taskRepository, messageRepository } from '../../database/repositories';
import { agentCoordinator } from '../../orchestrator/agent-coordinator';
import { taskRouter } from '../../orchestrator/task-router';
import { agentRegistry } from '../../agents/registry';
import { ValidationError } from '../../utils/errors';
import type { TaskStatus } from '../../database/models/task.model';

const CreateTaskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(3).max(300),
  description: z.string().max(20_000).default(''),
  type: z
    .enum([
      'analysis', 'planning', 'architecture', 'backend', 'frontend',
      'testing', 'review', 'documentation', 'bugfix', 'devops',
    ])
    .default('analysis'),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  assignedTo: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  /** Run the assigned agent immediately instead of leaving it in the backlog. */
  run: z.boolean().default(false),
});

export const taskController = {
  /** POST /api/tasks */
  async create(req: Request, res: Response): Promise<void> {
    const input = CreateTaskSchema.parse(req.body);

    if (input.assignedTo && !agentRegistry.has(input.assignedTo)) {
      throw new ValidationError(
        `Unknown agent '${input.assignedTo}'. Available: ${agentRegistry.keys().join(', ')}`,
      );
    }

    // Route now (not at execution time) so the operator sees the owner immediately.
    const routing = input.assignedTo
      ? null
      : taskRouter.route({ title: input.title, description: input.description, type: input.type });

    const task = await taskRepository.create({
      projectId: new Types.ObjectId(input.projectId),
      title: input.title,
      description: input.description,
      type: input.type,
      priority: input.priority,
      assignedTo: input.assignedTo ?? routing?.agentKey,
      createdBy: 'human',
      acceptanceCriteria: input.acceptanceCriteria,
      dependsOn: input.dependsOn.map((id) => new Types.ObjectId(id)),
      status: input.dependsOn.length ? 'backlog' : 'ready',
    });

    if (!input.run) {
      res.status(201).json({ task, routing });
      return;
    }

    const result = await agentCoordinator.runTask(task._id);
    const updated = await taskRepository.findByIdOrFail(task._id);
    res.status(201).json({ task: updated, routing, result });
  },

  /** GET /api/tasks?projectId=&status=&assignedTo= */
  async list(req: Request, res: Response): Promise<void> {
    const { projectId, status, assignedTo, workflowRunId } = req.query;
    const tasks = await taskRepository.list({
      projectId: typeof projectId === 'string' ? projectId : undefined,
      status: typeof status === 'string' ? (status as TaskStatus) : undefined,
      assignedTo: typeof assignedTo === 'string' ? assignedTo : undefined,
      workflowRunId: typeof workflowRunId === 'string' ? workflowRunId : undefined,
    });
    res.json({ tasks, count: tasks.length });
  },

  async get(req: Request, res: Response): Promise<void> {
    const task = await taskRepository.findByIdOrFail(req.params.id!);
    const thread = await messageRepository.thread(task._id);
    res.json({ task, messages: thread });
  },

  /** POST /api/tasks/:id/run — execute the owning agent now. */
  async run(req: Request, res: Response): Promise<void> {
    const result = await agentCoordinator.runTask(req.params.id!);
    const task = await taskRepository.findByIdOrFail(req.params.id!);
    res.json({ task, result });
  },

  /** POST /api/tasks/:id/approve — release a task parked at an approval gate. */
  async approve(req: Request, res: Response): Promise<void> {
    await agentCoordinator.approveTask(req.params.id!, (req.body?.approvedBy as string) ?? 'human');
    const task = await taskRepository.findByIdOrFail(req.params.id!);
    res.json({ task });
  },

  /** POST /api/tasks/:id/status — manual override by an operator. */
  async setStatus(req: Request, res: Response): Promise<void> {
    const schema = z.object({
      status: z.enum([
        'backlog', 'ready', 'in_progress', 'blocked', 'awaiting_review',
        'awaiting_approval', 'done', 'failed', 'cancelled',
      ]),
      note: z.string().max(2000).default(''),
    });
    const { status, note } = schema.parse(req.body);
    const task = await taskRepository.transition(req.params.id!, status, 'human', note);
    res.json({ task });
  },

  /** POST /api/tasks/run-ready — drain the runnable backlog for a project. */
  async runReady(req: Request, res: Response): Promise<void> {
    const schema = z.object({ projectId: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) });
    const { projectId, limit } = schema.parse(req.body);
    const results = await agentCoordinator.runReadyTasks(projectId, limit);
    res.json({ executed: results.length, results });
  },
};
