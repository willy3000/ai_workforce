import { env } from '../config/env';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * In-process execution state: what is running, how to stop it, and who may
 * touch a given checkout.
 *
 * Three audit findings converge here.
 *
 * **E1 — cancellation did nothing.** `cancel()` wrote `status: 'cancelled'` to
 * Mongo and returned. The agent loop, the provider call and any spawned process
 * kept running, and the run's own completion write later overwrote the
 * cancellation — so the operator saw "cancelled", then saw it turn "completed",
 * having paid for the whole run. Cancellation now owns an `AbortController`
 * whose signal reaches the provider call and the process tree, and the engine
 * checks `throwIfCancelled()` before every side effect.
 *
 * **E5 — one checkout, many writers.** Every run for a project shares
 * `workspaces/<projectId>`, and nothing prevented two runs from editing it at
 * once. `withProjectLock` serializes all access. Real parallelism needs one
 * checkout per run, which is a larger change; serializing first means the
 * platform is correct now and faster later, rather than fast and wrong.
 *
 * **S9 — unbounded admission.** `MAX_CONCURRENT_RUNS` caps how much work exists
 * at once, so a burst of accepted runs queues instead of thrashing the host.
 *
 * ## Scope
 * Process-local. A second API replica has its own registry and would not see
 * these locks, which is exactly why the durable lease in `workflow_runs`
 * (`claimForExecution`) is the authority on ownership and this is the fast path.
 * The lease is what survives a crash; this is what makes cancellation immediate.
 */

export class RunCancelledError extends AppError {
  constructor(public readonly reason: string) {
    super(`Run cancelled: ${reason}`, 409, 'run_cancelled');
  }
}

interface ActiveExecution {
  runId: string;
  projectId: string;
  controller: AbortController;
  startedAt: number;
  /** Set when a cancellation was requested, so the reason survives to the error. */
  cancelReason?: string;
  deadlineTimer: NodeJS.Timeout;
}

class ExecutionRegistry {
  private readonly active = new Map<string, ActiveExecution>();
  /** projectId → promise chain tail; awaiting it means waiting your turn. */
  private readonly projectLocks = new Map<string, Promise<unknown>>();

  get activeCount(): number {
    return this.active.size;
  }

  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /**
   * Register a run as executing and return its abort signal.
   *
   * Rejects when the process is already at capacity, so admission is refused
   * with a 429 the caller can act on rather than by degrading every run.
   */
  begin(runId: string, projectId: string): AbortSignal {
    if (this.active.has(runId)) {
      throw new AppError(
        `Run ${runId} is already executing in this process`,
        409,
        'run_already_executing',
      );
    }
    if (this.active.size >= env.MAX_CONCURRENT_RUNS) {
      throw new AppError(
        `This instance is already executing ${this.active.size} runs (limit ${env.MAX_CONCURRENT_RUNS}). ` +
          'The run stays queued — retry shortly or wait for a slot.',
        429,
        'capacity_exhausted',
      );
    }

    const controller = new AbortController();
    // A run that never terminates is indistinguishable from one that is merely
    // slow, so give every run a hard wall-clock ceiling (audit: "total run
    // deadline"). The timer is unref'd so it cannot hold the process open.
    const deadlineTimer = setTimeout(() => {
      this.cancel(runId, `exceeded the ${env.RUN_DEADLINE_MS}ms run deadline`);
    }, env.RUN_DEADLINE_MS);
    deadlineTimer.unref?.();

    this.active.set(runId, {
      runId,
      projectId,
      controller,
      startedAt: Date.now(),
      deadlineTimer,
    });
    logger.debug({ runId, projectId, active: this.active.size }, 'Execution registered');
    return controller.signal;
  }

  /** Deregister a finished run. Safe to call for a run that was never begun. */
  end(runId: string): void {
    const execution = this.active.get(runId);
    if (!execution) return;
    clearTimeout(execution.deadlineTimer);
    this.active.delete(runId);
    logger.debug({ runId, active: this.active.size }, 'Execution deregistered');
  }

  /**
   * Request cancellation. Returns false when the run is not executing here —
   * the caller still records the intent durably, so a run owned by another
   * replica stops at its next checkpoint.
   */
  cancel(runId: string, reason: string): boolean {
    const execution = this.active.get(runId);
    if (!execution) return false;
    execution.cancelReason = reason;
    execution.controller.abort();
    logger.info({ runId, reason }, 'Cancellation signalled to running execution');
    return true;
  }

  /** The signal for a live run, for handing to a provider or a child process. */
  signalFor(runId: string): AbortSignal | undefined {
    return this.active.get(runId)?.controller.signal;
  }

  cancelReason(runId: string): string | undefined {
    return this.active.get(runId)?.cancelReason;
  }

  /**
   * Throw if this run has been cancelled.
   *
   * Called before every durable effect — writing a file, committing, opening a
   * PR, starting the next step — so "cancelled" means no *further* effects, a
   * promise the platform can actually keep. Effects already applied are reported
   * to the operator rather than silently rolled back.
   */
  throwIfCancelled(runId: string | undefined): void {
    if (!runId) return;
    const execution = this.active.get(runId);
    if (execution?.controller.signal.aborted) {
      throw new RunCancelledError(execution.cancelReason ?? 'cancelled by operator');
    }
  }

  /**
   * Run `fn` holding the project's checkout lock.
   *
   * Implemented as a promise chain rather than a counter so waiters queue in
   * arrival order and a thrown error still releases the lock (the `catch`
   * swallows only the *chaining* rejection, never the caller's).
   */
  async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.projectLocks.get(projectId) ?? Promise.resolve();

    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The new tail settles only after both the queue ahead of us and our own
    // turn are done. `previous` is consumed with a swallowed rejection so one
    // failed holder cannot poison the queue for everyone behind it — the
    // caller's own error still propagates from the `try` below.
    const tail = previous.catch(() => undefined).then(() => mine);
    this.projectLocks.set(projectId, tail);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      // Drop the map entry only if nobody queued behind us in the meantime,
      // so the map does not retain one promise per project seen since boot.
      void tail.then(() => {
        if (this.projectLocks.get(projectId) === tail) this.projectLocks.delete(projectId);
      });
    }
  }

  /** True when a project's checkout is currently held. Diagnostics only. */
  isProjectLocked(projectId: string): boolean {
    return this.projectLocks.has(projectId);
  }

  /** Cancel everything, for graceful shutdown. */
  cancelAll(reason: string): string[] {
    const ids = this.activeRunIds();
    for (const id of ids) this.cancel(id, reason);
    return ids;
  }
}

export const executionRegistry = new ExecutionRegistry();
