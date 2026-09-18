'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '@/lib/api';
import { useAction, useElapsed, usePoll } from '@/lib/hooks';
import { AGENT_STATE, agentIdentity } from '@/lib/agent-visuals';
import { runVisualState } from '@/app/page';
import { RunFlow, RunTimeline } from '@/components/viz/RunFlow';
import { ChangeSetPanel } from '@/components/panels/ChangeSetPanel';
import { AgentAvatar, AgentStateBadge } from '@/components/agents/AgentAvatar';
import { Button, ErrorNote, OutputBlock, Spinner } from '@/components/ui';
import { TaskBoard } from '@/components/panels/TaskBoard';
import { duration, timeAgo } from '@/lib/format';
import type { WorkflowRun } from '@/lib/types';

/**
 * A single run, live.
 *
 * ## Ordering, which is the whole redesign
 * The audit's finding was that "text reports dominate" and that a reviewer had
 * no authoritative diff, no test verdict and no guaranteed deliverable. So this
 * page is ordered by what a reviewer needs, in the order they need it:
 *
 *  1. **Verdict** — what the run achieved, from `outcome`, not from whether the
 *     engine reached the last step.
 *  2. **Evidence** — files changed, checks run and their exit codes, commits,
 *     pull request. All recorded by the platform from observed effects.
 *  3. **Flow** — where the work is now and who has it.
 *  4. **Narrative** — the agents' own prose, last, because it is the part the
 *     platform cannot vouch for.
 *
 * ## Polling
 * Fast while the run is live, stopped entirely once it reaches a terminal state.
 * The old page polled every 2.5s forever, including for runs that finished days
 * ago.
 */
const LIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  // `paused` is computed from the previous poll's data, so a finished run stops
  // costing requests the moment it finishes.
  const [terminal, setTerminal] = useState(false);
  const run = usePoll((signal) => api.getRun(id, signal), { intervalMs: 2500, paused: terminal }, [id]);

  const data = run.data;
  const r = data?.run;

  // Derive the pause flag as a side effect of rendering fresh data rather than
  // in an effect: it only ever transitions once, in one direction.
  if (r && TERMINAL_STATUSES.has(r.status) && !terminal) setTerminal(true);

  const approve = useAction(api.approveStep);
  const resume = useAction(api.resumeRun);
  const cancel = useAction(api.cancelRun);

  const elapsed = useElapsed(r?.startedAt ?? r?.createdAt, r?.completedAt);

  const selectedStep = useMemo(
    () => r?.steps.find((s) => s.id === selectedStepId) ?? null,
    [r, selectedStepId],
  );

  if (run.error && !data) return <ErrorNote message={run.error} onRetry={run.refresh} />;
  if (!data || !r) return <Spinner label="Loading run" />;

  const busy = approve.pending || resume.pending || cancel.pending;
  const live = LIVE_STATUSES.has(r.status);
  const actionError = approve.error ?? resume.error ?? cancel.error;

  const refresh = () => {
    setTerminal(false);
    run.refresh();
  };

  return (
    <div className="space-y-5">
      <RunHeader
        run={r}
        elapsed={elapsed}
        stale={run.stale}
        busy={busy}
        onResume={async () => {
          await resume.execute(id);
          refresh();
        }}
        onCancel={async () => {
          await cancel.execute(id);
          refresh();
        }}
      />

      {actionError && <ErrorNote message={actionError} />}

      {cancel.result && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-lg border px-3 py-2 text-[12px]"
          style={{
            borderColor: 'color-mix(in srgb, var(--status-warning) 40%, transparent)',
            color: 'var(--status-warning)',
          }}
        >
          {cancel.result.message}
        </motion.p>
      )}

      <Verdict run={r} />

      <section className="panel p-4">
        <header className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-[13px] font-semibold">Where the work is</h2>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Each step is a real task you can open
          </span>
        </header>
        <RunFlow run={r} selectedStepId={selectedStepId} onSelectStep={setSelectedStepId} />
      </section>

      <AnimatePresence>
        {selectedStep && (
          <motion.section
            key={selectedStep.id}
            layout
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="panel p-4"
            style={{ ['--accent' as string]: agentIdentity(selectedStep.agentKey).color }}
          >
            <StepDetail
              step={selectedStep}
              busy={busy}
              onApprove={async () => {
                await approve.execute(id, selectedStep.id);
                refresh();
              }}
              onClose={() => setSelectedStepId(null)}
            />
          </motion.section>
        )}
      </AnimatePresence>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,1fr)]">
        <ChangeSetPanel run={r} />

        <section className="panel p-4">
          <h2 className="mb-3 text-[13px] font-semibold">Timeline</h2>
          <RunTimeline run={r} selectedStepId={selectedStepId} onSelectStep={setSelectedStepId} />
        </section>
      </div>

      <section className="panel p-4">
        <header className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold">Tasks this run created</h2>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {data.tasks.length}
          </span>
        </header>
        <TaskBoard tasks={data.tasks} onChanged={refresh} />
      </section>

      <details className="panel p-4">
        <summary className="cursor-pointer text-[13px] font-semibold">
          Handoffs between steps
          <span className="ml-2 text-[11px] font-normal" style={{ color: 'var(--text-muted)' }}>
            what each agent actually passed to the next
          </span>
        </summary>
        <ContextHandoffs context={r.context} />
      </details>
    </div>
  );
}

