'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '@/lib/api';
import { useLocalState, usePoll } from '@/lib/hooks';
import { runNeedsAttention } from '@/lib/run-actions';
import { runVisualState } from '@/app/page';
import { AgentAvatar, AgentStateBadge } from '@/components/agents/AgentAvatar';
import { AGENT_STATE, agentIdentity, stepState } from '@/lib/agent-visuals';
import { timeAgo } from '@/lib/format';
import { ErrorNote, Spinner } from '@/components/ui';
import type { WorkflowRun } from '@/lib/types';

/**
 * Missions: every unit of work the workforce has been given.
 *
 * Not a table. Each mission is a strip showing the agents that carried it, in
 * order, with their outcomes — so scanning the list answers "who did what, and
 * did it work" without opening anything. A table of ids and timestamps answers
 * neither.
 *
 * ## Filters that mean something
 * The default view leads with what needs a human, because a paused run that
 * nobody notices is the most expensive state this system has. "Live" and
 * "Finished" are the other two questions people actually arrive with.
 */

type Filter = 'attention' | 'live' | 'all' | 'finished';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'attention', label: 'Needs you' },
  { key: 'live', label: 'In flight' },
  { key: 'finished', label: 'Finished' },
  { key: 'all', label: 'Everything' },
];

const LIVE = new Set(['queued', 'running', 'cancelling']);

