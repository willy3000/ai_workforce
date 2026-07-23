'use client';

import { use } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { usePoll, useAction } from '@/lib/hooks';
import { isActive } from '@/lib/design';
import { duration, timeAgo } from '@/lib/format';
import { Button, Card, ErrorNote, SectionTitle, Spinner, StatusPill } from '@/components/ui';
import { WorkflowPipeline } from '@/components/viz/WorkflowPipeline';
import { AgentNetwork } from '@/components/viz/AgentNetwork';
import { DataFlowMap } from '@/components/viz/DataFlowMap';
import { TaskBoard } from '@/components/panels/TaskBoard';

/**
 * A single run, live.
 *
 * Polls faster while the run is active and backs off once it reaches a terminal
 * state — a finished run does not need to be re-fetched every two seconds.
 */
export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const run = usePoll(() => api.getRun(id), 2500, [id]);
  const agents = usePoll(() => api.listAgents(), 20_000);

  const approve = useAction(api.approveStep);
  const resume = useAction(api.resumeRun);
  const cancel = useAction(api.cancelRun);

  if (run.error) return <ErrorNote message={run.error} onRetry={run.refresh} />;
  if (!run.data) return <Spinner label="Loading run" />;

  const { run: r, tasks } = run.data;
  const active = isActive(r.status);
  const activeAgents = r.steps.filter((s) => s.status === 'running').map((s) => s.agentKey);
  const busy = approve.pending || resume.pending || cancel.pending;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/runs" className="text-xs text-[var(--text-muted)] hover:underline">
              Runs
            </Link>
            <span aria-hidden className="text-xs text-[var(--text-muted)]">/</span>
            <h1 className="text-lg font-semibold tracking-tight">{r.workflow}</h1>
            <StatusPill status={r.status} size="xs" />
            {active && (
              <span
                aria-hidden
                className="h-2 w-2 animate-pulse rounded-full"
                style={{ background: 'var(--series-1)' }}
              />
            )}
          </div>
          <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">{r.request}</p>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            Started by {r.startedBy} · {timeAgo(r.createdAt)} · running{' '}
            {duration(r.createdAt, r.status === 'completed' ? undefined : undefined)}
          </p>
        </div>
        <div className="flex gap-2">
          {(r.status === 'failed' || r.status === 'awaiting_approval') && (
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                await resume.execute(id);
                run.refresh();
              }}
            >
              Resume
            </Button>
          )}
          {active && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={async () => {
                await cancel.execute(id);
                run.refresh();
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>

      {(approve.error || resume.error || cancel.error) && (
        <ErrorNote message={(approve.error ?? resume.error ?? cancel.error)!} />
      )}

      <div className="grid gap-5 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          <SectionTitle
            title="Execution timeline"
            hint="Each step creates a real task, so nothing here is a black box."
          />
          <WorkflowPipeline
            run={r}
            busy={busy}
            onApprove={async (stepId) => {
              await approve.execute(id, stepId);
              run.refresh();
            }}
            onResume={async () => {
              await resume.execute(id);
              run.refresh();
            }}
          />
        </Card>

        <div className="space-y-5">
          <Card>
            <SectionTitle
              title="Who is working"
              hint={activeAgents.length ? 'Animated edges show data moving between roles right now.' : 'No agent is currently executing.'}
            />
            {agents.data ? (
              <AgentNetwork agents={agents.data.agents} activeAgents={activeAgents} />
            ) : (
              <div className="skeleton h-64 rounded-lg" />
            )}
          </Card>

          {r.summary && (
            <Card>
              <SectionTitle title="Summary" />
              <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-secondary)]">
                {r.summary}
              </pre>
            </Card>
          )}
        </div>
      </div>

      <Card>
        <SectionTitle
          title="Context passed between steps"
          hint="Each step's output is threaded into the next step's prompt — this is the handoff, verbatim."
        />
        {Object.keys(r.context).filter((k) => !k.startsWith('__')).length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">Nothing handed off yet.</p>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {Object.entries(r.context)
              .filter(([k]) => !k.startsWith('__'))
              .map(([stepId, value]) => (
                <details key={stepId} className="rounded-lg border bg-[var(--surface-2)] p-2.5">
                  <summary className="cursor-pointer text-[11px] font-medium">
                    <code className="font-mono">{`{{steps.${stepId}}}`}</code>
                    <span className="ml-2 font-normal text-[var(--text-muted)]">
                      {value.length} chars
                    </span>
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--text-secondary)]">
                    {value}
                  </pre>
                </details>
              ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle title={`Tasks created by this run (${tasks.length})`} />
        <TaskBoard tasks={tasks} onChanged={run.refresh} />
      </Card>

      <Card>
        <SectionTitle
          title="Data flow"
          hint="Where this run's work is being read from and written to."
        />
        <DataFlowMap active={active ? 'process' : null} counts={{ tasks: tasks.length }} />
      </Card>
    </div>
  );
}