function RunHeader({
  run,
  elapsed,
  stale,
  busy,
  onResume,
  onCancel,
}: {
  run: WorkflowRun;
  elapsed: number | null;
  stale: boolean;
  busy: boolean;
  onResume: () => void;
  onCancel: () => void;
}) {
  const state = runVisualState(run);
  const style = AGENT_STATE[state];
  const canResume = ['failed', 'awaiting_approval', 'interrupted', 'pending'].includes(run.status);
  const canCancel = LIVE_STATUSES.has(run.status) || run.status === 'awaiting_approval';

  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <nav className="mb-1 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <Link href="/runs" className="hover:underline">
            Runs
          </Link>
          <span aria-hidden>/</span>
          <span className="hud">{run.workflow}</span>
        </nav>

        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="max-w-3xl text-[17px] font-semibold leading-snug tracking-tight">
            {run.request}
          </h1>
          <AgentStateBadge state={state} />
        </div>

        <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <span>Started by {run.startedBy}</span>
          <span aria-hidden>·</span>
          <span>{timeAgo(run.createdAt)}</span>
          {elapsed !== null && (
            <>
              <span aria-hidden>·</span>
              {/* Frozen on terminal states — `useElapsed` stops ticking once an
                  end time exists, which is what the audit found broken. */}
              <span className="hud">{formatElapsed(elapsed)}</span>
            </>
          )}
          {stale && (
            <>
              <span aria-hidden>·</span>
              <span style={{ color: 'var(--status-warning)' }}>showing last known state</span>
            </>
          )}
        </p>
      </div>

      <div className="flex shrink-0 gap-2">
        {canResume && (
          <Button size="sm" disabled={busy} onClick={onResume}>
            Resume
          </Button>
        )}
        {canCancel && (
          <Button size="sm" variant="danger" disabled={busy} onClick={onCancel} title={style.hint}>
            Stop run
          </Button>
        )}
      </div>
    </header>
  );
}

/**
 * The verdict banner.
 *
 * This is the single most important addition from the audit: "workflow
 * completed" used to mean only that the engine traversed its steps. The backend
 * now records a real outcome, and this states it in a sentence — including the
 * uncomfortable ones, because a platform that cannot say "this needs review"
 * cannot be trusted when it says "this is done".
 */
