import type { Request, Response } from 'express';
import { z } from 'zod';
import { workflowEngine } from '../../workflows/engine';
import { workflowRegistry } from '../../workflows';
import { workflowRunRepository, taskRepository } from '../../database/repositories';
import { auditActor } from '../middleware/auth';

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
   * Accepts the run and returns immediately with its id and `queued` status.
   *
   * Audit finding E4 plus the launch-feedback UX finding: this used to execute
   * the entire workflow inside the HTTP request. A six-agent feature run could
   * take many minutes, so the browser held a connection open for the duration,
   * the run id arrived only at the end, and any proxy timeout in between
   * orphaned work that was still running. The client now navigates to the run
   * page in milliseconds and watches it progress.
   */
  async start(req: Request, res: Response): Promise<void> {
    const input = StartSchema.parse(req.body);
    const run = await workflowEngine.start({
      ...input,
      // The client's label is preserved, but the authoritative actor is derived
      // server-side — a client-supplied `startedBy` is not an identity (S8).
      startedBy: auditActor(req, input.startedBy),
    });
    res
      .status(202)
      .location(`/api/workflows/runs/${String(run._id)}`)
      .json({
        run,
        message:
          input.autoRun === false
            ? 'Run created without executing. Resume it when ready.'
            : 'Run accepted and queued. Poll this run for progress.',
      });
  },

  async listRuns(req: Request, res: Response): Promise<void> {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const runs = await workflowRunRepository.list(projectId);
    res.json({ runs, count: runs.length });
  },

  async getRun(req: Request, res: Response): Promise<void> {
    const run = await workflowRunRepository.findByIdOrFail(req.params.id);
    const tasks = await taskRepository.list({ workflowRunId: run._id });
    res.json({ run, tasks });
  },

  /** POST /api/workflows/runs/:id/approve — release a gated step and continue. */
  async approveStep(req: Request, res: Response): Promise<void> {
    const schema = z.object({ stepId: z.string().min(1), approvedBy: z.string().max(120).optional() });
    const { stepId, approvedBy } = schema.parse(req.body);
    const run = await workflowEngine.approveStep(req.params.id, stepId, auditActor(req, approvedBy));
    res.status(202).json({ run, message: 'Step approved. The run has resumed.' });
  },

  /** POST /api/workflows/runs/:id/resume — continue a paused or interrupted run. */
  async resume(req: Request, res: Response): Promise<void> {
    const run = await workflowEngine.resume(req.params.id);
    res.status(202).json({ run, message: 'Run resumed.' });
  },

  /**
   * POST /api/workflows/runs/:id/cancel
   *
   * Answers with what actually happened rather than a bare `ok`. A run executing
   * here enters `cancelling` and confirms when its worker stops; a run that was
   * not executing is `cancelled` immediately. The UI shows the difference,
   * because "stopping" and "stopped" are different promises (audit finding E1).
   */
  async cancel(req: Request, res: Response): Promise<void> {
    const schema = z.object({ reason: z.string().max(500).optional() });
    const { reason } = schema.parse(req.body ?? {});
    const outcome = await workflowEngine.cancel(
      req.params.id,
      reason ?? 'Cancelled by operator',
      auditActor(req),
    );
    const run = await workflowRunRepository.findByIdOrFail(req.params.id);
    res.json({ ...outcome, run });
  },
};
