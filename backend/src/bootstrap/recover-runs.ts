import { workflowRunRepository, taskRepository } from '../database/repositories';
import { logger } from '../utils/logger';

/**
 * Reconcile runs orphaned by a process that died mid-execution.
 *
 * Audit finding E4: "work continues in request memory; restart loses the
 * conversation and can replay partially completed side effects". Persisted step
 * records alone do not provide safe crash recovery, because nothing
 * distinguishes *running here* from *running in a process that no longer
 * exists*. Both looked like `status: 'running'` forever.
 *
 * The lease closes that gap. A run carries `leaseOwner` and `leaseExpiresAt`,
 * refreshed as it works; a lease in the past means no live worker owns it.
 *
 * ## Why this marks rather than resumes
 * Auto-resuming would replay the interrupted step, and the platform cannot yet
 * prove that step's side effects are idempotent — it may have written files,
 * created a branch, or opened a pull request before dying. Re-running it could
 * duplicate those. So recovery marks the run `interrupted` with an explicit
 * account of where it stopped, and an operator decides. `interrupted` is a
 * claimable status, so pressing Resume works normally.
 *
 * Making replay safe (idempotency keys on publication, a committed-work
 * checkpoint per step) is the prerequisite for automatic resumption, and is the
 * reason this function does not attempt it today.
 */
export async function recoverOrphanedRuns(): Promise<{ recovered: number }> {
  const orphaned = await workflowRunRepository.findOrphaned(new Date());
  if (!orphaned.length) return { recovered: 0 };

  logger.warn(
    { count: orphaned.length, runIds: orphaned.map((r) => String(r._id)) },
    'Found workflow runs with no live owner — marking interrupted',
  );

  let recovered = 0;
  for (const run of orphaned) {
    const runId = String(run._id);
    try {
      const marked = await workflowRunRepository.setStatusIfNotTerminal(runId, 'interrupted', {
        error:
          'The process executing this run stopped unexpectedly. Any files it had already written ' +
          'are still in the checkout. Review the steps below, then Resume to continue or Cancel ' +
          'to stop.',
      });
      if (!marked) continue;

      // A task left `in_progress` by the dead process is equally orphaned, and
      // would otherwise block its own retry: `runTask` refuses a task that is
      // already running, so it would be stuck until edited by hand.
      const stranded = await taskRepository.list({ workflowRunId: run._id, status: 'in_progress' }, 50);
      for (const task of stranded) {
        await taskRepository
          .transition(task._id, 'ready', 'recovery', 'Reset after its worker stopped unexpectedly')
          .catch((err) => logger.warn({ err, taskId: String(task._id) }, 'Could not reset stranded task'));
      }

      recovered += 1;
    } catch (err) {
      logger.error({ err, runId }, 'Failed to recover orphaned run');
    }
  }

  logger.info({ recovered }, 'Run recovery complete');
  return { recovered };
}