function Verdict({ run }: { run: WorkflowRun }) {
  if (!run.outcome && !TERMINAL_STATUSES.has(run.status)) return null;

  const copy: Record<string, { title: string; body: string; color: string; glyph: string }> = {
    delivered: {
      title: 'Delivered',
      body: 'Every step completed and the checks that ran passed. Review the change below before merging.',
      color: 'var(--status-good)',
      glyph: '✓',
    },
    needs_review: {
      title: 'Needs your review',
      body: 'The run finished, but something did not go cleanly — a step asked for review, failed, or ran without verification. Read the evidence before trusting this.',
      color: 'var(--status-warning)',
      glyph: '⏸',
    },
    blocked: {
      title: 'Blocked',
      body: 'An agent reported it could not proceed. Its reason is on the step below.',
      color: 'var(--status-serious)',
      glyph: '⚠',
    },
    failed: {
      title: 'Failed',
      body: 'A required step did not complete. Any changes already written to the checkout are listed below and were not discarded.',
      color: 'var(--status-critical)',
      glyph: '✕',
    },
    cancelled: {
      title: 'Cancelled',
      body: 'Stopped before finishing. Changes already written are kept — review them and decide whether to keep or revert.',
      color: 'var(--text-muted)',
      glyph: '⊘',
    },
  };

  const outcome = run.outcome ?? (run.status === 'completed' ? 'delivered' : 'failed');
  const v = copy[outcome] ?? copy.needs_review!;

  return (
    <motion.section
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="panel rail-top p-4"
      style={{ ['--accent' as string]: v.color }}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-[16px] leading-none" style={{ color: v.color }}>
          {v.glyph}
        </span>
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold" style={{ color: v.color }}>
            {v.title}
          </h2>
          <p className="mt-0.5 max-w-2xl text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {v.body}
          </p>
          {run.error && (
            <p className="mt-1.5 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {run.error}
            </p>
          )}
        </div>
      </div>
    </motion.section>
  );
}

/** One step, expanded: who ran it, what happened, and its output. */
function StepDetail({
  step,
  busy,
  onApprove,
  onClose,
}: {
  step: WorkflowRun['steps'][number];
  busy: boolean;
  onApprove: () => void;
  onClose: () => void;
}) {
  const identity = agentIdentity(step.agentKey);

  return (
    <>
      <div className="flex items-start gap-3.5">
        <AgentAvatar agentKey={step.agentKey} state={step.status === 'running' ? 'running' : 'idle'} size={52} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold">{step.name}</h3>
          <p className="text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
            {identity.role} · {identity.purpose}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {step.outcome && <span>Outcome: {step.outcome.replace(/_/g, ' ')}</span>}
            {step.startedAt && <span>· {duration(step.startedAt, step.completedAt)}</span>}
            {step.usage && (
              <span className="hud">
                · {(step.usage.inputTokens + step.usage.outputTokens).toLocaleString()} tokens,{' '}
                {step.usage.toolCalls} tool calls
              </span>
            )}
            {step.attempt && step.attempt > 1 && (
              <span style={{ color: 'var(--status-warning)' }}>· attempt {step.attempt}</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {step.status === 'awaiting_approval' && (
            <Button size="sm" variant="primary" disabled={busy} onClick={onApprove}>
              Approve step
            </Button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close step details"
            className="rounded-md px-2 py-0.5 text-[13px]"
            style={{ color: 'var(--text-muted)' }}
          >
            ✕
          </button>
        </div>
      </div>

      {step.error && (
        <p
          className="mt-3 rounded-md border px-2.5 py-2 font-mono text-[11px]"
          style={{
            borderColor: 'color-mix(in srgb, var(--status-critical) 35%, transparent)',
            color: 'var(--status-critical)',
          }}
        >
          {step.error}
        </p>
      )}

      {step.output && (
        <div className="mt-3">
          <p className="eyebrow mb-1.5">Agent report</p>
          <OutputBlock text={step.output} maxHeight={280} />
        </div>
      )}
    </>
  );
}

function ContextHandoffs({ context }: { context: Record<string, string> | null | undefined }) {
  const entries = Object.entries(context ?? {}).filter(([k]) => !k.startsWith('__'));
  if (!entries.length) {
    return (
      <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
        Nothing handed off yet.
      </p>
    );
  }
  return (
    <div className="mt-3 grid gap-2 lg:grid-cols-2">
      {entries.map(([stepId, value]) => (
        <details key={stepId} className="rounded-lg border p-2.5" style={{ background: 'var(--surface-0)' }}>
          <summary className="cursor-pointer text-[11px] font-medium">
            <code className="hud">{`{{steps.${stepId}}}`}</code>
            <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>
              {value.length.toLocaleString()} chars
            </span>
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[10.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {value}
          </pre>
        </details>
      ))}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
