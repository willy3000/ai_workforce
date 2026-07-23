'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import { usePoll, useLocalState } from '@/lib/hooks';
import { isActive } from '@/lib/design';
import { formatNumber, timeAgo } from '@/lib/format';
import { Card, EmptyState, ErrorNote, SectionTitle, Select, Spinner, StatTile, StatusPill } from '@/components/ui';
import { AgentNetwork } from '@/components/viz/AgentNetwork';
import { PipelineStrip } from '@/components/viz/WorkflowPipeline';
import { StatusBreakdown, UsageChart } from '@/components/viz/UsageChart';
import { MessageFeed } from '@/components/panels/MessageFeed';
import { RunLauncher } from '@/components/panels/RunLauncher';

/**
 * Command Center — the "is anything happening, and do I need to act?" screen.
 *
 * Ordered by urgency, not by data model: anything blocked or awaiting approval
 * is the first thing on the page, because it is the only thing that requires a
 * human. Everything below it is situational awareness.
 */
export default function CommandCenter() {
  const [projectId, setProjectId] = useLocalState<string>('aiec-project', '');

  const projects = usePoll(() => api.listProjects(), 10_000);
  const agents = usePoll(() => api.listAgents(), 8_000);
  const workflows = usePoll(() => api.listWorkflows(), 0);
  const runs = usePoll(() => api.listRuns(projectId || undefined), 4000, [projectId]);
  const tasks = usePoll(() => api.listTasks(projectId || undefined), 4000, [projectId]);
  const messages = usePoll(() => api.messages(projectId || undefined), 5000, [projectId]);

  const activeRun = runs.data?.runs.find((r) => isActive(r.status));

  /** Agents currently mid-step — drives the pulse in the org chart. */
  const activeAgents = useMemo(() => {
    if (!activeRun) return [];
    return activeRun.steps.filter((s) => s.status === 'running').map((s) => s.agentKey);
  }, [activeRun]);

  const taskCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks.data?.tasks ?? []) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return counts;
  }, [tasks.data]);

  const needsAttention = useMemo(() => {
    const t = (tasks.data?.tasks ?? []).filter(
      (x) => x.status === 'awaiting_approval' || x.status === 'blocked' || x.status === 'failed',
    );
    const r = (runs.data?.runs ?? []).filter((x) => x.status === 'awaiting_approval' || x.status === 'failed');
    const escalations = (messages.data?.messages ?? []).filter(
      (m) => m.to === 'human' && (m.intent === 'escalation' || m.intent === 'clarification'),
    );
    return { tasks: t, runs: r, escalations };
  }, [tasks.data, runs.data, messages.data]);

  const attentionCount =
    needsAttention.tasks.length + needsAttention.runs.length + needsAttention.escalations.length;

  const totalTokens = (agents.data?.agents ?? []).reduce(
    (sum, a) => sum + a.stats.inputTokens + a.stats.outputTokens,
    0,
  );
  const totalRuns = (agents.data?.agents ?? []).reduce((sum, a) => sum + a.stats.runs, 0);

  if (projects.error) {
    return <ErrorNote message={projects.error} onRetry={projects.refresh} />;
  }

  return (
    <div className="space-y-5">
      {/* Header + project scope */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Command Center</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Your autonomous engineering organization, live.
          </p>
        </div>
        <div className="w-56">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {(projects.data?.projects ?? []).map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* Anything needing a human comes first. */}
      {attentionCount > 0 && (
        <Card className="border-l-2" >
          <SectionTitle
            title={`${attentionCount} item${attentionCount === 1 ? '' : 's'} need you`}
            hint="The organization pauses rather than guessing when it hits your authority boundary."
          />
          <ul className="space-y-1.5">
            {needsAttention.runs.map((r) => (
              <li key={r._id} className="flex items-center justify-between gap-3 text-xs">
                <Link href={`/runs/${r._id}`} className="min-w-0 flex-1 truncate hover:underline">
                  <span className="text-[var(--text-muted)]">{r.workflow}</span> — {r.request}
                </Link>
                <StatusPill status={r.status} size="xs" />
              </li>
            ))}
            {needsAttention.tasks.slice(0, 5).map((t) => (
              <li key={t._id} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <StatusPill status={t.status} size="xs" />
              </li>
            ))}
            {needsAttention.escalations.slice(0, 3).map((m) => (
              <li key={m._id} className="flex items-start gap-2 text-xs">
                <span aria-hidden style={{ color: 'var(--status-critical)' }}>⚑</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{m.from}</span> —{' '}
                  <span className="text-[var(--text-secondary)]">{m.message.slice(0, 160)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Vitals */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Projects connected"
          value={projects.data?.count ?? '—'}
          sub={`${(projects.data?.projects ?? []).filter((p) => p.status === 'ready').length} ready`}
          glyph="▤"
        />
        <StatTile
          label="Agent runs"
          value={totalRuns}
          sub={`${formatNumber(totalTokens)} tokens processed`}
          glyph="⬡"
        />
        <StatTile
          label="Tasks"
          value={tasks.data?.count ?? '—'}
          sub={`${taskCounts.done ?? 0} done · ${taskCounts.in_progress ?? 0} running`}
          glyph="▦"
        />
        <StatTile
          label="Workflow runs"
          value={runs.data?.count ?? '—'}
          sub={activeRun ? 'One running now' : 'Idle'}
          accent={activeRun ? 'var(--series-1)' : undefined}
          glyph="⟳"
        />
      </div>

      {/* Commission work */}
      <div>
        <SectionTitle
          title="Commission work"
          hint="Describe what you want in plain language. The Project Manager breaks it down; the rest of the org executes it."
        />
        {projects.data && workflows.data ? (
          <RunLauncher
            projects={projects.data.projects}
            workflows={workflows.data.workflows}
            defaultProjectId={projectId || undefined}
            onStarted={runs.refresh}
          />
        ) : (
          <Card><Spinner /></Card>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.15fr_1fr]">
        {/* Org chart */}
        <Card>
          <SectionTitle
            title="The organization"
            hint={
              activeAgents.length
                ? `${activeAgents.join(', ')} working now — animated edges show live data flow`
                : 'Hover a role to isolate its connections'
            }
            right={<Link href="/org" className="text-[11px] text-[var(--series-1)] hover:underline">Details →</Link>}
          />
          {agents.data ? (
            <AgentNetwork agents={agents.data.agents} activeAgents={activeAgents} />
          ) : (
            <div className="skeleton h-80 rounded-lg" />
          )}
        </Card>

        <div className="space-y-5">
          {/* Active / recent runs */}
          <Card>
            <SectionTitle
              title="Workflow runs"
              right={<Link href="/runs" className="text-[11px] text-[var(--series-1)] hover:underline">All →</Link>}
            />
            {!runs.data ? (
              <div className="skeleton h-24 rounded-lg" />
            ) : !runs.data.runs.length ? (
              <EmptyState title="No runs yet" hint="Commission work above to start one." />
            ) : (
              <ul className="space-y-2.5">
                {runs.data.runs.slice(0, 5).map((r) => (
                  <li key={r._id}>
                    <Link href={`/runs/${r._id}`} className="block rounded-lg border p-2.5 hover:border-[var(--border-strong)]">
                      <div className="flex items-start justify-between gap-2">
                        <p className="line-clamp-1 text-xs font-medium">{r.request}</p>
                        <StatusPill status={r.status} size="xs" />
                      </div>
                      <p className="mb-1.5 mt-0.5 text-[10px] text-[var(--text-muted)]">
                        {r.workflow} · {timeAgo(r.createdAt)}
                      </p>
                      <PipelineStrip run={r} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Task distribution */}
          <Card>
            <SectionTitle title="Task pipeline" />
            {Object.keys(taskCounts).length ? (
              <StatusBreakdown counts={taskCounts} />
            ) : (
              <p className="text-xs text-[var(--text-muted)]">No tasks yet.</p>
            )}
          </Card>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <SectionTitle
            title="Agent workload"
            hint="Token spend per role. Cost is an estimate at list pricing."
          />
          {agents.data ? <UsageChart agents={agents.data.agents} /> : <div className="skeleton h-40 rounded-lg" />}
        </Card>

        <Card>
          <SectionTitle
            title="Message bus"
            hint="Agents talking to each other — persisted, addressed, auditable."
          />
          {messages.data ? (
            <MessageFeed messages={messages.data.messages} limit={12} />
          ) : (
            <div className="skeleton h-40 rounded-lg" />
          )}
        </Card>
      </div>
    </div>
  );
}
