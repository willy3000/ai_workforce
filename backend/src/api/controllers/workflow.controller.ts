import type { Request, Response } from 'express';
import { z } from 'zod';
import { workflowEngine } from '../../workflows/engine';
import { workflowRegistry } from '../../workflows';
import { workflowRunRepository, taskRepository } from '../../database/repositories';

const StartSchema = z.object({
  projectId: z.string().min(1),
  workflow: z.string().min(1),
  request: z.string().min(3).max(20_000),
  startedBy: z.string().max(120).optional(),
  /** false = materialise the plan without executing it (dry run). */
  autoRun: z.boolean().default(true),
});

export const workflowController = {
  /** GET /api/workflows — the catalogue, including each workflow's step graph. */
  async list(_req: Request, res: Response): Promise<void> {
    res.json({
      workflows: workflowRegistry.all().map((w) => ({
        key: w.key,
        name: w.name,
        description: w.description,
        trigger: w.trigger,
        steps: w.steps.map((s) => ({
          id: s.id,
          name: s.name,
          agent: s.agentKey,
          dependsOn: s.dependsOn ?? [],
          conditional: Boolean(s.skipWhen),
          optional: Boolean(s.optional),
          requiresApproval: Boolean(s.requiresApproval),
        })),
      })),
    });
  },

  /**
   * POST /api/workflows/run
   *
   * Long-running by nature: a feature-development run executes several agents.
   * The response returns the completed (or paused) run document. For a UI,
   * poll GET /api/workflows/runs/:id while it executes.
   */
  async start(req: Request, res: Response): Promise<void> {
    const input = StartSchema.parse(req.body);
    const run = await workflowEngine.start(input);
    res.status(201).json({ run });
  },

  async listRuns(req: Request, res: Response): Promise<void> {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const runs = await workflowRunRepository.list(projectId);
    res.json({ runs, count: runs.length });
  },

  async getRun(req: Request, res: Response): Promise<void> {
    const run = await workflowRunRepository.findByIdOrFail(req.params.id!);
    const tasks = await taskRepository.list({ workflowRunId: run._id });
    res.json({ run, tasks });
  },

  /** POST /api/workflows/runs/:id/approve — release a gated step and continue. */
  async approveStep(req: Request, res: Response): Promise<void> {
    const schema = z.object({ stepId: z.string().min(1), approvedBy: z.string().default('human') });
    const { stepId, approvedBy } = schema.parse(req.body);
    const run = await workflowEngine.approveStep(req.params.id!, stepId, approvedBy);
    res.json({ run });
  },

  /** POST /api/workflows/runs/:id/resume — continue a paused or failed run. */
  async resume(req: Request, res: Response): Promise<void> {
    const run = await workflowEngine.resume(req.params.id!);
    res.json({ run });
  },

  async cancel(req: Request, res: Response): Promise<void> {
    await workflowEngine.cancel(req.params.id!, (req.body?.reason as string) ?? 'Cancelled by operator');
    res.json({ ok: true });
  },
};
