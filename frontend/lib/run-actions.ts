import type { WorkflowRun } from './types';

type RunState = Pick<WorkflowRun, 'status' | 'outcome'>;

export function runNeedsAttention(run: RunState): boolean {
  return ['awaiting_approval', 'interrupted', 'failed'].includes(run.status)
    || (run.status === 'completed' && ['needs_review', 'blocked'].includes(run.outcome ?? ''));
}

export function canResumeRun(run: RunState): boolean {
  return ['failed', 'interrupted', 'pending'].includes(run.status)
    || (run.status === 'completed' && ['needs_review', 'blocked'].includes(run.outcome ?? ''));
}