export default function MissionsPage() {
  const [projectId, setProjectId] = useLocalState<string>('aiec-project', '');
  const [filter, setFilter] = useState<Filter>('all');

  const scope = projectId || undefined;
  const runs = usePoll((signal) => api.listRuns(scope, signal), { intervalMs: 5000 }, [scope]);
  const projects = usePoll((signal) => api.listProjects(signal), { intervalMs: 30_000 });

  const all = useMemo(() => runs.data?.runs ?? [], [runs.data]);

  const counts = useMemo(
    () => ({
      attention: all.filter(runNeedsAttention).length,
      live: all.filter((r) => LIVE.has(r.status)).length,
      finished: all.filter((r) => ['completed', 'cancelled'].includes(r.status)).length,
      all: all.length,
    }),
    [all],
  );

  const visible = useMemo(() => {
    switch (filter) {
      case 'attention':
        return all.filter(runNeedsAttention);
      case 'live':
        return all.filter((r) => LIVE.has(r.status));
      case 'finished':
        return all.filter((r) => ['completed', 'cancelled'].includes(r.status));
      default:
        return all;
    }
  }, [all, filter]);

  if (runs.loading && !runs.data) return <Spinner label="Loading missions" />;
  if (runs.error && !runs.data) return <ErrorNote message={runs.error} onRetry={runs.refresh} />;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Missions</p>
          <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight">
            Work the team has been given
          </h1>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Every mission is durable — it survives a restart, and can be paused, approved, resumed or
            stopped. Its evidence is recorded by the platform, not described by an agent.
          </p>
        </div>

        {(projects.data?.projects.length ?? 0) > 1 && (
          <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>Repository</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="rounded-lg border px-2 py-1 text-[12px]"
              style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
            >
              <option value="">All</option>
              {projects.data?.projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const count = counts[f.key];
          const active = filter === f.key;
          const urgent = f.key === 'attention' && count > 0;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={active}
              className="relative flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors"
              style={{
                background: active ? 'var(--surface-2)' : 'transparent',
                color: active
                  ? 'var(--text-primary)'
                  : urgent
                    ? 'var(--status-warning)'
                    : 'var(--text-muted)',
                borderColor: urgent
                  ? 'color-mix(in srgb, var(--status-warning) 45%, transparent)'
                  : active
                    ? 'var(--border-strong)'
                    : 'var(--border)',
              }}
            >
              {f.label}
              <span className="hud text-[11px] opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyMissions filter={filter} />
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {visible.map((run) => (
              <motion.li key={run._id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <MissionStrip run={run} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}

/**
 * One mission, as a strip.
 *
 * The agent chain is the point: it shows who carried the work and how each of
 * them ended, using the same silhouettes and state vocabulary as the workspace.
 * A reader who has seen the canvas already knows how to read this.
 */
function MissionStrip({ run }: { run: WorkflowRun }) {
  const state = runVisualState(run);
  const style = AGENT_STATE[state];
  const accent = style.color;
  const changed = run.changeSet?.changedPaths?.length ?? 0;
  const checks = [...new Map((run.changeSet?.checks ?? []).map((check) => [check.command, check])).values()];
  const passed = checks.filter((c) => c.passed).length;

  return (
    <Link
      href={`/runs/${run._id}`}
      className="block rounded-xl border p-3.5 transition-colors hover:border-[var(--border-strong)]"
      style={{
        background: 'var(--surface-1)',
        borderColor: `color-mix(in srgb, ${accent} ${style.intensity === 2 ? 34 : 14}%, var(--border))`,
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <AgentStateBadge state={state} />
            <span className="hud text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {run.workflow}
            </span>
            {run.outcome && run.outcome !== 'delivered' && (
              <span className="text-[11px]" style={{ color: accent }}>
                {run.outcome.replace(/_/g, ' ')}
              </span>
            )}
          </div>
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug">{run.request}</p>
        </div>

        <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {timeAgo(run.createdAt)}
        </span>
      </div>

      {/* The chain of agents, with each one's outcome. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-0.5 gap-y-1.5">
        {run.steps.map((step, index) => {
          const stepVisual = stepState(step.status, {
            runActive: LIVE.has(run.status),
            isNext: false,
            attempt: step.attempt,
          });
          return (
            <span key={step.id} className="flex items-center">
              {index > 0 && (
                <span aria-hidden className="px-1 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  →
                </span>
              )}
              <span title={`${step.name} — ${agentIdentity(step.agentKey).role}, ${AGENT_STATE[stepVisual].label}`}>
                <AgentAvatar
                  agentKey={step.agentKey}
                  state={stepVisual}
                  size={28}
                  showMonogram={false}
                  dimmed={stepVisual === 'idle'}
                />
              </span>
            </span>
          );
        })}

        {/* Evidence, inline. Absence is stated rather than left blank. */}
        <span className="ml-auto flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <span className="hud">{changed} file{changed === 1 ? '' : 's'}</span>
          <span
            className="hud"
            style={{
              color: !checks.length
                ? 'var(--status-warning)'
                : passed === checks.length
                  ? 'var(--status-good)'
                  : 'var(--status-critical)',
            }}
            title={checks.length ? 'Verification commands that exited zero' : 'Nothing was verified'}
          >
            {checks.length ? `${passed}/${checks.length} checks` : 'unverified'}
          </span>
          {run.changeSet?.pullRequest && (
            <span className="hud" style={{ color: 'var(--series-1)' }}>
              PR #{run.changeSet.pullRequest.number}
            </span>
          )}
        </span>
      </div>
    </Link>
  );
}

function EmptyMissions({ filter }: { filter: Filter }) {
  const copy: Record<Filter, { title: string; body: string }> = {
    attention: {
      title: 'Nothing is waiting on you',
      body: 'Missions appear here when a run pauses for approval, is interrupted, or fails.',
    },
    live: {
      title: 'Nothing in flight',
      body: 'Dispatch work from the workspace and it will appear here while it runs.',
    },
    finished: {
      title: 'No finished missions yet',
      body: 'Completed and cancelled runs are kept here with their evidence.',
    },
    all: {
      title: 'No missions yet',
      body: 'The workforce has not been given any work. Start from the workspace.',
    },
  };
  const { title, body } = copy[filter];

  return (
    <div className="rounded-xl border border-dashed p-10 text-center">
      <p className="text-[13px] font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-[12px]" style={{ color: 'var(--text-muted)' }}>
        {body}
      </p>
      <Link
        href="/"
        className="mt-3 inline-block text-[12px] hover:underline"
        style={{ color: 'var(--series-1)' }}
      >
        Go to the workspace →
      </Link>
    </div>
  );
}
