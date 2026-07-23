'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { usePoll, useLocalState } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import { agentColor, agentShort, isActive } from '@/lib/design';
import { Card, EmptyState, ErrorNote, SectionTitle, Select, Spinner, StatusPill } from '@/components/ui';
import { PipelineStrip } from '@/components/viz/WorkflowPipeline';
import { RunLauncher } from '@/components/panels/RunLauncher';

export default function RunsPage() {
  const [projectId, setProjectId] = useLocalState<string>('aiec-project', '');
  const runs = usePoll(() => api.listRuns(projectId || undefined), 4000, [projectId]);
  const projects = usePoll(() => api.listProjects(), 15_000);
  const workflows = usePoll(() => api.listWorkflows(), 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Workflow Runs</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Each run is a durable state machine — it survives a restart and can be paused, approved
            and resumed.
          </p>
        </div>
        <div className="w-56">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {(projects.data?.projects ?? []).map((p) => (
              <option key={p._id} value={p._id}>{p.name}</option>
            ))}
          </Select>
        </div>
      </div>

      {projects.data && workflows.data && (
        <RunLauncher
          projects={projects.data.projects}
          workflows={workflows.data.workflows}
          defaultProjectId={projectId || undefined}
          onStarted={runs.refresh}
        />
      )}

      {workflows.data && (
        <div>
          <SectionTitle
            title="Available workflows"
            hint="Workflows are declarative step graphs — adding one is a data file, not new engine code."
          />
          <div className="grid gap-3 lg:grid-cols-3">
            {workflows.data.workflows.map((w) => (
              <Card key={w.key}>
                <p className="text-xs font-medium">{w.name}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
                  {w.description}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-1">
                  {w.steps.map((s, i) => (
                    <span key={s.id} className="flex items-center gap-1">
                      {i > 0 && <span aria-hidden className="text-[10px] text-[var(--text-muted)]">→</span>}
                      <span
                        className="rounded border px-1 py-0.5 text-[9px] font-bold"
                        style={{ borderColor: agentColor(s.agent), color: agentColor(s.agent) }}
                        title={`${s.name}${s.conditional ? ' — conditional' : ''}${s.optional ? ' — optional' : ''}`}
                      >
                        {agentShort(s.agent)}
                        {s.conditional && <span aria-hidden> ◑</span>}
                      </span>
                    </span>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionTitle title="Run history" />
        {runs.error ? (
          <ErrorNote message={runs.error} onRetry={runs.refresh} />
        ) : !runs.data ? (
          <Card><Spinner /></Card>
        ) : !runs.data.runs.length ? (
          <EmptyState
            title="No runs yet"
            hint="Commission work above. A feature-development run executes up to six agents in sequence."
          />
        ) : (
          <ul className="space-y-2">
            {runs.data.runs.map((r) => {
              const done = r.steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
              return (
                <li key={r._id}>
                  <Link
                    href={`/runs/${r._id}`}
                    className="block rounded-xl border bg-[var(--surface-1)] p-3 transition-colors hover:border-[var(--border-strong)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm font-medium">{r.request}</p>
                        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                          {r.workflow} · started by {r.startedBy} · {timeAgo(r.createdAt)} ·{' '}
                          {done}/{r.steps.length} steps
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {isActive(r.status) && (
                          <span
                            aria-hidden
                            className="h-2 w-2 animate-pulse rounded-full"
                            style={{ background: 'var(--series-1)' }}
                          />
                        )}
                        <StatusPill status={r.status} size="xs" />
                      </div>
                    </div>
                    <div className="mt-2.5"><PipelineStrip run={r} /></div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {r.steps.map((s) => (
                        <span
                          key={s.id}
                          className="text-[9px] font-bold"
                          style={{
                            color: agentColor(s.agentKey),
                            opacity: s.status === 'pending' || s.status === 'skipped' ? 0.35 : 1,
                          }}
                          title={`${s.name}: ${s.status}`}
                        >
                          {agentShort(s.agentKey)}
                        </span>
                      ))}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
